# HANDOFF.md — in-flight transfer notes

Overwrite at each handoff; keep current, not cumulative. Read after `.agent/STATE.md`.

---

**Status (2026-07-06):** v2 product round CODE-COMPLETE (V1–V3, V5–V9); **V4 escalation ladder STARTED**
(design + BENCHMARK.md L1 pre-registration + the pure coverage-hole detector — done + tested). **207 tests
green, typecheck + build clean. No half-written code.** Everything except V1's committed teeth (`aa173bc`)
is UNCOMMITTED — the user commits (draft below).

## Fresh-session orientation (30s)
1. Read `.agent/STATE.md` (done if you're here).
2. Sanity-check: `npm run typecheck && npm test` → should be **207 green**; `npm run build` clean.
3. Then either: **(A)** finish V4 Arm L wiring (spec below), or **(B)** stop — the v2 round is otherwise
   complete and waiting on the user's commit + metered validations.

## The commit (USER runs — never `git commit` yourself)
Stage the work (`git add -A`, or exclude `AGENTS.md`/`graphify-out` if unwanted) then:

```
git commit -F- <<'MSG'
feat: v2 product round — council view, run-anywhere, resume, model config, slash-command TUI

Product + UX layer on top of v1 (S8-teeth). Read-only orchestration unchanged: no API keys,
no chat, no write/exec tools. 207 tests green; version 0.1.0 -> 0.2.0.

- Council View + HTML export: `aiki show <run> --html [--open]` renders a plain-language
  decision brief (verdict, risks, blind spots, next steps; raw analysis collapsible).
- Slash-command home (TUI): /idea /review /resume /sessions /models /config /help; plain text
  still routes to the idea flow. Deterministic parser, not chat.
- Run from anywhere: hybrid storage (repo .aiki vs ~/.aiki), $AIKI_HOME; timeouts 300s/20min.
- Sessions + resume: ~/.aiki/sessions.jsonl registry; `aiki resume <id>` replays completed
  calls so only the failed stage re-runs.
- Intent clarify: pick / combine-all / type-your-own; smarter same-meaning merge.
- Model config: per-provider --model (flags verified via --help); layered config; `aiki models`.
- Ship: README, CHANGELOG, run-cost preview on `aiki run`.
- V4 ladder (design only): coverage-hole detector + BENCHMARK.md L1 pre-registration.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```

## NEXT TASK — finish V4 Arm L wiring (scripted-testable; the METERED run waits on the V1 bench)
Design is FROZEN in BENCHMARK.md **amendment L1**. Arm L = Arm E (agy+codex hunt + claude judge on
disputes) **+ a coverage-hole targeted claude hunt**. The pure detector is already built:
`detectCoverageHoles(diff, findings)` + `RISK_DEFS` in `src/orchestration/stages/cr-ladder.ts` (tested,
`test/cr-ladder.test.ts`, 7). Remaining:

1. **Targeted-hunt escalation stage** (behind a ladder flag so D/E are unchanged): after `buildReviewMap`
   in the code-review workflow, run `detectCoverageHoles(diff, keptFindings)`; for each hole, ONE claude
   review scoped to `hole.files` (reuse the S4 reviewer prompt/schema with the diff filtered to those files,
   cwd = repo root), file:line-validate the new findings (`filterValidFindings`), merge into the
   ReviewMap.single_reviewer / kept set before the report. Fire the claude hunt ONLY when a hole exists.
   Thread a `ladder?: boolean` through `runCodeReview` (RunOptions or a workflow variant).
2. **Register Arm L** — mirror how Arm E was added: `ArmId`+`ARM_IDS`+`ARMS` (`src/bench/arms.ts`), the 3
   results enums (`src/bench/results.ts`), `VALID_ARMS` (`src/cli/bench.ts`), and harness role-injection +
   ladder-flag for L (`src/bench/harness.ts`: armAvailable L = agy+codex+claude, roles {s4:[agy,codex],
   judge:claude} + ladder on, CLAUDE_CALLS/case estimate).
3. **Scripted e2e** (no paid calls; model on `test/t11.test.ts` bench e2e + `test/t10.test.ts` cr adapters):
   (a) a diff with an auth hole + tier-1 emits no SECURITY finding → EXACTLY 1 targeted claude call, its
   finding merged + scored; (b) a diff fully covered by tier-1 → 0 targeted-hunt calls (judge fires only on
   a dispute).
4. **Then USER (metered, BLOCKED until the V1 bench confirms disputes>0):**
   `node dist/cli/index.js bench code-review --arms D,L --set build --yes`. Report strict AND
   category-relaxed recall (per L1).

**HARD PREREQ:** the ladder's dispute-trigger (a) only fires if S8 cross-exam produces disputes (V1
S8-teeth). If the V1 bench shows disputes ≡ 0 on the build set, L1 is INVALID — don't run it.

## Pending USER (metered/manual — none block committing)
1. **V1 paid bench** `node dist/cli/index.js bench code-review --arms D --set build --yes` (~10 Opus) →
   expect disputes>0 on ≥2/5 cases + S9 judge calls; recall stays 20/20. **Unblocks V4's metered run.**
2. TUI: home screen + `/idea` `/review` `/resume` + the clarify screen (both / type-your-own) render well.
3. Live `aiki resume` (kill a run → `aiki sessions` → `aiki resume <id>`, or `/resume` in the TUI).
4. A run with a pinned model (`.aiki/config.json → models`), confirm `meta.flag_profiles` shows it.
5. `aiki show <run> --html --open`. 6. Fresh-clone quickstart (V5 acceptance).

Metered runs are the USER's (no-live-paid-runs). Do NOT commit or push.
