# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — start next task (T12). T0–T11 all DONE. Nothing half-written.**

T11 (bench harness + build set) grilled → design locked → built → tested this session. 145 tests green
(136 + 9 new in `test/t11.test.ts`), typecheck + build clean. T0–T10 are committed (a9ca5a2); T11 is the
uncommitted diff.

Resume steps:
1. Read `.agent/STATE.md` (position, ledger, the T11 SHIPPED block + traps). Do NOT re-scan the tree.
2. Sanity check: `npm run typecheck && npm test` (expect **145 passing**) and `doctor --no-smoke` (3/3).
3. T12 = freeze + holdout + RESULTS (§24 T12): create the 10-diff HOLDOUT set (after freeze; same case
   layout as build — `bench/sets/code-review/holdout/<name>/{src, diff.patch, bugs.json}`), run ONE eval
   pass of all 4 arms (`aiki bench code-review --set holdout` — METERED, user runs it), FP-label each run
   (`aiki resolve <run>`) for precision, write `RESULTS.md` (all arms/tasks + cost/latency + explicit
   pass/fail per §23 kill criterion), then the §23 gate. BENCHMARK.md forbids pipeline edits after the
   first holdout run.

T11 file map (uncommitted; user commits — do not re-implement):
- NEW: `src/bench/scoring/seeded-bugs.ts` (`SeededBug`/`BugManifest` schema + `scoreRun` — reuses
  `sameFinding`), `src/bench/arms.ts` (arm A/B single-call, C sample-keyed self-consistency `mergeSamples`,
  D wraps `runCodeReview`; `ARMS` registry), `src/bench/results.ts` (`BenchResult` schema + `summarize`
  micro), `src/bench/harness.ts` (`loadCases`/`runBench` sequential+incremental/`renderTable`),
  `src/cli/bench.ts`, `test/t11.test.ts`, and `bench/sets/code-review/build/{01-user-api,02-cart,03-auth,
  04-orders,05-ui}/{<src>,diff.patch,bugs.json}` (5 cases / 20 seeded bugs).
- EDITED: `src/schemas/index.ts` (extracted `FindingCategory` enum; exported `Finding`), `cr-map.ts`
  (`sameFinding` loosened to a `FindingLoc` — reused by the scorer), `src/storage/feedback.ts`
  (GENERALIZED: verdict union incl. fixed/wontfix/false-positive, `item_type` finding|adjudication,
  `ruling`→string, `parseVerdictFlags(allowed)`, `VERDICT_VOCAB`), `src/cli/resolve.ts` (workflow-aware:
  code-review walks kept findings), `src/cli/index.ts` (`bench` command), `test/t9.test.ts` (one error-message
  assertion updated for the generalized message).

Gotchas / open items:
- **Category-strict matching (frozen):** the scorer requires the finding's `category` enum to equal the
  seeded bug's. Some seed categories are debatable (e.g. the `=` vs `===` auth bypass = SECURITY here) —
  build set is TUNABLE, so if a real run misses a seed on category, retune the seed (allowed on build; NOT
  on holdout). Don't loosen the matcher (BENCHMARK.md is frozen).
- **Arm C is sample-keyed, not provider-keyed** (3 claude samples all share provider id) — it has its own
  `mergeSamples`, deliberately NOT the D pipeline. C's synthesis judge = claude (same-model, roleOverride).
- **Precision is null until FP-labelled.** T12's precision needs `aiki resolve <run> --verdict <id>=false-positive`
  on each holdout run; the harness reads those from `.aiki/feedback.jsonl`.
- Real 4-arm bench (`aiki bench code-review --set build`) is METERED (~60 calls) → user's manual §606
  acceptance; do NOT run it yourself (no-live-paid-runs).
- `.DS_Store` untracked cruft; graphify-out/ is the knowledge graph.
