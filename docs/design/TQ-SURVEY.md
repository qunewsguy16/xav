# TQ optimisation: a survey from several angles

A read of the whole target-quality path looking for wins, sorted by whether
they need any learning at all. Everything here is grounded in the code; where
something is a hypothesis rather than a finding, it says so.

Companion to `TQ-PREDICTOR.md`, which covers the learned-prediction design in
depth. This document is the wider sweep.

---

## 0. How the search actually works

Per chunk, in `tq_enc_loop` / `tq_search_crf` / `TQCtx` (`src/enc.rs`):

```
round 1 :  crf = bisect(qp_min, qp_max)              -- midpoint, content-blind
round 2 :  crf = bisect(narrowed bracket)            -- midpoint, content-blind
round 3 :  crf = pchip     over (score, crf) probes
round 4 :  crf = lerp      over (score, crf) probes
round 5+:  crf = fc_spline over (score, crf) probes
```

`bisect` (`asm/avx2/interp/bs.asm`) is `(min+max)/2` quantised to 0.25.

After each probe:

```rust
should_complete = converged(score)                       // |score-target| <= tol
               || any previous probe non-monotonic       // metric misbehaving
               || up_bounds(state, score)                // bracket collapsed
```

`up_bounds` moves the bracket to `last_crf ∓ 0.25`. On completion, `best_probe`
picks the probe with the smallest `|score - target|`.

**Two things are already well done and should not be "fixed":**

- **The converged probe's bitstream is the output.** `complete_chnk` is handed
  `probe_path(...best.crf...)` directly — there is no wasteful final re-encode.
  (Only `--alt-param` triggers a separate final encode, which is why it is
  marked expert-only.)
- **Probe sizes are already recorded** (`probe_szs`), so a rate curve is being
  collected alongside the quality curve. See §2.1 — it is not yet used.

---

## 1. Wins that need no learning at all

### 1.1 Butteraugli's monotonicity guard is inverted — **fixed in this branch**

`TQCtx` establishes a polarity convention in three independent places:

| Evidence | Implication |
|---|---|
| `resolve_metric` (`pipeline.rs:270`) returns `use_butter` into the `sort_descending` slot | — |
| `aggregate_scores` with `sort_descending` sorts **descending** and averages the first N%, i.e. percentile mode targets the worst frames | higher Butteraugli = worse |
| `up_bounds` (`enc.rs:396`): for butter, `score > target + tol` lowers `search_max` | higher Butteraugli = worse = need lower CRF |

So Butteraugli **rises** with CRF; SSIMU2/CVVDP **fall** with it. But the guard
was polarity-blind:

```rust
probes.iter().any(|p| (p.crf - crf) * (p.score - score) >= 0.0)
```

Trace round 2 for Butteraugli, either direction:

- Round-1 score too high → `search_max = 27.75` → `C2 < 28`.
  `(28 - C2) > 0`; lower CRF → less distortion → `(S1 - S2) > 0`; product > 0 → **bail**.
- Round-1 score too low → `search_min = 28.25` → `C2 > 28`.
  `(28 - C2) < 0`; higher CRF → more distortion → `(S1 - S2) < 0`; product > 0 → **bail**.

Both directions bail on the *normal, healthy* monotonic case. **Butteraugli TQ
therefore terminated after exactly two probes**, always, unless round 1 happened
to converge — then took whichever of the two bisection points was closer. That
is not a search; it is two guesses and a coin flip.

Note this is a **quality** bug, not a speed bug, and it presents as the
opposite of a problem: Butteraugli targets look like they converge unusually
fast. The tell is the `out_range` counter in the stats output.

The argument needs no knowledge of Vship's semantics — the guard simply
contradicts `up_bounds` in the same `impl` block. Fixed by moving the polarity
decision into a `TQCtx::nonmonotonic` method beside `up_bounds`, so there is
one place that knows which way the metric points.

**Needs runtime validation**: run a Butteraugli target (`-t` below 8) before and
after and compare `average_probes`, `out_range` and the round histogram.
Expect probes to *rise* and `out_range` to *fall* — this fix trades speed for
correctness, which is the right trade but should be seen in the numbers.

### 1.2 Round 2 discards the magnitude of round 1's error

This is the largest algorithmic inefficiency, independent of any model.

Round 1 measures a score. That measurement contains *how far off* the guess was.
Bisection uses only the **sign**.

Concrete trace, SSIMU2 target 80, default `--qp 8.0-48.0`:

```
round 1: crf 28  -> score 78   (2 points low)
up_bounds        -> search_max = 27.75
round 2: bisect(8, 27.75) = 17.9 -> 18.0
```

