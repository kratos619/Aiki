# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — T7 (S8–S10) code-complete, all gates green. The full S1→S10 pipeline is wired.
One thing pending: the LIVE 00–10 run, which the USER runs (metered). No half-written code.**

Resume steps for the new session:
1. Read `.agent/STATE.md` (position, ledger, T6+T7 decisions, traps). Do NOT re-scan the tree.
2. Sanity check: `npm run typecheck && npm test` (expect **80 passing**) and
   `node dist/cli/index.js doctor --no-smoke` (expect 3/3). Green → proceed.
3. **If the user's live T7 run hasn't happened yet:** they run it (token budget) — `npm run build`
   then `node dist/cli/index.js run idea-refinement examples/sample-idea.md`, then inspect
   `.aiki/runs/<id>/` for `08-verifications.json`, `09-judge-report.json`, `final-report.md` (+ 00–07),
   and confirm consensus is now non-empty (the S7 grouping call working). Green → flip T7 ledger to ✅.
4. **Then start T8 (TUI, ink)** — §4.2 stage timeline, S2-clarification screen, completion view. Also
   revisit the S2 Jaccard-clustering tuning (traps) — it over-triggers the T8 clarification.

What T7 added (uncommitted diff — user commits), all to the grilled+locked design:
- `src/orchestration/stages/{s8-verify,s9-judge,s10-render}.ts` (new).
- `s7-disagreement.ts`: S7 now makes ONE model call — `s7SemanticGroup` (judge role, IDs-only,
  attribution-withheld, validated by-reference, graceful lexical fallback) + `applyGroups` (pure merge).
- `src/schemas/index.ts`: `ClaimGroups` (S7 call), `JudgeReportModel` (dissent min-0 for S9 salvage).
- `src/orchestration/context.ts`: `DEFAULT_BUDGET` 9 → 12 (deviation from §19, with arithmetic).
- `src/workflows/idea-refinement.ts`: wired S8→S9→S10 (full S1→S10).
- Tests: `test/synthesis.test.ts` (new — grouping merge, §602 anti-blending, audit, §272 demotion);
  `engine.test.ts` now drives S1→S10 end-to-end (00–10 + final-report.md).

Traps / gotchas for T8+:
- Live run is metered — I don't run it (see memory `no-live-paid-runs`); give the user steps + sample.
- S7 grouping graceful-fallback means consensus can still be empty if that call fails — that's by design,
  not a bug; `low_diversity` flag + the fallback note cover it.
- S9 semantic guards (anti-blending, dissent) are enforced OUTSIDE jsonCall's schema-repair, in `s9Judge`.
- Rubric still inline (`IDEA_RUBRIC`); the skills/`rubric.json` loader (§11) is still deferred.
