# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — no in-flight work. T0–T4 complete; start T5.**

Resume steps for the new session:
1. Read `.agent/STATE.md` (position, task ledger, decided-facts, traps). Do NOT read the rest
   of the tree to "get oriented" — the map in STATE.md is enough.
2. Sanity check: `npm run typecheck && npm test` (expect **56 passing**) and
   `node dist/cli/index.js doctor --no-smoke` (expect 3 providers). Green → proceed.
3. Do **T5** exactly as spelled out under "Next action" in STATE.md (engine stage runner +
   RunCtx + quorum/budget/deadline + S1–S3 with §13 idea-refinement prompts). Follow §6 and §9.
   Reuse the T4 pieces: schemas in `src/schemas/index.ts`, `RunWriter` in `src/storage/runs.ts`.
4. When done: update STATE.md ledger + Next action, keep this file current, and STOP before
   committing — the user commits.

Nothing is half-written. Uncommitted diff in the tree = finished T3 + T4 work; don't
re-implement it.

T4 (just finished) added: `src/schemas/index.ts`, `src/storage/runs.ts`, `src/providers/
profiles.json` + `profiles.ts`, `src/cli/providers.ts` (+ index.ts wiring), `test/schemas.test.ts`,
`test/runs.test.ts`, and a `build` copy step for profiles.json. All green; `aiki providers --json`
verified live. Known-trap notes for T5 (RoleOutput discriminator injection; deferred JSON-Schema
export; DisagreementMap shapes to firm at T6/T7) are recorded in STATE.md "Traps".
