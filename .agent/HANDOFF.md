# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — start next task (T11). T0–T10 all DONE. Nothing half-written.**

T10 (code-review workflow) grilled → design locked → built → tested this session. 136 tests green
(124 + 12 new in `test/t10.test.ts`), typecheck + build clean.

Resume steps for the new session:
1. Read `.agent/STATE.md` (position, ledger, the T10 SHIPPED block + traps). Do NOT re-scan the tree.
2. Sanity check: `npm run typecheck && npm test` (expect **136 passing**) and
   `node dist/cli/index.js doctor --no-smoke` (expect 3/3). Green → proceed to T11.
3. T11 = bench harness + build set (§17): arms A–D runners, seeded-bug matcher, `aiki bench code-review
   --set build`, 5 seeded diffs. The matcher (same file + overlapping lines + same defect class) is
   ALREADY built as `sameFinding` in `src/orchestration/stages/cr-map.ts` — reuse it. Also lands here:
   resolve-CR (fixed/wontfix/false-positive) — needs FeedbackEntry to generalize (item_type
   finding|adjudication, verdict union, ruling→string snapshot).

T10 file map (uncommitted; user commits — do not re-implement):
- NEW: `src/orchestration/git.ts` (repoToplevel/computeDiff three-dot/parseDiffFiles),
  `src/orchestration/stages/cr-s4-review.ts` (`s4Review` + pure `filterValidFindings`/`countLines`),
  `cr-s8-crossexam.ts` (`s8CrossExam` mutual, returns data — does NOT write 08),
  `cr-map.ts` (pure `sameFinding` §487 matcher + `buildReviewMap`),
  `cr-s9-judge.ts` (`s9ReviewJudge`, judge cwd=run-dir), `cr-report.ts` (pure `scoreFindings` +
  `renderReviewReport`), `src/workflows/code-review.ts` (`runCodeReview` + `CR_STAGES`), `test/t10.test.ts`.
- EDITED: `src/schemas/index.ts` (export `Finding`, add `CodeReviewRoleOutputModel`, `ReviewMap`/
  `AnnotatedFinding`/`CrossVerdict`), `src/storage/runs.ts` (`review-map` slot, ord 7),
  `src/orchestration/context.ts` (`resolveRoles` code-review branch: s4=[claude,codex], judge=agy),
  `engine.ts` (WORKFLOWS['code-review']=runCodeReview, `RunOptions.cwd`), `jsonStage.ts` (`jsonCall`
  optional cwd), `cli/run.ts` (diff plumbing + `RunFlags`), `cli/index.ts` (--base/--head/--diff).

Gotchas / open items:
- **Artifact ordering:** review-map (07) is written BEFORE verifications (08) though it's derived from
  the cross-exam — the writer requires ascending ordinals, so `s8CrossExam` returns its data and
  `runCodeReview`'s S7 stage writes 07 then 08. Don't move the 08 write back into S8.
- **Ruling polarity (code-review S9):** UPHOLD = keep the finding (genuine defect), REJECT = drop it
  (false positive). This is the OPPOSITE of idea S9 (where UPHOLD = the attack wins). Both are correct
  for their workflow; the prompts spell it out.
- **agy trap sidestepped:** judge (agy) runs cwd=run-dir, never repo. Do not give agy repo cwd anywhere
  without first verifying its --sandbox.
- Full live `aiki run code-review --base <ref> --head <ref>` is metered → user's manual §605 acceptance
  (cheap sample was provided in chat). Do NOT run it yourself (no-live-paid-runs).
- `.DS_Store` untracked macOS cruft — ignore. graphify-out/ is the knowledge graph (added this session).
