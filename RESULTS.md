# RESULTS.md — code-review benchmark (frozen holdout)

**Status: VERDICT WRITTEN — 2026-07-05 (qualified per Amendment A2). KC#1 ✅ PASS, KC#4 ✅ PASS, KC#2 ⏸
deferred.** The multi-provider thesis survives: council D recalled **43/43 (100%)** vs best single model
B **33/43 (77%)** — 1.30× — at equal precision (both 1.00, 0 false positives across 59 adjudicated
unmatched findings). Claim is "beats the best single model," NOT "beats self-consistency" (C unrun).
Freeze now LIFTS for the post-eval dev round (new pre-registration). See §7 for the full verdict + caveats.

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

### Amendment A1 (2026-07-04, pre-declared BEFORE the clean pass — quota-failure recovery)

Two eval attempts died of provider-quota exhaustion, not of any measured outcome; both are VOID and
archived (`*.void.json`, ignored by `--resume`). No result-driven tuning occurred; arms, matcher,
`bugs.json`, and thresholds are untouched.

1. **Attempt 1** (`…attempt1.void.json`): Opus died during case 02 arm D. A/B/C crashed from case 03 on;
   arm D silently completed cases 02–10 on codex+agy only (claude reviewer CRASH in meta) — not the
   registered pipeline. Its summary compares arms over unequal case counts; unusable for §7.
2. **Attempt 2** (`…attempt2-partial.void.json`): re-run same evening; codex crashed in case-01 D; killed
   during case 02 before its incremental write (case-02 calls burned, unrecorded, unsalvageable).
3. **Harness robustness added between attempts** (non-result-affecting): `--resume` (keeps scored
   case×arm pairs across quota windows), pre-run Opus-call estimate + `--yes` gate, and a degradation
   guard (any errored provider call ⇒ pair = `error`, never scored). Tested scripted-only.
4. **Salvage rule (mechanical, no selection freedom):** a scored case×arm pair from a void attempt is
   reused iff its run `meta.json` shows ZERO errored calls; where duplicates exist across attempts, the
   EARLIEST clean measurement wins. Result: **6 pairs kept** (01 A/B/C/D, 02 A/B); attempt-1's 02 D
   dropped (hidden claude CRASH in meta); attempt-2's duplicate 01 A/B/C not used (later measurements).
5. **Observed measurement noise (honest caveat):** case 01 recall flipped between identical attempts
   (A 0.75→1.0, B 1.0→0.75, C 1.0→0.75) — per-case recall on 4-bug cases is ±1 bug across runs.
   Single-case deltas are noise; only the full-set micro recall feeds §7.
