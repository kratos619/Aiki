# HANDOFF.md — in-flight transfer notes

Overwrite at each handoff; keep current, not cumulative. Read after `.agent/STATE.md`.

---

**Status (2026-07-06):** v1 + v2 product round + V4 detector are COMMITTED (`aa173bc`, `66935c5`, `3526eda`).
**NEW this session (uncommitted, CLEAN — not half-done): skills mechanism + reviewer & judge playbooks +
§19 exfil lint; idea analyst playbook DRAFTED but NOT wired.** Add-to, role-keyed:
`src/skills/<workflow>/<role>.md` + `loadSkill` (`src/orchestration/skills.ts`) → `{{SKILL}}` slot filled by
`buildReviewerPrompt` (`src/workflows/code-review.ts`, S4) and `buildJudgePrompt`
(`src/orchestration/stages/cr-s9-judge.ts`, S9 basePrompt — the re-ask inherits it); build copies
`src/skills → dist/skills`; wired playbooks `code-review/{reviewer,judge}.md`. **§19: `loadSkill` lints each
playbook (`lintSkill`: url/upload/send-to/base64) and rejects a tripped file → no-skill fallback (fail-closed).**
Skill absent OR lint-rejected → exact baseline (zero regression); judge skill affects only the dispute path.
`src/skills/idea-refinement/analyst.md` is now WIRED (user directed, 2026-07-07) — `buildAnalystTemplate` fills
`{{SKILL}}` in `IDEA_S4_ANALYST_TEMPLATE` BEFORE S3; playbook now mandates 12-dim rubric coverage. Idea-report
overhaul (V11): judge `key_points` (chairman reasoning, optional schema field), fuller verdict, new clean HTML
(system-sans/white, not parchment/serif) + Copy-Markdown button (`councilMarkdown`) + surfaced "How each model
saw it", and AUTO-OPEN on run success (`src/council/open.ts`; TUI + `run` TTY-gated + `show --open`). NOTE: the
2026-07-05 example run predates `key_points`, so its HTML has no "Chairman's reasoning" — only a FRESH run shows it.

**ALSO NEW: V10 TUI input polish** (user feedback round 2026-07-07): live command palette
(`filterCommands`/`suggestCommand` in `src/tui/smart-entry.ts` — pure + tested; wiring in `src/tui/app.tsx`),
"did you mean /models?" on near-misses, **confirm gate: plain text shows a run-preview box (Enter run / Esc
cancel) instead of instantly spending calls**, richer `/help` + "new here?" hint. NO chat mode (§3/§22 —
user asked, pushed back, user approved the compliant version). **ALSO NEW: V10.1 run-screen life** (`src/tui/timeline.ts` pure: `runningPhrase` 4s-rotating stage phrases,
`progressBar` ▰▱ + n/N, `totalElapsed`; `src/tui/app.tsx`: Spinner on the running row, compact 1-line
provider strip, Esc clears home screen, success line "· council adjourned in Xs", abort screen shows
`aiki resume <id>` free-replay hint). Tab-complete now remounts TextInput (`inputEpoch` key) so the cursor
lands after "/command " — ink-text-input only end-positions the cursor on mount.

**Manual TUI look/feel check = USER**
(`node dist/cli/index.js`: type `/`, `/mo`+Tab+keep typing, `/model`+Enter, plain text → confirm box → Esc;
then a real run to see the spinner/progress/phrases screen).
**235 tests green, typecheck + build clean.** The user commits.

**ALSO NEW: Ship packaging (Gate 4).** `LICENSE` (MIT © 2026 Gaurav Palaspagar — DEFAULTS, user did not
confirm license type / copyright holder; both trivially changeable pre-publish). `package.json` gained
`license`/`author`/`repository`/`bugs`/`homepage`/`keywords`/`files:["dist",README,CHANGELOG,LICENSE]`/
`prepublishOnly:"build && typecheck && test"`. README license line → MIT. Verified: `npm pack --dry-run`
ships all runtime assets (dist/skills/*.md, dist/providers/profiles.json, LICENSE/README/CHANGELOG),
`node dist/cli/index.js --version|--help` run non-interactively, npm name `aiki` is FREE (registry 404).
Sourcemap trim DONE (user asked): `tsconfig` `declaration`/`sourceMap` → false; clean rebuild (`rm -rf dist`
needed — tsc doesn't purge stale emit) → pack 204→74 files, 182→107 kB, 0 map/dts. **Publish is the USER's:
`npm login` then `npm publish` (a new public package — irreversible name claim).**

## Wiring the idea analyst later (when the bench validates the pattern) — NOT the reviewer/judge recipe
Idea's S3 (`s3Prompts`) is a MODEL call that tailors the templates, and it errors on any unresolved `{{...}}`.
So do NOT add a raw `{{SKILL}}` slot to the `slots` map (the model may fumble it) and do NOT append after S3
(the persisted `03-prompts/analyst.md` artifact would then not match what S4 received). Instead: add a
`buildAnalystTemplate(skill)` in `src/workflows/idea-refinement.ts` that resolves `{{SKILL}}` in
`IDEA_S4_ANALYST_TEMPLATE` (place the slot after `{{INPUT_PATH}}`, before "Produce ONLY JSON"), then pass the
already-skill-filled template into `s3Prompts({ templates: { analyst: buildAnalystTemplate(loadSkill('idea-refinement','analyst')) }, ... })`. S3's deterministic fallback preserves it verbatim; the model is told to keep
template rules intact. Add tests mirroring `buildReviewerPrompt`.

**USER — eyeball + optional metered A/B (no-live-paid-runs; both are yours to run):**
1. Cheap, FREE: the assembled reviewer prompt now carries the playbook (see it via
   `node -e "import('./dist/workflows/code-review.js').then(m=>console.log(m.buildReviewerPrompt('X', require('fs').readFileSync('dist/skills/code-review/reviewer.md','utf8').trim())))"`).
2. Metered A/B (isolates the skills' effect — same arm, prompt is the only change):
   - Skill OFF: `rm dist/skills/code-review/*.md` (or one file to isolate a single skill) →
     `node dist/cli/index.js bench code-review --arms D --set build --yes` → record recall/precision.
   - Skill ON: `npm run build` (restores them) → rerun the same bench → compare. Lift = the skills' value.
   - NOTE the judge skill only changes runs that produce disputes; on zero-dispute cases it's a no-op.

**V4 remains the open in-flight item** (spec unchanged, below) — do it, the skills A/B, and the commit
in whatever order you prefer; they're independent.

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