The answer is near CRF 26, and the search jumps to 18. It would jump to exactly
the same place if round 1 had scored 40 instead of 78. A secant step using any
reasonable slope estimate — say −0.8 score per CRF — would go to
`28 - 2/0.8 = 25.5`, which is close enough that round 3 could converge.

**Even a hardcoded per-metric slope prior beats bisection here**, because
bisection's implicit prior is "infinite slope". A learned slope is better again,
and §3.1 argues the slope is the *right* thing to learn.

Care needed: a secant step can overshoot outside the bracket when the round-1
score is far off, so clamp to the bracket and keep bisection as the fallback
when the implied step is absurd. Regula falsi or Brent's method are the
textbook forms of exactly this.

### 1.3 `best_probe` is sign-blind

```rust
probes.iter().min_by(|a, b| (a.score - target).abs().total_cmp(...))
```

A probe that is 0.4 *below* target quality beats one 0.5 *above* it. But the two
errors are not equivalent: overshooting quality costs bitrate, undershooting
costs quality that cannot be recovered. For an archival encode most people
would take the slightly-too-good probe every time.

Cheap fix: a tie-break, or an explicit asymmetric preference
(`--tq-bias quality|size|nearest`), defaulting to today's behaviour so nothing
changes silently. Costs no extra probes — it only changes which already-encoded
probe is selected.

### 1.4 `converged` has a no-op branch

```rust
if self.use_butter { (self.target - score).abs() <= self.tolerance }
else               { (score - self.target).abs() <= self.tolerance }
```

Both arms compute the same value. Harmless, but the fact that someone felt the
need to branch on polarity here — and got it right in `up_bounds`, wrong in the
monotonicity guard, and vacuous here — suggests the polarity convention deserves
to be stated once, explicitly, rather than rediscovered at each site. §1.1's
`nonmonotonic` method is a start.

### 1.5 Nothing schedules the expensive chunks first

Chunks are dispatched in index order. TQ cost per chunk varies by several
multiples depending on how many probes it needs, so the makespan is set by
whichever slow chunk happens to start last. Classic longest-processing-time-first
scheduling would cut the tail for free — *if* expected cost can be estimated
ahead of time, which is exactly what a predictor provides. A cheap proxy
available with no model at all: chunk frame count × source bits-per-pixel.

---

## 2. Data already computed and then dropped

### 2.1 The rate curve (`probe_szs`) — the most under-used signal

Every probe already records its encoded size, and `ProbeLog` writes it to
`chunks.json`. So each chunk yields *two* curves: CRF→score and CRF→size.

Why this matters: **size is far cheaper to predict than quality, and the two are
tightly coupled.** Predicting the encoded size of a chunk at a given CRF is close
to a solved problem from source bitrate and resolution; the quality at that size
is much better behaved than quality at a given CRF, because it factors out
content complexity. A model in `(bits-per-pixel → score)` space should
generalise across content far better than one in `(crf → score)` space — which
is another way of saying it should survive the credits-vs-action objection.

Nothing currently reads `probe_szs` back for anything but logging.

### 2.2 Per-frame scores are computed, aggregated, and discarded

`calc_metric` returns `Vec<f32>` of every frame's score, stored in
`Probe.frame_scores`, then only `aggregate_scores` consumes it. The
*distribution* is signal:

- Its spread says whether the chunk is homogeneous. A chunk with a tight score
  distribution will respond predictably to a CRF change; one with a bimodal
  distribution (e.g. a scene cut the detector missed) will not.
- In percentile mode the aggregate is driven by the tail, so tail shape predicts
  how the aggregate moves with CRF — i.e. it predicts the **local slope**, which
  §1.2 and §3.1 both want.
- A pathological distribution is an early warning that this chunk will be
  expensive, feeding §1.5's scheduling.

### 2.3 Source per-packet sizes are reachable but not retained

`vid_bytes` (`ffms.rs:840`) already walks the container's packets. Per-chunk
source bytes — hence source bits-per-pixel per chunk — would fall out of a pass
that already happens, and it is the single most promising cheap complexity
feature (it is a direct measurement of what the previous encoder thought this
content cost). Currently only a whole-file total is computed.

### 2.4 Scene-detect costs are computed then thrown away

`Scene` carries only `{s_frame, e_frame, params}`. The SCD pass computes
per-frame costs to find cuts (`asm/*/scd/cost.asm`, `xav_scd_feed`) and
discards them. Retaining a per-scene summary (mean/peak cost) is nearly free and
gives a temporal-complexity feature that source bitrate does not capture —
notably it separates "high bitrate because grainy" from "high bitrate because
fast motion", which plausibly have different CRF responses.

### 2.5 Crop statistics

`detect_crop` computes row/column luma statistics on sampled frames. Spatial
energy is a by-product. Lower value than the above, but free.

