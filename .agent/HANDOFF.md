# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite this file at each handoff;
keep it current, not cumulative (history lives in `git log`).

---

**Status: CLEAN — VERDICT WRITTEN (2026-07-05). T12 substantively DONE, freeze LIFTED.**
KC#1 ✅ PASS (D 43/43=100% vs B 33/43=77% = 1.30×; precision both 1.00), KC#4 ✅ PASS, KC#2 ⏸ deferred (A2).
Assistant adjudicated all 59 unmatched B+D findings against source → 0 false positives (labels in
`.aiki/feedback.jsonl`, 59 wontfix). RESULTS §1/§4/§5/§6/§7 filled with the verdict + caveats. 161 tests
green, build clean. **Working tree NOT committed — the user commits NOW (RESULTS.md, .aiki/feedback.jsonl,
STATE.md, HANDOFF.md; scratch_* already deleted).**

## Dev round 2 progress (freeze lifted)
1. ✅ **agy `--sandbox` VERIFIED write-safe** (adapter probe 2026-07-05) — PROVIDER_NOTES + STATE updated.
2. ✅ **Arm E BUILT + EVALUATED (build set) + `--cheap` SHIPPED.** D 20/20 vs E 13/16 (81% strict; 01 case
   crashed on codex infra). E's thrift PROVEN: 0.75 claude/case vs D ~2. But 2 of E's 3 misses = category
   artifacts (found the bug, tagged the opposite category) → E true find-rate ~94%, 1 real minor miss.
   Verdict: E fails the strict 90% gate, passes adjusted. Decision: keep D default, ship E as opt-in
   `aiki run code-review --cheap` (run.ts+index.ts, experimental). Full detail + roadmap in STATE.
3. Not started (all optional — thesis proven): S8-teeth fix (cross-exam CONFIRM-only → judge dormant),
   escalation ladder, clean E holdout re-bench, or consolidate/ship (README + verdict). See STATE "What's next".

## Known limitation surfaced (log, don't fix silently)
Category-STRICT matching penalizes defensible category divergence — hit B (holdout) AND E (build), both
times flattering D. It measures "labels bugs like the seed author" as much as "finds them." Any future
E-vs-D holdout should report BOTH strict and category-relaxed (file+line-overlap) recall.

## Uncommitted this round (for the commit)
`src/bench/arms.ts`, `src/bench/results.ts`, `src/bench/harness.ts`, `src/cli/bench.ts`, `src/cli/run.ts`,
`src/cli/index.ts`, `BENCHMARK.md`, `docs/PROVIDER_NOTES.md`, `test/bench-resume.test.ts`,
`.agent/STATE.md`, `.agent/HANDOFF.md`. (RESULTS.md already committed at c926dd4. CLAUDE.md: user-edited,
has a duplicated karpathy block + a stale agy-sandbox line — see chat, cleanup offered not applied.)

## Verdict caveats to carry forward (do not overstate the result)
- Precision was NON-discriminating (bug-dense files → every flag hits something): the win is a RECALL win.
- D-vs-B gap partly from the strict matcher penalizing B's correct-but-mislocated/mis-categorized findings.
- n=10, one run per arm → directional, not statistical. Claim only "beats best single model," not "beats
  self-consistency" (C never run on holdout).

## Stage 0 did (this session, 2026-07-04 late)

1. **Discovered attempt 2:** user re-ran bench after the hardening build → codex CRASHed in case-01 D,
   process hard-killed during case 02 (runs `…2229`/`…2242` have no meta). Its case-02 A/B/C Opus calls
   are burned and unsalvageable (killed before the incremental case write).
2. **Archives:** `bench/results/code-review-2026-07-04.attempt1.void.json` (the 10-case Opus-death run —
   restored VERBATIM from session context after the dated file was overwritten by attempt 2) and
   `…attempt2-partial.void.json`. Both ignored by the date-strict resume matcher.
3. **Salvage (mechanical, Amendment A1.4):** kept a scored pair iff its run meta has ZERO errored calls;
   earliest clean measurement wins on duplicates. **6 pairs kept** → cleaned campaign file
   `bench/results/code-review-2026-07-04.json`: 01 A/B/C/D + 02 A/B. Notable: attempt-1's **02 D was
   dropped** — its meta shows claude CRASHed during that very run (the results JSON hid it).
4. **Amendment A1 written into RESULTS.md §1** (pre-declared before any clean metered call): void
   attempts, robustness changes, salvage rule, noise caveat (case-01 recall flips ±1 bug between
   attempts), Arm A retired from metered runs, staged execution plan. RESULTS.md §3 commands updated.
5. **Harness patch (tested):** narrower `--arms` resume now carries forward prior scored pairs of
   non-requested arms, and incremental writes preserve prior cases not yet reprocessed (mid-run kill
   can't drop paid-for data). `test/bench-resume.test.ts` → 12 tests.

## The user's staged metered pass (no-live-paid-runs; commands in RESULTS.md §3)

1. **Codex health first** — attempt 2 died on codex: `doctor --no-smoke`, then free dry-run
   `bench code-review --arms B,D --set holdout --resume` (prints: 3 kept, 17 pairs, ≈26 Opus).
2. **Stage 1** append `--yes` → KC#1+KC#4 data (≈26 Opus + ≈18 GPT). Same command every quota window.
3. **Stage 2** `--arms B,C,D --set holdout --resume --yes` (≈36 more Opus) → KC#2.
4. FP-label → fill RESULTS §4–§6 → §7 verdict (only after B,C,D × 10 complete).

## Late addition (same session): resolve works for single-call arms now

`aiki resolve` on an A/B bench run said "no findings to annotate" — those arms never wrote a
review-map/judge artifact, so FP labeling (→ precision → KC#1) was impossible for B. Fixed (tooling
only, measurement untouched, 161 tests):
- `src/bench/harness.ts` — after the degradation guard, every scored arm run persists the exact
  scorer-input findings to `raw/bench-findings.json` (= the precision denominator).
- `src/cli/resolve.ts` — CR path falls back to `raw/bench-findings.json` when 07/09 are absent.
- Backfilled the 4 salvaged A/B runs (9d09, 29db, 8ee5, 55dd) by re-running the deterministic
  file:line filter on their 04 artifacts — each derived count verified == the scored `reported`
  before writing. C/D runs (8c4d, cca8) have 07+09, original path works.
- User FP-labels interactively: `node dist/cli/index.js resolve 29db` etc. (needs a real TTY).

## Gotchas

- **Do NOT run bench while an agent session is mid-file-surgery on bench/results/** (attempt 2 collided
  with stage 0 exactly this way).
- Frozen: arms, matcher, `bugs.json`, thresholds, pipeline (src/ stages). Post-eval fix list in STATE.
- agy judge has NEVER fired in bench (0 disputes every case → judge-skip). Expected per T10 design;
  flagged post-eval (S8 never refutes = toothless cross-exam suspicion).
- Salvage script lives in the session scratchpad only (one-shot, not part of the repo).
