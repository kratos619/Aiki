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

### Pre-registration amendment E1 (2026-07-05, append-only — original §1 text above is unchanged)

**Arm E is added** AFTER the D-vs-B holdout verdict (KC#1 passed):

| Arm | Description |
|-----|-------------|
| **E** | Same product pipeline as D, roles swapped for Opus thrift: **agy + codex reviewers, claude judge** (claude fires only on disputes). Tests whether the cross-provider win survives without Opus doing the hunting. (For the record, D's registered roles: claude + codex reviewers, agy judge.) |

Arm E is NOT part of the original frozen holdout claim and its holdout numbers, if ever run, carry no
retroactive weight. **Arm E is evaluated on the BUILD set only** (tuning-permitted), under question E1
below; the frozen holdout and its verdict are untouched. Rationale: D proved the thesis but D's reviewers
include claude (Opus-costly); E asks whether agy+codex hunting with a claude *judge* keeps the recall at a
fraction of the Opus cost. This is exploratory engineering, explicitly not a holdout claim.

**Question E1 (build set, exploratory):** does Arm E recall ≥ 0.90 × Arm D recall while using ≤ ~1 claude
call/case (vs D's ~2)? If yes → ship E as the default and re-benchmark E on a fresh holdout under its own
pre-registration. If no → keep D; the Opus hunting is load-bearing.

### Pre-registration amendment L1 (2026-07-06, append-only — original §1 + E1 unchanged)

**Arm L (escalation ladder) is added** as an exploratory BUILD-SET arm (like E). It is NOT part of the
frozen holdout claim and carries no retroactive weight.

| Arm | Description |
|-----|-------------|
| **L** | Deterministic escalation ladder. **Tier 1 (cheap hunt):** agy + codex review + mutual cross-examination (= Arm E's tier 1; no claude in the hunt). **Tier 2 (claude), fired ONLY on:** (a) a DISPUTED finding → claude adjudicates (the S9 judge, = Arm E); (b) a COVERAGE HOLE → exactly one targeted claude review scoped to the risky hunks. Tier-2 (b) findings are validated (file:line) and merged into the kept set before scoring. |

**Coverage hole (FROZEN).** For each risk class in RISK_DEFS below, the risk is *triggered* iff a HEAD file
path matches its file-glob **OR** an added diff line (`+…`) matches its keyword regex; it is a *hole* iff
triggered **AND** tier-1 reported ZERO findings of that risk's covering category located in the triggering
files (glob files if any, else the whole diff). Each hole escalates exactly one targeted claude review over
those files. RISK_DEFS are frozen in `src/orchestration/stages/cr-ladder.ts` (unit-tested,
`test/cr-ladder.test.ts`):

| Risk | Covering category | File glob (substring, case-insensitive) | Added-line keywords |
|------|-------------------|-----------------------------------------|---------------------|
| auth | SECURITY | auth login session token permission acl oauth jwt guard middleware | authenticate authoriz(e) password jwt bcrypt session cookie csrf isadmin req.user .role permission |
| crypto | SECURITY | crypto encrypt cipher hash sign | encrypt decrypt createHash randomBytes createCipher hmac nonce iv math.random |
| payment | CORRECTNESS or SECURITY | payment billing charge invoice checkout stripe order price | charge refund amount currency price subtotal total discount tax balance |
| async | CONCURRENCY | worker queue scheduler job concurrent | async await Promise.all Promise.race setTimeout setInterval mutex lock concurrent parallel |

**HARD PREREQUISITE.** Trigger (a) fires only if the S8 cross-exam actually produces disputes (the V1
S8-teeth signal). If disputes ≡ 0 on the build set, the ladder degenerates to "tier-1 + coverage holes" and
this L1 evaluation is INVALID. **Confirm disputes > 0 on the build set (the V1 paid bench) BEFORE running
L1.**

**Question L1 (build set, exploratory):** does Arm L recall ≥ 0.90 × Arm D recall while spending ≤ 0.5
claude calls/case (vs D's ~2)? Report **strict** recall (§3 matcher) AND **category-relaxed** recall (file +
overlapping lines, category ignored — the known matcher limitation) side by side. If yes → ship the ladder
as a run mode and re-benchmark it on a fresh holdout under its own pre-registration. If no → the
coverage-hole escalation isn't earning its Opus; keep D (or E).

**Acceptance (scripted, no paid calls):** a scripted-adapter e2e where (1) a diff with an auth hole + no
SECURITY finding triggers exactly one targeted claude call and merges its finding; (2) a diff fully covered
by tier-1 triggers ZERO targeted-hunt calls (the judge fires only if a finding is disputed).

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