6. **Arm A runs no further metered cases** — it appears in no §23 gate; its salvaged pairs are reported
   as partial context only. Execution is staged: `--arms B,D` first (KC#1, KC#4), then `--arms B,C,D`
   (KC#2). The §7 verdict is written only after B, C, D are scored on all 10 cases.
7. **Provider version drift (recorded, not correctable):** codex broke and was reinstalled between
   attempts (0.135.0 → 0.142.5; the 22:16 crash was a broken install — missing `darwin-arm64` binary —
   not quota). Salvaged pair 01-D ran codex 0.135.0; remaining D cases run 0.142.5 (smoke-verified).
   Every run's `meta.json` records exact `provider_versions`; prompts and pipeline are identical.

### Amendment A2 (2026-07-05, pre-declared — KC#2 deferred, user decision)

Stage 2 (arm C on holdout cases 02–10) is **cancelled for this evaluation round** (quota conservation;
user decision after stage 1 completed). Consequences, stated before any further work:
- **KC#2 is DEFERRED — not passed, not failed.** The "cross-provider diversity beats same-model
  self-consistency" claim is **unevaluated on this holdout** and must not be asserted anywhere.
- The §7 verdict is therefore **qualified**: it rests on KC#1 (D vs B) + KC#4 (operational) only.
- C's salvaged case-01 pair remains reported as partial context. Any future C comparison happens in a
  NEW bench round under a new pre-registration (post-verdict pipeline changes make this holdout's C
  numbers non-comparable to the already-scored D).
- The freeze lifts when the §7 verdict line is written (requires the FP labels → KC#1 precision half).

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
# Staged per Amendment A1. Without --yes each command prints its ≈Opus-call estimate and exits (free).
# --resume keeps scored pairs, so re-running the SAME command each quota window fills the gaps.

# Stage 1 — KC#1 + KC#4 (≈26 Opus + ≈18 GPT calls; needs codex healthy):
node dist/cli/index.js bench code-review --arms B,D --set holdout --resume --yes

# Stage 2 — adds KC#2 (≈36 more Opus calls; B/D pairs already scored cost nothing):
node dist/cli/index.js bench code-review --arms B,C,D --set holdout --resume --yes
#   → writes bench/results/code-review-<date>.json  +  prints the per-arm table

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
| A† | 88% | 88% | 7/8 (2 cases only) | 16 | 8 | — | 2 | 163.8 |
| B | **77%** | 78% | 33/43 | 68 | 29 | **1.00** | 10 | 1747.2 |
| C‡ | (1 case) | — | 4/4 (case 01 only) | 11 | 7 | — | 4 | 433.8 |
| D | **100%** | 100% | **43/43** | 78 | 30 | **1.00** | 44 | 4006.2 |

**Precision adjudication (2026-07-05, all 59 unmatched B+D findings labeled → `.aiki/feedback.jsonl`):**
**0 false positives on either arm** — every unmatched finding is a real defect, either (a) a genuine bug
the seed set did not cover (non-atomic charge, unbounded broadcast, unanchored-regex scan, React
effect-cleanup, `authenticate` referenced-but-not-imported, …) or (b) a *seeded* bug the strict matcher
rejected on category/line (e.g. B and D both caught the coupon/category/author null-derefs but tagged
CORRECTNESS where the seed said ERROR_HANDLING; several of B's case-03 findings were correct but
mislocated). pB = pD = **1.00**. **Caveat — precision does NOT discriminate here:** the holdout files are
deliberately bug-dense, so almost any flag lands on a real defect; this set tests *recall*, not precision.
Adjudication was performed by the assistant against each source file (reasoning + labels are auditable in
`feedback.jsonl`); a human spot-check of the debatable P3 / `authenticate`-artifact calls is advisable,
though even a harsh reading (calling all ~6 debatable findings FP, symmetrically) keeps both arms > 0.90
and preserves `pD ≥ pB − 0.10`.

† A retired after 2 salvaged cases (Amendment A1.6 — appears in no §23 gate); partial context only.
‡ C = salvaged case 01 only; remaining 9 cases run in stage 2 (Amendment A1.6 staging).

Precision = (reported − false-positives) / reported, per arm, after `resolve` labeling; `—` = not yet
adjudicated. Unmatched findings are candidate FPs and are **UNADJUDICATED** until labeled — they are not
precision on their own.

---

## 5. Per-case recall — every arm × every case (no cherry-picking)

_Fill from `cases[].arms[]` (matched/seeded per case)._

| Case | Seeded | A† | B | C‡ | D |
|---|---|---|---|---|---|
| 01-payments | 4 | 3/4 | 4/4 | 4/4 | 4/4 |
| 02-inventory | 4 | 4/4 | 4/4 | — | 4/4 |
| 03-comments | 4 | — | **1/4** | — | 4/4 |
| 04-search | 5 | — | **2/5** | — | 5/5 |
| 05-notifications | 4 | — | **2/4** | — | 4/4 |
| 06-profile | 4 | — | 4/4 | — | 4/4 |
| 07-dashboard | 5 | — | **3/5** | — | 5/5 |
| 08-upload | 4 | — | 4/4 | — | 4/4 |
| 09-sessions | 4 | — | 4/4 | — | 4/4 |
| 10-analytics | 5 | — | 5/5 | — | 5/5 |
| **Total** | **43** | **7/8** | **33/43** | **4/4** | **43/43** |

B's misses cluster on 4 cases (03/04/05/07 — 10 of its 10 total misses); D caught all of them (which
seeded classes B missed per case is re-derivable from `raw/bench-findings.json` × `bugs.json`, not yet
tabulated). On D runs 04/05/07 the S8 cross-exam produced real disputes and the **Gemini judge fired**
(S9 call in meta) — the judge-dormancy seen on early cases did not hold on the harder ones.

---

## 6. Cost & latency (reported next to quality, §18.6)

_Fill from per-arm `calls` and `wallMs`; note quota impact if a run consumed a large share of a
provider's daily allowance._

| Arm | Total calls | Median run wall (s) | Max run wall (s) | Quota note |
|---|---|---|---|---|
| A† | 2 | 82 | 88 | 1 Opus call/case |
| B | 10 | 147 | 331 | 1 fat Opus call/case — 10 Opus total |
| C‡ | 4 | 434 (1 run) | 434 | ~4 Opus calls/case — the Opus-heaviest arm |
| D | 44 | 324 | 659 | per case: 2 Opus + 2 GPT + 0–1 Gemini; ≈2.2 provider-calls of Opus/case |

Context (honest): the B+D holdout sweep consumed ≈30 fat Opus calls and needed **3 quota windows**
(2 mid-run exhaustions, recovered by `--resume`). Wall-clock includes provider queueing during
near-exhaustion. Gemini judge fired on 3 D runs (04/05/07); 06's 5th call was a §14 JSON repair retry.

---

## 7. §23 kill-criteria verdicts (explicit pass/fail per criterion)

Primary metric = seeded-bug recall (micro). Let `rA, rB, rC, rD` be per-arm micro recall and `pB, pD`
be per-arm precision (fractions).

| # | Criterion | Pass condition (pre-registered) | Computed | Verdict |
|---|---|---|---|---|
| 1 | **Multi-provider thesis** | `rD ≥ 1.20 × rB` **AND** `pD ≥ pB − 0.10` | rD=1.000 ≥ 1.20·rB=0.921 ✓; pD=1.00 ≥ pB−0.10=0.90 ✓ | ✅ **PASS** |
| 2 | **Diversity thesis** | `rD ≥ 1.10 × rC` | C not run on holdout (Amendment A2) — unevaluated | ⏸ DEFERRED (A2) |
| 3 | **Manual-loop test** | On 5 tasks, manual ChatGPT↔Claude loop preferred < 4/5 in blind comparison | not run this pass | ⏳ MANUAL / PENDING |
| 4 | **Operational** | median run wall < 8 min **AND** no run > 15% of a provider's daily quota | D median wall **5.4 min** ✓; quota: a D run ≈ 2 fat Opus calls ≈ 13% of an observed ~15-call 5h window ✓ (estimate — window capacity not exactly measurable) | ✅ PASS (quota = estimate) |
| 5 | Maintenance tax | < 30% of weeks 3–4 dev time on adapter breakage | dev-process metric | n/a at this gate |
| 6 | Retention (self) | developer runs it ≥ 2×/week on real work by week 3 | dev-process metric | n/a at this gate |
| 7 | If published | 30 days: ≥ 50 stars OR a real-usage report | post-publish metric | n/a at this gate |

**Decision gate (§18 / §23):** the multi-provider claim survives **iff criterion #1 passes** (D beats
**B**, not A, by ≥20% relative recall at precision within 10 points) **and** #4 holds.
- If #1 **fails** → the cross-provider claim is dead; do **not** publish a "beats one model" README. If C
  beat B convincingly, pivot to a single-CLI structured-review / self-consistency tool; else kill.
- If #1 passes but #2 **fails** → vendor diversity is theater (D ≈ C); same pivot consideration.
  **Per Amendment A2, #2 is DEFERRED (not failed): the D-vs-C comparison is unevaluated on this holdout
  and the diversity-vs-self-consistency claim must not be made.**
- **VERDICT (2026-07-05, qualified per Amendment A2): the multi-provider thesis SURVIVES.**
  KC#1 **PASS** — the council (D) recalled **43/43 (100%)** seeded bugs vs the strongest single model's
  structured-adversarial review (B) **33/43 (77%)**, a **1.30×** relative gain (gate ≥1.20×), at equal
  precision (both 1.00). KC#4 **PASS** (median D review 5.4 min; per-run Opus ≈13% of a 5h window, est.).
  KC#2 (vs self-consistency C) is **DEFERRED, not evaluated** (Amendment A2) — so this verdict claims
  "beats the best single model," **not** "beats cheap self-consistency"; the latter is untested and must
  not be asserted. Honest caveats: (1) precision was non-discriminating on this bug-dense set — the win
  is a *recall* win; (2) the D-vs-B win is driven substantially by the strict matcher penalizing B's
  correct-but-mislocated / mis-categorized findings (a real property of the frozen protocol, symmetric in
  principle but B tripped it more); (3) n=10 cases, single run per arm — directional, not a p-value.
  **Publishable claim:** "cross-provider structured review caught every planted bug where the best single
  model missed ~1 in 4, at equal precision, on a 10-case held-out set." Nothing stronger.

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
