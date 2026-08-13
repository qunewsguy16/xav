# Self-improving TQ first-guess prediction

Goal: cut wall-clock time in target-quality mode by making the *first* CRF guess
content-aware, and improving it over time from the encodes you have already run.

The final output must be bit-for-bit what it would have been anyway. The
predictor changes only where the search starts, never where it ends.

---

## 1. What the search does today (measured, not assumed)

`src/enc.rs:697`:

```rust
fn tq_search_crf(tq: &mut TQState, encoder: Encoder) -> f32 {
    tq.round += 1;
    let c = if tq.round <= 2 {
        bisect(tq.search_min, tq.search_max)      // <- content-blind
    } else {
        interpolate_crf(&tq.probes, tq.target, tq.round)
    }
    .clamp(tq.search_min, tq.search_max);
    ...
}
```

`bisect` (`src/interp/avx2.rs:36`) is a plain midpoint. So:

| Round | Source of the CRF | Content-aware? |
|---|---|---|
| 1 | midpoint of `--qp` range — **CRF 28.0** for the default `8.0-48.0` | **no** |
| 2 | midpoint of the bracket narrowed by round 1 | **no** |
| 3 | `pchip` over observed `(score, crf)` | yes |
| 4 | `lerp` | yes |
| 5+ | `fc_spline` | yes |

**Every chunk of every video starts at CRF 28**, whether it is a static
title card or a confetti explosion, and whether the target is Butteraugli 4 or
CVVDP 9.5. Rounds 1–2 are pure bracketing; they exist to bootstrap the
interpolator, and they cost a full chunk encode plus a full GPU metric pass
each.

That is the entire opportunity: **rounds 1–2 are the only part of the search
with no information in it**, and they are typically 40–60 % of TQ's cost.

### 1.1 The training data already exists

`write_chnk_log` (`src/enc.rs:1296`) appends one line per chunk to
`<workdir>/chunks.json`:

```json
{"id":42,"r":4,"f":240,"p":[[28.00,7.9012,131072],[38.00,9.1420,54219],...],
 "fc":34.25,"fs":8.5031,"fz":78311}
```

Every probe, its CRF, its achieved score and its encoded size — plus the final
answer. This is a complete, already-persisted supervised training set: features
are recoverable per chunk, and the label is `fc` (the CRF that hit the target).
**No new instrumentation is needed to start collecting data.** Nothing has to be
built before you can begin accumulating it — every TQ encode you run from now
on is a labelled example.

### 1.2 Success is already measurable

`src/enc.rs:1385` computes and prints `average_probes` plus a per-round
histogram (`"rounds": {"1": {...}, "2": {...}}`). So the metric that matters —
mean probes per chunk — is emitted today with no extra work, and an A/B is a
matter of running the same clip twice.

---

## 2. Design

Two tiers. They are independent: tier 1 is worth doing on its own, needs no
persistence, and has no cold-start problem.

### 2.1 Tier 1 — within-video adaptation

> **Correction.** An earlier draft of this section described the within-video
> problem as easy on the grounds that "the only thing varying between chunks is
> content", and claimed it "cannot suffer distribution shift because the
> training and prediction sets are the same video". Both statements were wrong
> in a way that matters. Within-video content variance is not a simplification —
> it is the entire problem. A single per-video CRF seed would be badly wrong at
> both tails: end credits and static title cards are trivially compressible and
> converge at very high CRF, while high-motion or grain-heavy scenes converge
> far lower. And a video *can* suffer covariate shift internally — credits
> arrive at the end, after a model fitted entirely on action.

#### Why the spread is structural, not incidental

`chnkify` (`chunk.rs:117`) maps scenes to chunks **one-to-one**, and
`val_scenes` (`chunk.rs:100`) rejects any scene longer than 300 frames. So a
chunk *is* a scene. Chunks are content-homogeneous internally **by design**, and
therefore content-*heterogeneous* between each other by the same design — a
chunk boundary exists exactly where the content changed enough for the scene
detector to cut.

Two consequences:

- **Any "neighbouring chunks are similar" heuristic is wrong here.** Chunk index
  proximity carries almost no information about content proximity. Temporal
  smoothing over chunk index is not a valid shortcut.
- **What transfers within a video is the mapping, not the answer.** Scenes from
  one source do share grain characteristics, source encoder and efficiency,
  resolution and production style. That shared structure lives in the
  *relationship* between complexity and CRF, not in the CRF value.

#### The right decomposition

Two separable wins, with different risk profiles. Worth keeping them separate
because the first is nearly free and the second is where the difficulty is.

**(a) Recentering — cheap, low risk, helps every chunk.** CRF 28 is the midpoint
of an arbitrary user-supplied range; it has no relationship to the target metric,
the encoder or the source. Even the *median* converged CRF for the video so far
is a better centre than 28. If a video's chunks land in 30–45, seeding at 37
beats seeding at 28 for every chunk, credits and action alike. This is the part
that survives your objection intact.

