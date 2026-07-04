# RESULTS.md — code-review benchmark (frozen holdout)

**Status: AWAITING THE ONE METERED HOLDOUT RUN.** The pipeline is frozen and the holdout set is
authored. The number cells below are `—` until the single evaluation pass is run. Once run, drop the
numbers in from `bench/results/code-review-<date>.json` and label false positives — the arithmetic for
every §23 gate is spelled out so filling is mechanical. **No pipeline edits after the first holdout run**
(BENCHMARK.md §6.2).

---

## 1. Protocol compliance (§18 / BENCHMARK.md)

| Rule | State |
|---|---|
| Pre-registration committed before any bench run | ✅ `BENCHMARK.md` (arms, metrics, matching, thresholds) frozen at T0 |
| Pipeline frozen before holdout authored | ✅ frozen at commit `63b9fd8` (T0–T11); holdout created after, under T12 |
| Holdout never used for tuning | ✅ this is the **first and only** eval pass on `holdout/` |
| Build / holdout split | ✅ tuning happened on `build/` (5 diffs) only |
| One evaluation pass, no post-hoc pipeline edits + re-run | ⏳ enforced at run time |
| Report all arms, all tasks, incl. losses | ⏳ tables below (every arm × every case) |
| Primary metric fixed, no metric shopping | ✅ **seeded-bug recall (micro)** — all kill criteria attach here |
| Cost honesty (calls, wall-clock, quota next to quality) | ⏳ cost/latency table below |
| Negative results ship with equal prominence | ✅ this file publishes whatever the run shows |

**Primary metric (frozen):** seeded-bug recall, **micro** = (Σ matched bugs) / (Σ seeded bugs) across
the 10 cases. Macro (mean of per-case ratios) is reported as secondary only.

**Matching rule (frozen, BENCHMARK.md §3):** a reported finding counts as FOUND iff it shares the seeded
bug's **file**, has **overlapping lines**, and the **same category** enum (`sameFinding`). A
mis-categorized find does not count.

**Arms (frozen):**

| Arm | What it is | Providers | Role |
|---|---|---|---|
| A | 1 claude call, plain "review this diff" | claude | naive floor |
| B | 1 claude call, structured adversarial (analyze → self-attack → re-answer) | claude | **the opponent to beat** (single strong model) |
| C | claude sampled 3× (sample-keyed self-consistency, merge ≥2/3, judge singletons) | claude | null hypothesis (cheapest lift) |
| D | cross-provider: claude + codex reviewers, Gemini judge | claude, codex, agy | the multi-provider thesis |

---

## 2. The holdout set (frozen — 10 diffs, 43 seeded bugs)