---

## 3. Learning angles, ranked

### 3.1 Learn the slope, not the answer — the key reframe

Your objection to the earlier draft was that converged CRFs vary hugely within a
video (credits vs action). That is right, and it kills a learned *intercept*.
It does **not** kill a learned *slope*.

`dScore/dCRF` is a property of the metric and the encoder far more than of the
content. Credits and action land at very different CRFs, but the local rate of
change of SSIMU2 per CRF step is much more stable between them than the CRF
itself is. And the slope is exactly what §1.2 needs to convert round 2 from a
blind bisection into an informed secant step.

This is a better target than the intercept in every way that matters:

- It transfers across chunks *within* a video despite content variance.
- It transfers across videos more readily than an absolute CRF.
- Being wrong about it is cheap — a bad slope gives a bad round-2 guess, which
  is no worse than the bisection it replaced, whereas a bad intercept can send
  round 1 outside a sensible bracket.
- It needs no persistence to start helping: round 1 of chunk *n* plus round 1 of
  chunk *n-1* already give a crude slope.

**If only one thing from this document gets built, build this.**

### 3.2 Work in bits-per-pixel space, not CRF space

Per §2.1. Learn `score = f(bits_per_pixel)` and separately `bits_per_pixel =
g(crf, content)`. The first should be close to content-independent — that is
roughly what a perceptual metric *is* — and the second is a rate model, which is
much easier than a quality model. This decomposition is the standard way this
problem is handled elsewhere and is likely stronger than regressing CRF
directly.

Hypothesis, not a finding. Testable offline from existing `chunks.json` files,
since they contain `(crf, score, size)` triples.

### 3.3 Preset transfer would make probing much cheaper

`--alt-param` already exists to probe with different (faster) encoder settings,
and the guide marks it "NOT RECOMMENDED; expert-only" — correctly, because the
CRF↔quality mapping shifts with preset, so a CRF converged at a fast preset does
not transfer to the slow one.

But that shift is a *learnable offset*, and it is much better behaved than the
content problem: it depends on the encoder and the two presets, not on the
video. Learn the mapping once, probe at a fast preset, correct, and encode the
final at the slow preset. That converts every probe from full cost to a
fraction.

The catch: with `--alt-param` the converged probe is no longer reusable as
output (that is why `use_alt_param` forces a separate final encode), so this
trades N cheap probes plus one full encode against N full probes. Whether that
wins depends on the preset speed ratio and the probe count — for a chunk needing
5 probes at preset 2, probing at preset 6 would be a large net win; for a chunk
converging in 2, it would be a loss. Which argues for deciding per chunk using
a predicted probe count (§1.5, §3.1).

Highest ceiling of anything here, and the highest risk. Would need careful
measurement before being trusted.

### 3.4 Cross-video persistence

Covered in `TQ-PREDICTOR.md`. Worth noting it is now clearly *fourth* in
priority: §1.1 is a bug fix, §1.2 is free, §3.1 needs no persistence, and all
three should land before anything writes a model file.

---

## 4. Cheaper probes

- **Subsample frames for bracketing rounds.** Metric cost scales linearly with
  frame count. Rounds 1–2 only need to bracket, not to be accurate. Metric on
  every Nth frame would cut that cost by ~N, with the accepted probe verified at
  full frame count. Caveat: in percentile mode the aggregate depends on the tail
  of the distribution, so subsampling biases it — the correction is either
  restricting this to mean mode, or estimating the percentile from the subsample
  with a wider tolerance. Also worth measuring how much of a probe's wall time
  is metric versus encode before doing any of this; Vship is GPU and fast, so
  encode may well dominate and this may not be worth it. **Measure first.**
- **Don't re-probe a CRF already probed.** The monotonicity guard catches
  duplicates by accident (product exactly zero → bail), which is a blunt
  response. Explicitly skipping and nudging would be better than terminating.

---

## 5. Suggested order

1. **§1.1 Butteraugli guard** — done here, needs runtime validation.
2. **§1.2 secant round 2**, with a hardcoded per-metric slope prior. No
   learning, no persistence, largest single speed win.
3. **§2.3 per-chunk source bytes** + **§2.4 SCD cost retention** — cheap, and
   every later idea needs them.
4. **§3.1 learned slope**, within-video first.
5. **§1.3 `--tq-bias`** and **§1.5 scheduling** — small, independent.
6. **§3.2 bits-per-pixel space** — validate offline against existing
   `chunks.json` before building.
7. **§3.3 preset transfer** — highest ceiling, do last, measure hard.
8. Cross-video persistence (`TQ-PREDICTOR.md`).

Steps 1–3 need no model, no persistence and no new dependencies.