**(b) Conditioning — where the credits-vs-action spread is addressed.** Fit

```
crf ≈ a + b·log2(chunk_complexity)
```

with `a`, `b` learned per-video and complexity measured per-chunk. The
per-video terms absorb grain, source efficiency and style; the per-chunk feature
separates credits (low complexity → high CRF) from action (high complexity →
low CRF). **The seed must be per-chunk conditional. A per-video constant is not
an acceptable simplification.**

Source bits-per-pixel for the chunk is the natural first feature and is free —
it is a direct measurement of how many bits the *previous* encoder spent on this
exact content. It separates credits from action about as cleanly as anything
could.

#### Bracket sizing

The earlier draft said to narrow the initial bracket around the fitted value.
That is the part of this most likely to backfire, and your objection is why:
**a bracket narrowed around a seed that is wrong for an outlier chunk excludes
the true answer**, forcing clamping or extrapolation and costing more rounds
than blind bisection would have — on precisely the expensive chunks.

So: size the bracket from the *observed residual spread* of the per-video fit,
not from a fixed constant, and never narrow below the range that has actually
contained converged answers so far. A video with a wide CRF spread should
automatically keep a wide bracket. When in doubt, do not narrow at all — seed
the first probe and leave the bracket alone. Seeding is where the win is;
narrowing is a second-order optimisation with a much worse failure mode.

### 2.2 Tier 2 — cross-video model (the "self-improving" part)

Persist what tier 1 learns, so video *n+1* starts where video *n* finished.

**Key.** A model entry is only valid for a matching context. Key on:

```
encoder + encoder version + params hash + metric type + target + tolerance
        + resolution bucket + bit depth
```

Encoder version matters and is easy to get wrong: `Encoder::version()`
(`src/encoder.rs:76`) already reports the SVT-AV1 build, and the three supported
forks (`hdr`, `essential`, `mainline`) have materially different CRF↔quality
mappings. A model trained on one fork applied to another would be worse than
bisection. **Key on it, and treat a key miss as "no model" rather than "nearest
model".**

**Features** — all must be available *before* the chunk is encoded, and cheap:

| Feature | Source | Cost |
|---|---|---|
| source bits-per-pixel for the chunk | chunk byte range / (frames × w × h), from demux | free |
| frame count | `WorkPkg.frame_cnt` | free |
| scene-detect cost for the chunk | `src/scd/` already computes per-frame costs | free if retained |
| spatial energy (luma variance / gradient) | `crop/` already computes row/col stats on sampled frames | near-free |
| temporal energy (mean SAD) | SCD already computes this to find cuts | free if retained |
| resolution, bit depth, target | args | free |

Source bits-per-pixel is expected to be the single strongest predictor and is
completely free — it is a direct measurement of how many bits the *previous*
encoder thought this content needed. Start there and add features only if
measurement says they help.

**Model.** Deliberately small and inspectable:

1. Bucket by key.
2. Within a bucket, fit `crf ≈ a + b·log2(source_bpp) + c·log2(spatial_energy)`
   by ridge regression, updated online (recursive least squares — one small
   matrix per bucket, no training loop, no epochs).
3. Blend the bucket estimate with a coarser global prior, weighted by sample
   count, so a bucket with 3 samples leans on the prior and a bucket with 500
   does not.
4. Track residual variance per bucket. That is what sizes the initial bracket
   and what gates whether the prediction is used at all.

Ridge over log-features is the right starting point because the CRF↔rate
relationship is close to log-linear over the range that matters, the model is
~200 lines with no dependencies, it updates in O(d²) per sample, and — crucially
— you can read the coefficients and tell whether it has learned something
sensible. A k-NN variant is a reasonable alternative if residuals turn out
strongly non-linear; gradient-boosted trees would fit better still but need a
real ML library and turn the model into something you cannot eyeball. Since you
said ethos is not a constraint here, that door stays open — but only after the
simple version is measured, because the simple version may well be enough.

**Storage.** `%APPDATA%\xav\tq_model.json` on Windows,
`$XDG_DATA_HOME/xav/tq_model.json` elsewhere. Plain text and human-readable, so
a bad model can be inspected and deleted rather than being an opaque blob.
Include a schema version; refuse to load a model whose schema or feature set
does not match the running binary.

---

## 3. Safety

The predictor must not be able to make output worse, and must not be able to
make the search *slower* than blind bisection by much.

1. **Output is unaffected by construction.** The existing convergence check
   still decides when a chunk is done. A wrong prediction costs probes, never
   quality.
