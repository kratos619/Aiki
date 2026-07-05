# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite at each handoff; keep current, not cumulative.

---

**Status: V1 (S8-teeth) CODE-COMPLETE + tests green (uncommitted). Awaiting the USER's one metered bench
run to validate. No half-written code.**

## What was built (2026-07-05, this session)
V1 per `plan/AIKI-v2-plan.md` — give the code-review council teeth so it actually debates. All in
`src/orchestration/stages/cr-s8-crossexam.ts` (touched cr only; idea `s8-verify.ts` untouched; schema
UNCHANGED per plan):
1. **Prompt rework** — the S8 cross-exam prompt now forces an adversarial pass: rank the peer's findings
   weakest-first, actively try to REFUTE the weakest with file:line evidence, REFUTE only with evidence
   else UNCERTAIN with the specific doubt. Kept the phrase `peer cross-examination` (scripted tests route
   on it) and the `VerificationSet` schema.
2. **Rubber-stamp re-ask** — `examine()` now: initial call → if rubber stamp (all CONFIRM + no
   `all_confirmed_justification`) → ONE sharper re-ask (mirrors the S9 retry in `cr-s9-judge.ts` ~62–72;
   the re-ask prompt contains the phrase "rubber stamp"). Accept the re-ask only if it pushed back (a
   REFUTE/UNCERTAIN) or supplied the justification; else keep the original and raise `synthesis_suspect`.
   Returns `{vset, graded, rubberStamp}`; the loop sets the flag off `rubberStamp`.
3. **Tests** — `test/v1-s8-teeth.test.ts` (4, scripted adapters + real RunCtx, NO paid calls): confirm-all
   → re-ask → accepted REFUTE → flows to `ReviewMap.disputed`; confirm-all twice → `synthesis_suspect`;
   genuine pushback first pass → NO re-ask; all-CONFIRM WITH justification → NO re-ask.

## Interpretation logged (the one judgment call)
Plan step 2 names a "ranked-weakest section", but the schema is `.strict()` and the plan says keep it.
Only schema-preserving reading: the weakest-first analysis lives in the existing `all_confirmed_justification`
field, so "no ranked-weakest section" == "all-CONFIRM with no justification". No schema change made.

## Verification done (free, mine)
`npm run typecheck` clean · `npm run build` clean · `npm test` = **167 passed** (163 prior + 4 new). The
t10 e2e `callCount === 5` still holds (re-ask does NOT fire there: claude→codex has a REFUTE; codex→claude
is all-CONFIRM but WITH justification).

## AWAITING THE USER — the metered acceptance (no-live-paid-runs)
Run from the repo root:
```
node dist/cli/index.js bench code-review --arms D --set build --yes
```
(~10 Opus calls.) **PASS iff:** disputes > 0 on ≥2/5 cases AND S9 judge calls appear in the run metas AND
**recall stays 20/20**. **If recall drops below 20/20** the teeth are cutting real findings → revert the
`cr-s8-crossexam.ts` prompt and iterate on the BUILD set (never the holdout — freeze integrity, §18).

## After V1 passes
Do NOT commit (user commits). Then start **V2 — smart entry** (`plan/AIKI-v2-plan.md`): repo detect at TUI
launch, [r]/[b]/[i] quick actions, headless default-base, deterministic input router (NO chat). After V2:
V3 Council View + `show --html` → V4 escalation ladder (uses these teeth) → V5 ship.