Each case = one whole-file-add diff over a MERN-style file, with precisely-located seeded bugs
(`bench/sets/code-review/holdout/<name>/{src, diff.patch, bugs.json}`). Ground truth verified in
`test/t12.test.ts` (every seed's file exists, lines in-bounds, category valid).

| # | Case | File | Seeded | Bug classes (category) |
|---|---|---|---|---|
| 01 | payments | payment-controller.js | 4 | off-by-one (CORR), null-deref×2 (EH), auth-gap (SEC) |
| 02 | inventory | inventory-service.js | 4 | race (CONC), negative-stock (CORR), N+1 (PERF), unhandled (EH) |
| 03 | comments | comments-controller.js | 4 | N+1 (PERF), off-by-one (CORR), auth-gap (SEC), null-deref (EH) |
| 04 | search | search-service.js | 5 | off-by-one×2 (CORR), regex-injection (SEC), N+1 (PERF), null-deref (EH) |
| 05 | notifications | notification-service.js | 4 | async-forEach race (CONC), unhandled (EH), off-by-one (CORR), auth-gap (SEC) |
| 06 | profile | profile-controller.js | 4 | IDOR/mass-assign (SEC), no-null-check (CORR), TOCTOU race (CONC), cred-exposure (SEC) |
| 07 | dashboard | Dashboard.jsx | 5 | stale-effect (CORR), unhandled fetch (EH), N+1 waterfall (PERF), off-by-one (CORR), missing-key (MAINT) |
| 08 | upload | upload-controller.js | 4 | path-traversal×2 (SEC), unhandled fs (EH), off-by-one (CORR) |
| 09 | sessions | session-middleware.js | 4 | decode-not-verify (SEC), null-deref (EH), wrong-TTL (CORR), timing (SEC) |
| 10 | analytics | analytics-repo.js | 5 | off-by-one (CORR), N+1 (PERF), $where injection (SEC), counter race (CONC), null-deref (EH) |

**Category coverage:** CORRECTNESS 12 · SECURITY 11 · ERROR_HANDLING 10 · PERF 5 · CONCURRENCY 4 ·
MAINTAINABILITY 1  (all five canonical classes — off-by-one, race, unhandled-rejection, auth-gap, N+1 —
appear multiple times).

---

## 3. How to run the one metered pass (user runs this — it is metered)

```sh
# ~120 model calls across 10 cases × 4 arms (A/B = 1, C ≈ 3–4, D ≈ 5 each). Sequential; results
# written incrementally after each case, so a mid-run quota stop keeps completed work.
node dist/cli/index.js bench code-review --arms A,B,C,D --set holdout
#   → writes bench/results/code-review-<today>.json  +  prints the per-arm table

# Precision needs false-positive labels. For each run id in the results JSON, walk its findings and
# tag the ones that are NOT real bugs; the harness reads these back from .aiki/feedback.jsonl:
node dist/cli/index.js resolve <run-id> --verdict <findingId>=false-positive [--verdict ...]
#   (verbs for code-review: false-positive | fixed | wontfix)
```

Then paste the summary-table numbers into §4 and the per-case recall into §5, fill §6 cost/latency,
and evaluate §7. `bench` prints the results-file path on completion.

---

## 4. Primary results — per-arm summary (micro recall is the metric)

_Fill from the `summary` array of `bench/results/code-review-<date>.json`._

| Arm | Recall (micro) | Recall (macro) | Matched/Seeded | Reported | Unmatched (candidate FP) | Precision | Calls | Wall (s) |
|---|---|---|---|---|---|---|---|---|
| A | — | — | —/43 | — | — | — | — | — |
| B | — | — | —/43 | — | — | — | — | — |
| C | — | — | —/43 | — | — | — | — | — |
| D | — | — | —/43 | — | — | — | — | — |

Precision = (reported − false-positives) / reported, per arm, after `resolve` labeling; `—` = not yet
adjudicated. Unmatched findings are candidate FPs and are **UNADJUDICATED** until labeled — they are not
precision on their own.

---

## 5. Per-case recall — every arm × every case (no cherry-picking)

_Fill from `cases[].arms[]` (matched/seeded per case)._

| Case | Seeded | A | B | C | D |
|---|---|---|---|---|---|
| 01-payments | 4 | —/4 | —/4 | —/4 | —/4 |
| 02-inventory | 4 | —/4 | —/4 | —/4 | —/4 |
| 03-comments | 4 | —/4 | —/4 | —/4 | —/4 |
| 04-search | 5 | —/5 | —/5 | —/5 | —/5 |
| 05-notifications | 4 | —/4 | —/4 | —/4 | —/4 |
| 06-profile | 4 | —/4 | —/4 | —/4 | —/4 |
| 07-dashboard | 5 | —/5 | —/5 | —/5 | —/5 |
| 08-upload | 4 | —/4 | —/4 | —/4 | —/4 |
| 09-sessions | 4 | —/4 | —/4 | —/4 | —/4 |
| 10-analytics | 5 | —/5 | —/5 | —/5 | —/5 |
| **Total** | **43** | **—/43** | **—/43** | **—/43** | **—/43** |

---

## 6. Cost & latency (reported next to quality, §18.6)

_Fill from per-arm `calls` and `wallMs`; note quota impact if a run consumed a large share of a
provider's daily allowance._

| Arm | Total calls | Median run wall (s) | Max run wall (s) | Quota note |
|---|---|---|---|---|
| A | — | — | — | — |
| B | — | — | — | — |
| C | — | — | — | — |
| D | — | — | — | — |

---

## 7. §23 kill-criteria verdicts (explicit pass/fail per criterion)

Primary metric = seeded-bug recall (micro). Let `rA, rB, rC, rD` be per-arm micro recall and `pB, pD`
be per-arm precision (fractions).

| # | Criterion | Pass condition (pre-registered) | Computed | Verdict |
|---|---|---|---|---|
| 1 | **Multi-provider thesis** | `rD ≥ 1.20 × rB` **AND** `pD ≥ pB − 0.10` | rD=—, 1.20·rB=—, pD=—, pB−0.10=— | ⏳ PENDING |
| 2 | **Diversity thesis** | `rD ≥ 1.10 × rC` | rD=—, 1.10·rC=— | ⏳ PENDING |
| 3 | **Manual-loop test** | On 5 tasks, manual ChatGPT↔Claude loop preferred < 4/5 in blind comparison | not run this pass | ⏳ MANUAL / PENDING |
| 4 | **Operational** | median run wall < 8 min **AND** no run > 15% of a provider's daily quota | wall=—, quota=— | ⏳ PENDING |
| 5 | Maintenance tax | < 30% of weeks 3–4 dev time on adapter breakage | dev-process metric | n/a at this gate |
| 6 | Retention (self) | developer runs it ≥ 2×/week on real work by week 3 | dev-process metric | n/a at this gate |
| 7 | If published | 30 days: ≥ 50 stars OR a real-usage report | post-publish metric | n/a at this gate |

**Decision gate (§18 / §23):** the multi-provider claim survives **iff criterion #1 passes** (D beats
**B**, not A, by ≥20% relative recall at precision within 10 points) **and** #4 holds.
- If #1 **fails** → the cross-provider claim is dead; do **not** publish a "beats one model" README. If C
  beat B convincingly, pivot to a single-CLI structured-review / self-consistency tool; else kill.
- If #1 passes but #2 **fails** → vendor diversity is theater (D ≈ C); same pivot consideration.
- **Verdict: ⏳ PENDING the metered run.** Negative results ship here with the same prominence a win would.

---

## 8. idea-refinement bench (secondary, §20 day-14)

The bench harness is `code-review`-only in v1 (`aiki bench` rejects other workflows by design). The
idea-refinement quality signals (rubric/checklist coverage, misread-catch) were exercised interactively
during T8 self-testing (run `…-8c44`: full S1→S10, clarification flow fired, disagreement map produced),
not as an automated scored suite. This is a **documented limitation**, not a passed criterion — an
automated idea-refinement scorer (`bench/scoring/checklist.ts`) is out of the v1 task list.

---

*Generated under T12. Fill §4–§7 from the results JSON + `resolve` FP labels, then commit RESULTS.md
alongside the raw `bench/results/*.json` (BENCHMARK.md §6: publish raw run artifacts beside results).*