2. **Bracket preservation.** `interpolate_crf` needs points on both sides of the
   target to interpolate rather than extrapolate. If round 1 is a good
   prediction, round 2 must deliberately probe on the *opposite* side of the
   target from round 1's result. Getting this wrong is the most likely way to
   make the predictor a net loss — it would convert interpolation into
   extrapolation and cost rounds on exactly the chunks the prediction got right.
3. **Confidence gate — per chunk, not per bucket.** A bucket-level sample count
   is not sufficient. The gate must also check that *this chunk's features* fall
   inside the region the fit has actually seen. The concrete failure case is the
   one that motivated the §2.1 rewrite: an action film's credits arrive at the
   very end, so the fit has seen nothing but high-complexity scenes and the
   credits chunk sits far outside the fitted range. Extrapolating a log-linear
   fit that far out is worse than bisecting. So: gate on feature-space distance
   from the observed range, and fall back to bisection for outliers rather than
   extrapolating.
4. **Judge on residuals, not fit quality.** A high R² over a video whose chunks
   span 20 CRF can still mean ±5 CRF errors at the tails. The metric that
   matters is the residual distribution — particularly its tails — not the
   aggregate fit.
5. **Clamp** into `[qp_min, qp_max]`, with a margin from the edges.
6. **Poisoning.** Only feed the model chunks that actually converged in range.
   `write_chnk_log` records `in_range`/`out_range`; out-of-range chunks are
   exactly the ones whose `fc` is not a valid label.

---

## 4. Rollout

The mode flag is what makes this safe to adopt:

```
--tq-predict off      # today's behaviour; the default until measured
--tq-predict shadow   # predict, log the prediction and the true answer, but
                      # still bisect. Zero risk, full accuracy data.
--tq-predict on       # act on the prediction
```

**Shadow mode is the whole rollout strategy.** It lets the model be evaluated on
real encodes with zero risk to speed or output, and it accumulates training data
at the same time. Ship shadow first, run it for a while, look at the residuals,
and only then decide whether `on` is justified.

Acceptance: on a fixed corpus, `average_probes` drops meaningfully with no
increase in `out_range`, and total wall time drops. Both numbers already exist
in the stats output.

---

## 5. Honest assessment

- **Tier 1(a), recentering, is high-confidence.** Replacing an arbitrary range
  midpoint with the video's own observed centre is strictly better information,
  and it helps every chunk regardless of content.
- **Tier 1(b), conditioning, is the real work and is not yet proven.** It stands
  or falls on whether a cheap pre-encode feature actually separates the credits
  case from the action case well enough. It might; source bits-per-pixel is a
  strong signal. But that is a hypothesis to measure, not an assumption to build
  on — see step 1 of §6.
- **Chunks are scenes, so within-video content variance is large by
  construction** (`chnkify` is 1:1, scenes capped at 300 frames). Do not expect
  chunk-index locality to help.
- **Tier 2 is plausible but unproven.** The gain depends on how much of the
  variance is captured by cheap pre-encode features. Source bits-per-pixel is a
  genuinely strong signal, but source encoders vary wildly in efficiency, so a
  BD-Rate-efficient HEVC source and a bloated one at the same bitrate carry
  different information. Shadow mode exists precisely so this gets measured
  rather than argued about.
- **The bracket-preservation point in §3.2 is the one that would quietly ruin
  this** if implemented carelessly. It deserves the most care in review.
- Do not expect this to help chunks that are already converging in 2 rounds;
  the win concentrates on the tail of hard chunks, which is also where most of
  the wall time is.

---

## 6. Suggested order of work

**Step 0 settles the design question rather than arguing it.** Any `chunks.json`
from a completed TQ encode already contains the per-chunk converged CRF (`fc`)
for a whole video. Plot that distribution before writing any code:

- If the within-video spread is a couple of CRF, recentering alone captures most
  of the win and conditioning is barely worth building.
- If it is ±8 or more — which is what the credits-vs-action argument predicts —
  then a per-video constant is useless, conditioning is mandatory, and the
  feature set has to be good enough to explain that spread before any of this is
  worth shipping.

That single plot is the cheapest decision point in the whole design, and it
needs no new code. Then:

1. Extract a feature vector per chunk and log it alongside the existing probe
   record. **Costs almost nothing and starts accumulating data immediately** —
   worth doing before anything else, even if the rest is deferred.
2. Offline: regress `fc` on those features *within* single videos. The question
   is specifically whether the features explain the credits-vs-action spread —
   check the residuals at the tails, not the aggregate fit. This is the decision
   point for both tier 1(b) and tier 2.
3. Tier 1(a) recentering, behind `--tq-predict`. Low risk, ship first.
4. Tier 1(b) conditioning, only if step 2 supports it.
5. Persistence + bucketed ridge model (tier 2), shadow mode first.
6. Measure on a fixed corpus; enable by default only if the numbers justify it.
