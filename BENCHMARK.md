# BENCHMARK.md — Pre-registered evaluation protocol

**Status: PRE-REGISTERED. Frozen as of T0 (repo scaffold, 2026-07-02).**

This file is committed **before the first benchmark run** (build plan §18.1, §24 T0). It
defines arms, metrics, matching rules, and thresholds up front so the product's core claim
— *"beats a single strong model"* — is falsifiable by design. Thresholds below are **not
renegotiable after seeing data** (§23).

Any change to this file after a bench run has been executed is a protocol violation and must
be recorded, with justification, in `RESULTS.md`.

---

## 1. Arms (§17)

Four fixed arms are run on every task set:

| Arm | Description |
|-----|-------------|
| **A** | Single best model (claude), plain prompt (e.g. "review this diff" / "evaluate this idea"). |
| **B** | Single best model (claude), strong structured adversarial prompt (analyze → self-attack → re-answer, schema-forced). **B is the real opponent.** Beating A is trivial and proves nothing. |
| **C** | Same model sampled 3× + aiki's own synthesis stages (S6–S9). Isolates synthesis value from vendor diversity. |
| **D** | Full cross-provider pipeline (the product). |

## 2. Metrics per workflow (§17)

Every reported number is labelled **objective / semi-objective / subjective**. Subjective
results count only under the blind protocol (§4).

| Workflow | Objective | Semi-objective | Subjective |
|----------|-----------|----------------|------------|
| **code-review** | seeded-bug recall; precision via adjudicated FP labelling; F1; calls, wall-clock | — | — |
| **idea-refinement** | misunderstanding-catch rate on deliberately ambiguous inputs | assumption-coverage vs pre-written 12-item checklist | blind pairwise preference (≥3 raters, position-randomized, provider-stripped) |

**Primary metric (fixed, no metric shopping — §18.4):**

- **code-review → seeded-bug recall.** This is the metric all kill criteria attach to.
- **idea-refinement → does NOT carry the "beats one model" claim.** Reported for coverage and
  misread-catch only; its claim is *structured decomposition + surfaced disagreement*, not
  "better answer."

Secondary metrics are reported but **cannot rescue a failed primary** (§18.4).

## 3. Matching rules — seeded-bug recall (code-review)

A seeded bug counts as **found** iff a reported finding matches on **all** of:

1. **Same file.**
2. **Overlapping line range** (finding's `line_start..line_end` intersects the seeded bug's range).
3. **Same defect class** (the seeded bug's category, e.g. off-by-one / race / unhandled-rejection / auth-gap / N+1).

- **Recall** = matched seeded bugs / total seeded bugs.
- **Precision** = adjudicated true findings / all reported findings (false positives labelled by adjudication).
- **F1** = harmonic mean of precision and recall.

## 4. Protocol (§18)

1. **Pre-registration** — this file, committed at T0, before any bench run. ✔ (this commit)
2. **Build / holdout split** — tune on the build set only. Exactly **one** evaluation pass on
   the holdout set, run **after** pipeline freeze. No post-hoc pipeline edits followed by
   holdout re-runs.
3. **No cherry-picking** — report all tasks, all arms, including losses. The README may not
   contain an example that isn't in the published bench results.
4. **No metric shopping** — primary metric per workflow is fixed above; secondary metrics
   cannot rescue a failed primary.
5. **Blind protocol for anything subjective** — outputs stripped of provider tells, order
   randomized, ≥3 raters, rater instructions committed before rating.
6. **Cost honesty** — report provider calls, wall-clock, and quota impact next to quality.
   "D wins by 5% while 4× slower and 3× more quota-expensive" is reported as exactly that.
7. **Negative results are publishable results** — if D ≈ C, that ships in `RESULTS.md` with
   the same prominence a win would get.

## 5. Task sets (§17)

- `bench/sets/code-review/build/` — 5 diffs, 4–6 seeded realistic bugs each (off-by-one, race
  condition, unhandled rejection, auth gap, N+1 query; MERN-style code). **Tuning allowed here.**
- `bench/sets/code-review/holdout/` — 10 diffs, created **after** the pipeline is frozen,
  never used for tuning.
- `bench/sets/idea-refinement/` — 6 idea documents incl. 3 deliberately ambiguous, plus
  per-doc 12-item coverage checklists.

Bench artifacts: every arm's runs are full `.aiki/runs/` records, plus
`bench/results/<suite>-<date>.json` (per-task per-arm scores + summary table).

## 6. Definition of "beating a single model" (§18)

A workflow beats a single model **iff**, on the frozen holdout set, **Arm D beats Arm B** (not
A) on the pre-registered primary metric by the §7 margin, at precision/cost/latency within
bounds, and the full §4 protocol was followed.

---

## 7. Kill criteria — pre-registered thresholds (§23)

Evaluated at Day 14 and Week 4. Any trigger fires its consequence. **Thresholds are not
renegotiable after seeing data.**

| # | Criterion | Threshold | Consequence if failed |
|---|-----------|-----------|------------------------|
| 1 | **Multi-provider thesis** (code-review holdout) | Arm D beats Arm B by **≥20% relative** on seeded-bug recall, precision no more than **10 points** below B | Cross-provider claim is dead; do not publish a "beats one model" README. |
| 2 | **Diversity thesis** | Arm D beats Arm C by **≥10% relative** on the same metric | Vendor diversity is theater; pivot to single-CLI structured-review / self-consistency tool if C beat B convincingly, else kill. |
| 3 | **Manual-loop test** | On 5 tasks, user's manual ChatGPT↔Claude copy-paste loop (15 min/task) preferred in blind comparison **≥4/5** | UX premise fails → kill or radically simplify. |
| 4 | **Operational** | median run wall-clock **> 8 min** OR a run consuming **> 15%** of a provider's daily quota | Dead for daily use regardless of quality. |
| 5 | **Maintenance tax** | **> 30%** of dev time in weeks 3–4 on adapter breakage | Platform unbuildable solo; freeze adapters or kill. |
| 6 | **Retention (self)** | Developer running it **< 2×/week** on real work by week 3 | Nobody else ever will. |
| 7 | **If published** | 30 days, **< 50 stars AND zero** unsolicited real-usage reports | Archive as portfolio; stop feature work. |
