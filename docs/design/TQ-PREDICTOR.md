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

### 2.1 Tier 1 — within-video adaptation (cheap, large win, no ML)

Inside a single encode, the encoder, preset, parameters, target metric, target
value, resolution and bit depth are **all constant**. The only thing varying
between chunks is content. So after the first handful of chunks resolve, you
already have several `(content_feature, final_crf)` pairs drawn from exactly the
distribution you are predicting into.

- Let the first `K` chunks (K ≈ 4–8, or "until the spread is stable") run the
  existing blind bisection.
- Thereafter, fit a 1-D or 2-D relation over completed chunks and seed round 1
  from it, rather than from the range midpoint.
- Narrow the initial bracket to the fitted value ± a margin derived from the
  observed residual spread — not a fixed constant, so a heterogeneous video
  automatically keeps a wide bracket.

This alone should remove roughly one probe per chunk on typical content, and it
cannot suffer distribution shift because the training and prediction sets are
the same video. It is also the natural place to start, because it validates the
feature set before any persistence exists.

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
3. **Confidence gate.** Use the prediction only when the bucket has ≥ N samples
   and residual variance is below a threshold. Otherwise fall back to bisection.
4. **Clamp** into `[qp_min, qp_max]`, with a margin from the edges.
5. **Poisoning.** Only feed the model chunks that actually converged in range.
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

- **Tier 1 is high-confidence.** Within-video, encoder and target are fixed and
  content is correlated across chunks. Removing ~1 probe per chunk is a realistic
  expectation, and the risk is low.
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

1. Extract a feature vector per chunk and log it alongside the existing probe
   record. **Costs almost nothing and starts accumulating data immediately** —
   worth doing before anything else, even if the rest is deferred.
2. Offline analysis of the resulting data to check the features actually
   correlate with `fc`. This is the decision point for tier 2.
3. Tier 1 within-video adaptation, behind `--tq-predict`.
4. Persistence + bucketed ridge model (tier 2), shadow mode first.
5. Measure on a fixed corpus; enable by default only if the numbers justify it.
