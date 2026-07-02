# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — no in-flight work. T0–T5 complete; start T6.**

Resume steps for the new session:
1. Read `.agent/STATE.md` (position, task ledger, decided-facts, traps). Do NOT read the rest
   of the tree to "get oriented" — the map in STATE.md is enough.
2. Sanity check: `npm run typecheck && npm test` (expect **65 passing**) and
   `node dist/cli/index.js doctor --no-smoke` (expect 3 providers). Green → proceed.
3. Do **T6 (S4–S7)** exactly as spelled out under "Next action" in STATE.md. Extend
   `runIdeaRefinement` (`src/workflows/idea-refinement.ts`) past S3. Follow §9 + §12.1.
   - S4 is the same fan-out shape as `s2-misread.ts` (allSettled + `isFatal` rethrow + quorum) —
     copy that pattern. Validate with `RoleOutput` but INJECT the `workflow` discriminator first
     (model JSON has none — see STATE traps). S4 seats = `ctx.roles.s4` (default `[agy, codex]`).
   - S5/S6/S7 are deterministic (no model calls) → unit-test the dedupe + map directly.
   - Reuse: `jsonCall` (jsonStage.ts), `RunWriter.writeJson('drift-report'|'claims'|
     'disagreement-map', …)` (ordinals 5/6/7 already defined; 07 has the `DisagreementMap` schema
     wired, 05/06 are schema:null write-as-is), `writeRoleOutput(name, obj)` for 04.
4. When done: update STATE.md ledger + Next action, keep this file current, STOP before
   committing — the user commits.

Nothing is half-written. Uncommitted diff = finished T3+T4+T5. A live T5 run left artifacts under
`.aiki/runs/` (gitignored) — safe to inspect or delete.

T5 (just finished) added: `src/orchestration/{context,jsonStage,cluster,engine}.ts` +
`stages/{s1-intent,s2-misread,s3-prompts}.ts`, `src/workflows/idea-refinement.ts`,
`src/cli/run.ts` (+ index wiring), `StagePrompts` schema, `test/{cluster,engine}.test.ts`.
Verified live: `aiki run idea-refinement "<text>"` → valid 00–03 + meta; §14 repair loop fired and
recovered on agy's S2 output. Known limitation logged in STATE traps: S2 Jaccard clustering is
strict on prose (tune at T8).
