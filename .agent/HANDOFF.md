# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — no half-written code. T12's buildable half is DONE + green; the remainder is the
USER's metered holdout eval + RESULTS write-up.**

This session built the T12 content (holdout set + test + RESULTS scaffold) and fixed a real `.gitignore`
bug. 148 tests green (145 + 3 new in `test/t12.test.ts`), typecheck + `npm run build` clean. Nothing is
mid-edit. **The working tree is NOT committed — the user commits** (STATE.md + HANDOFF.md + the diff are
the handoff).

Built this session (all uncommitted, working tree only):
- `bench/sets/code-review/holdout/{01-payments,02-inventory,03-comments,04-search,05-notifications,
  06-profile,07-dashboard,08-upload,09-sessions,10-analytics}/{<src>,diff.patch,bugs.json}` — 10 cases,
  43 seeded bugs (4–5 each). MERN-style. `diff.patch` = whole-file add via `git diff --no-index` (so every
  seeded line is a reviewable `+` line, `+++ b/<file>`). Categories = the 6 enum; the 5 canonical classes
  (off-by-one, race, unhandled-rejection, auth-gap, N+1) each appear multiple times.
- `test/t12.test.ts` (3 tests) — proves the holdout is well-formed: loadCases=10, per-bug file-exists +
  line-in-bounds + valid category, class coverage. NO paid calls (does not run any arm).
- `RESULTS.md` — full scaffold, all arms × all 10 cases, cost/latency columns, an explicit pass/fail line
  per §23 kill criterion with the gate arithmetic pre-wired. Number cells are `—` until the metered run.
- `.gitignore` — added `!bench/sets/` + `!bench/sets/**` under the existing `bench/*` so the pre-registered
  ground-truth sets are committable (freeze integrity) while `bench/results/*` stays ignored. This also
  un-ignored the T11 build set, which had never actually been committed.

To FINISH T12 (the user's part — metered):
1. Sanity: `npm run typecheck && npm test` (expect **148**), `doctor --no-smoke` (3/3).
2. Run the ONE eval pass: `node dist/cli/index.js bench code-review --arms A,B,C,D --set holdout`
   (~120 calls, sequential, incremental results → `bench/results/code-review-<today>.json`).
   **BENCHMARK.md §6.2 forbids ANY pipeline edit after this run.** Do NOT touch src/, arms, the matcher,
   or bugs.json afterward.
3. FP-label each run for precision: `node dist/cli/index.js resolve <run-id> --verdict <id>=false-positive`
   (verbs: false-positive|fixed|wontfix). Harness reads these from `.aiki/feedback.jsonl`.
4. Fill `RESULTS.md` §4–§6 from the JSON; compute §7 gate lines (KC#1 `rD≥1.20·rB ∧ pD≥pB−0.10`,
   KC#2 `rD≥1.10·rC`, KC#4 wall<8min ∧ ≤15% quota); write the §23 verdict. Commit RESULTS.md beside the
   raw results JSON (§6: publish artifacts).

Gotchas / open items:
- **Ground truth is FROZEN.** The holdout `bugs.json` line ranges + categories are the pre-registered
  key. Do NOT retune them to chase recall after the run — that voids the protocol. (Build set is tunable;
  holdout is not.) If a real reviewer flags a seed at a different category, that miss is honest signal.
- **Category-strict matching (frozen):** a find must share file + overlapping lines + SAME category enum.
  Some seeds (e.g. missing-await categorized CORRECTNESS in 09; regex-injection SECURITY in 04) are
  defensible but debatable — that risk is symmetric across arms, so it doesn't bias D vs B.
- **`aiki bench` has no `--yes` / pre-run call estimate** (§19 wanted one; T11 shipped without; unfixed —
  freeze). User initiates the ~120-call run knowingly.
- Whole holdout set + scaffold live in the working tree only until the user commits.
