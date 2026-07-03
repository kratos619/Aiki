# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — T0–T8 all DONE, code + LIVE-verified. Nothing half-written. Next task is T9, and
the USER WANTS TO GRILL IT FIRST (invoke the `grilling` skill before writing any T9 code).**

Session just finished: T8 (TUI) built + live-verified, then the S2 tuning debt fixed. 89 tests green.

Resume steps for the new session:
1. Read `.agent/STATE.md` (position, ledger, T6/T7/T8 + S2-fix decisions, traps). Do NOT re-scan the tree.
2. Sanity check: `npm run typecheck && npm test` (expect **89 passing**) and
   `node dist/cli/index.js doctor --no-smoke` (expect 3/3). Green → proceed.
3. **Grill T9, then build it.** The user said "I'll grill T9" — so START by invoking the `grilling`
   skill and interviewing them through the T9 design (see STATE "Next action" for the scope + the open
   design questions already teed up: config schema/precedence, what `show` renders, resolve semantics,
   smoke-cache location). Do NOT jump straight to code. After grilling → lock the design in STATE → build.
   T9 = `aiki show <run>` + role/config overrides (`resolveRoles(overrides?)`/`RunOptions.roleOverrides`
   seam already exists) + `.aiki/config.json` loading + the §8 6h smoke cache. No new pipeline stages.

Uncommitted diff (the whole build so far — T3…T8 + S2 fix; user commits, do not re-implement):
- Full engine + S1–S10 pipeline (`src/orchestration/`, `src/workflows/idea-refinement.ts`, `src/schemas/`).
- TUI (T8, NEW files): `src/tui/{timeline.ts,format.ts,app.tsx,index.ts}`; `cli/index.ts` bare-`aiki`
  → `startTui`. Engine seam: `RunEvents`/`runStage`/`StageInfo` + `RunCtx.events`/`.aborted`; abort
  `signal` threaded ctx→adapter→`spawnCapture` (child-kill); `s2-misread` clarify branch.
- S2 fix (this session): `cluster.ts` clusterInterpretations Jaccard→**overlap-coefficient** (0.6);
  `s2-misread.ts` prompt hardened (stops the meta-misread). Regression test in `cluster.test.ts`.
- Tests (89): `test/{cluster,schemas,providers,runs,adapters,engine,disagreement,synthesis,tui}.test.ts`.

Gotchas / open items for T9+:
- `app.tsx` rendering is NOT unit-tested (only its pure logic) — a render bug would show only in the
  user's manual TUI run. Do NOT launch the TUI or any live run yourself — interactive + metered
  (memory `no-live-paid-runs`); give the user steps + a cheap sample instead.
- Cosmetic-only leftover: an aborted in-flight stage shows ✖ not ⊘ (harmless).
- Remaining low-priority lexical debt: S7 blind-spot keyword matching over-reports. Do NOT touch the
  S7 semantic-grouping model call (that's the working fix).
- `.DS_Store` files are untracked macOS cruft — ignore.
