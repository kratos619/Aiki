# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For history: `git log --oneline`. Specs: `plan/AIKI-build-plan.md` (v1 §-refs), `plan/AIKI-v2-plan.md` (v2/v2.1).
Verdict + benchmark: `RESULTS.md`, `BENCHMARK.md` (frozen pre-registration).

## Now (2026-07-08)

- **v1 SHIPPED + thesis PROVEN, committed through `aa173bc`.** T0–T12 done. KC#1 PASS (D 100% vs B 77%
  recall = 1.30×, precision tied 1.00), KC#4 PASS, KC#2 deferred. `--cheap` (Arm E) shipped. agy `--sandbox`
  verified write-safe. Publishable claim (RESULTS §7, never stronger): *"cross-provider structured review
  caught every planted bug where the best single model missed ~1 in 4, at equal precision, on a 10-case
  held-out set."*
- **v2 product round CODE-COMPLETE (uncommitted) — `plan/AIKI-v2-plan.md`.** 207 tests green, build clean.
  - **V1 S8-teeth** (committed `aa173bc`) — code-review cross-exam is adversarial; rubber-stamp → one re-ask.
  - **V2 smart entry** — repo detect, default-base, deterministic input router (`src/tui/smart-entry.ts`).
  - **V3 Council View + `show --html`** — the council HTML is now a plain-language decision brief
    (`src/council/view.ts`); `--html` prints an absolute path + `--open`.
  - **V6 run-anywhere + resilience** — hybrid storage (repo `.aiki` vs `~/.aiki`, `$AIKI_HOME` override,
    `src/storage/paths.ts`); timeouts raised (per-call 180→300s, wall-clock 10→20min); **sessions + resume**
    (`~/.aiki/sessions.jsonl`, `aiki sessions`, `aiki resume <id>` = CALL REPLAY via `src/storage/replay.ts`).
  - **V7 intent clarify** — pick / combine-all / type-your-own; stopword-stripped merge of same-meaning
    readings (`cr-s2`/`cluster.ts`; 0.6 threshold UNCHANGED).
  - **V8 model config** — per-provider `--model` (flags verified via `--help`, PROVIDER_NOTES); layered
    config (global `~/.aiki` + project); `aiki models` (`src/cli/models.ts`).
  - **V9 slash-command home** — TUI opens on `/idea /review /resume /sessions /models /config /help`
    (`parseCommand` in smart-entry.ts); plain text still routes to the idea flow.
  - **V5 ship** — `README.md`, `CHANGELOG.md`, version **0.2.0**, run-cost preview on `aiki run` (`--yes`/
    non-TTY gated).
  - **V4 escalation ladder — STARTED (design + pre-registration + testable core):** Arm L = Arm E (agy+codex
    hunt + claude judge on disputes) **+ a coverage-hole targeted claude hunt**. Pre-registered as
    BENCHMARK.md **amendment L1** (build-set-only, frozen). Pure detector `detectCoverageHoles`/`RISK_DEFS`
    BUILT + tested (`src/orchestration/stages/cr-ladder.ts`, `test/cr-ladder.test.ts`, 7).
- **Skills (role playbooks) — reviewer + judge WIRED, analyst DRAFTED-not-wired, + §19 exfil lint (uncommitted).**
  Mechanism, "add-to" (never replace), role-keyed (provider-agnostic): `src/skills/<workflow>/<role>.md`
  playbooks + `loadSkill` (`src/orchestration/skills.ts`), injected via a `{{SKILL}}` slot at each stage's
  deterministic fill — `buildReviewerPrompt` (`src/workflows/code-review.ts`, filled at S3) and
  `buildJudgePrompt` (`src/orchestration/stages/cr-s9-judge.ts`, filled into `basePrompt`; the re-ask inherits
  it). Build copies `src/skills → dist/skills`. **§19: `loadSkill` now lints every playbook** (`lintSkill`:
  url / upload / send-to / base64-blob) and **rejects a tripped file → falls back to no-skill** (fail-closed,
  never crashes the run). Wired playbooks: `code-review/reviewer.md` (hunt-order + evidence-bar + confidence),
  `code-review/judge.md` (evidence>assertion, UNRESOLVED is rare, real dissent). **Skill absent OR lint-rejected
  → exact pre-skill baseline (zero regression); judge skill only affects the dispute path.** 222 tests green
  (`test/skills.test.ts`, 15).
- **V10 TUI input polish (uncommitted):** live command palette (`filterCommands`: prefix-then-substring,
  bare `/` lists all; ↑↓ select, Tab completes, Enter runs highlighted), near-miss recovery
  (`suggestCommand`, edit-distance ≤2: `/model` → "did you mean /models?"), **confirm gate — plain text
  NEVER starts a paid run directly** (shows the idea + up-to-N-calls line; Enter runs, Esc cancels; fixes
  the "typed `I`, burned a run" incident), richer `/help` (what aiki is + examples) + "new here?" hint.
  Pure logic in `src/tui/smart-entry.ts` (tested, `test/tui.test.ts` +9); wiring in `src/tui/app.tsx`.
  **Manual TUI look/feel check = USER.** NO chat mode — §3/§22 upheld (router explains, doesn't answer).
- **Report v3 plan CODE-COMPLETE (uncommitted) — `plan/AIKI-report-plan.md`.** T-R1–T-R7 implemented:
  `JudgeReport.recommendation` + conditions, `ActionPlan`, S9b validation-planner stage
  (`09b-action-plan.json`, budget skip/fallback flags, planner playbook), scorecard, HTML audit table,
  deterministic debate narrative, open questions, receipt, Copy-Markdown extension, and estimate update
  (idea ≈11 calls / 4 Opus before S0). Old runs without recommendation/plan keep the legacy HTML body. **255 tests
  green, typecheck + build clean.** Live/visual idea run remains USER-metered.
- **Contextual Grill / Intent Preflight CODE-COMPLETE (uncommitted).** Idea-refinement now starts with
  model-backed **S0 Intent preflight** (`src/orchestration/stages/s0-grill.ts`): analyst emits a strict
  `RunBriefDraft` with 3–4 context-specific questions, TUI asks them in the existing bordered-question
  style, answers persist to `00b-run-brief.json`, and downstream S1/S2/S4 consume `inputs/idea-brief.md`
  while raw `inputs/idea.md` stays resume-safe. Headless runs use explicit best-judgment defaults. Estimate
  is now **idea ≈12 calls / 4 Opus**; default budget raised to **13** so S9b still runs with one repair
  cushion. **261 tests green, typecheck + build clean.**
- **Idea analyst skill — DRAFTED, deliberately NOT WIRED** (`src/skills/idea-refinement/analyst.md`, passes the
  lint). Held pending the code-review bench A/B (per user decision "A", and the idea-workflow's own deferral
  note). Wiring is heavier than reviewer/judge — idea's **S3 is a model call** (`s3Prompts` tailors templates),
  so the playbook must be resolved INTO `IDEA_S4_ANALYST_TEMPLATE` **before** S3 (a `buildAnalystTemplate(skill)`
  in `src/workflows/idea-refinement.ts` that fills `{{SKILL}}`, then pass the filled template to `s3Prompts`),
  NOT appended after — else the S3 artifact wouldn't reflect the sent prompt. Remaining candidate: hole-hunter.
- **Next action:** Contextual Grill is done; **finish V4 Arm L wiring** (see `.agent/HANDOFF.md` for the exact spec) — the targeted-hunt
  escalation stage + register Arm L (`ArmId`/`ARM_IDS`/results enums/`VALID_ARMS`/harness) + scripted e2e
  (auth-hole → exactly 1 targeted claude call + merged; covered → 0 hunt calls). Metered comparison run is
  the USER's and is BLOCKED until the V1 bench confirms disputes>0. **If not doing V4, the v2 round is DONE.**
- **Commit:** v1 (`aa173bc`), the v2 product round (`66935c5`), and the V4 detector (`3526eda`) are COMMITTED
  by the user. **NEW uncommitted work = Report v3 implementation + Contextual Grill + docs/tests** (plus prior intended edits). **The user
  commits — never `git commit`/`git push`.**
- **Pending USER (metered/manual — none block committing):** (1) V1 paid bench
  `node dist/cli/index.js bench code-review --arms D --set build --yes` (~10 Opus) → **unblocks V4's metered
  run**; (2) TUI home + `/resume` + clarify screens read well; (3) live `aiki resume`; (4) a run with a pinned
  model (meta.flag_profiles shows it); (5) `show <run> --html --open`; (6) fresh-clone quickstart (V5).
- **In-flight?** No half-written code. Working tree = intended edits only (+ untracked `AGENTS.md` from
  outside these sessions; `.aiki/`, `bench/results/*`, `graphify-out/` are gitignored).

## Task ledger

| Task | Status | Note |
|------|--------|------|
| T0–T12 (v1) | ✅ | Full pipeline + TUI + bench + RESULTS verdict; committed through `aa173bc`. See `git log`. |
| v1 shipped extras | ✅ | agy sandbox verified; Arm E built + build-set-evaluated; `aiki run code-review --cheap`. |
| **V1 S8-teeth** | ✅ | Committed `aa173bc`. Paid-bench validation deferred by user. |
| **V2 smart entry** | ✅ | uncommitted |
| **V3 Council View + `show --html`** (+ readability pass) | ✅ | uncommitted; plain decision-brief HTML |
| **V6 run-anywhere + sessions/resume** | ✅ | uncommitted |
| **V7 intent clarify** | ✅ | uncommitted |
| **V8 per-provider model config** | ✅ | uncommitted |
| **V9 slash-command TUI home** | ✅ | uncommitted |
| **V5 consolidate & ship** | ✅ | README + CHANGELOG + 0.2.0 + run-cost preview; uncommitted |
| **V4 escalation ladder** | 🔶 STARTED | Design + BENCHMARK L1 pre-registration + coverage-hole detector DONE. Remaining: Arm L wiring + scripted e2e; then metered run (BLOCKED on V1 bench). |
| **Skills — reviewer + judge playbooks + §19 lint** | ✅ | `loadSkill`/`lintSkill` + `{{SKILL}}` seam in S4 reviewer + S9 judge; add-to, zero-regression when absent/lint-rejected; 222 tests. Uncommitted. Metered A/B is the USER's. |
| **Skills — idea analyst playbook** | 🔶 DRAFTED | `src/skills/idea-refinement/analyst.md` written + lint-clean, NOT wired (held for the bench). Wiring = `buildAnalystTemplate` fill BEFORE S3 (S3 is a model call). |
| **V10 TUI input polish** | ✅ | Command palette (+Tab cursor-to-end via input remount) + did-you-mean + plain-text confirm gate + richer /help; uncommitted. Visual check = USER. |
| **E2E smoke + README benchmark table** | ✅ | USER ran `bench code-review --arms B,D --set build` live (E2E ✔): B 75% (15/20), D 94% (15/16). D's 02-cart pair ERRORED (both reviewers TIMEOUT ~39min → degradation guard quarantined it, correct). Apples-to-apples on the 4 shared cases = B 88% vs D 94%. Build=tuning set → NOT the README headline; README benchmark table now shows the clean HOLDOUT numbers (100% vs 77%, 1.30×). Optional: `--resume` to complete D/02-cart. |
| **Ship packaging (Gate 4)** | ✅ | LICENSE (MIT, Gaurav Palaspagar), package.json license/author/repo/bugs/homepage/keywords/`files`/`prepublishOnly`; **sourcemap+dts trim (tsconfig declaration/sourceMap→false) → pack 204→74 files, 182→107 kB**; `npm pack --dry-run` verified all runtime assets ship; `aiki --version/--help` run; npm name `aiki` FREE (404). Uncommitted. **Publish = USER (`npm login && npm publish`).** |
| **Report v3 plan** | ✅ | T-R1…T-R7 done: BLUF recommendation enum + conditions, S9b action-planner stage (`ActionPlan`, anchored actions, budget guard/fallback, planner skill), scorecard, audit table + debate narrative + open questions + receipt into HTML, Copy-md extended, estimate/docs updated. 255 tests + typecheck + build green. Live acceptance = USER-metered. |
| **V11 idea-report overhaul** | ✅ | Analyst skill WIRED (`buildAnalystTemplate` before S3) + mandates 12-dim rubric coverage (fewer blind spots); judge now emits **`key_points`** (chairman's bulleted reasoning) + a 2-5 sentence verdict (schema `JudgeReport.key_points?` optional — code-review unaffected); s10 markdown + HTML render it. **New clean HTML** (dropped parchment/serif for system-sans/white) + **Copy report (Markdown) button** (embeds `councilMarkdown`, `<`-escaped) + **"How each model saw it"** surfaced + sticky top bar. **Auto-open in browser on success** (`src/council/open.ts` `openCouncilHtml`; wired in `run` [TTY-gated], TUI finish, `show --open`). 240 tests. Uncommitted. Visual check = USER. |
| **V10.2 scope redirect** | ✅ | `scopeRedirect` (smart-entry.ts): "explore my codebase / what features to add" asks → a scope message (use /review or /idea "<specific>") BEFORE mis-routing into a paid idea-run; genuine ideas untouched. Fixes the "open in folder, ask what to improve → nonsense idea-run" trap. 237 tests. Uncommitted. |
| **V10.1 run-screen life** | ✅ | Spinner on running row, ▰▱ progress bar + n/N, rotating stage phrases (4s cycle, `runningPhrase`), compact 1-line providers, Esc clears home, "adjourned in Xs" + abort resume-hint; pure parts tested (235 total). Uncommitted. Visual check = USER. |
| **Contextual Grill / Intent Preflight** | ✅ | S0 run brief before S1; strict `RunBrief` schemas + `00b-run-brief.json`; TUI asks 3–4 contextual questions, headless defaults, downstream prompts include answers; default budget 13, estimate 12 calls / 4 Opus. 261 tests + typecheck + build green. Uncommitted. |

## Facts already decided (do not re-derive / re-litigate)

- **npm** (not pnpm). Gate = `npm run typecheck` + `npm test`. **Never `git commit`/`git push` — user commits.**
- **Node ≥ 20** (v20.19.3 here). `npm install` needs `--cache <scratchpad>/.npmcache` on this box.
- **Providers (live):** claude 2.1.201, codex 0.142.5, **agy 1.0.16** (Antigravity/Gemini — replaces the
  discontinued gemini CLI). Read-only: claude `--permission-mode plan`, codex `--sandbox read-only`, agy
  `--sandbox` (write-blocking VERIFIED via the adapter path). Model flags (V8, verified): all take
  `--model <id>`; only `agy models` lists. Detail in `docs/PROVIDER_NOTES.md`.
- **Display naming:** id stays `agy` in artifacts/meta/logs; UI shows "Gemini" via `DISPLAY_NAME` (types.ts).
- **Roles (idea-refinement):** analyst=agy, judge=claude (default; authors no S4 → clean adjudication),
  verifier=codex, S4=[agy,codex]. **code-review:** reviewers=[claude,codex], judge=agy. Judge/roles are
  config-overridable (`.aiki/config.json → roles`); `--cheap` swaps CR to agy+codex reviewers + claude judge.
- **Budget default = 13** (`DEFAULT_BUDGET` in context.ts); `--budget`/config override.
- **S6 lexical dedup / S2 clustering: do NOT lower thresholds to force semantic merges** — bag-of-words can't
  separate true merges from false ones; a false merge proceeds on a wrong reading (worse than an extra
  clarification). V7 added stopword stripping only (content-word overlap), threshold still 0.6.
- **v2 decisions:** hybrid storage + per-provider model override (both user-chosen 2026-07-06). **Desktop app
  = NO** (HTML export covers it). **General Q&A / chat = NEVER** (§3/§22 — the router explains, doesn't
  answer). No 4th provider, no learned routing, no write/exec tools.
- **BENCHMARK.md is a FROZEN pre-registration.** Amendments are append-only (E1 = Arm E; **L1 = Arm L ladder**,
  both build-set-only, exploratory, no holdout weight). Arms/matcher/`bugs.json`/thresholds not editable.

## Traps live right now

- **claude 8KB pipe truncation** — capture claude stdout via fd redirect, not a pipe (`spawn.ts`
  captureFull/spawnCapture already do). For any ad-hoc claude/agy capture, redirect to a file.
- **agy blocks on stdin without a TTY** — `agy models` (and `agy -p`) hang unless stdin is closed;
  `cli/models.ts` closes the child's stdin. The adapter path (spawnCapture) already redirects stdin.
- **agy `--sandbox` self-reports "created the file" even when blocked** — trust only the findings text, not
  its file-op claims. Sandbox is reliable ONLY via the adapter (not bare `agy -p`).
- **`doctor` live smoke = paid calls.** Use `aiki doctor --no-smoke` in dev (6h smoke cache exists;
  `--fresh` bypasses).
- **RunWriter is forward-only + rewrite-refusing** — stage artifacts can't be rewritten/out-of-order. This is
  why **resume replays into a FRESH run** (not in-place); `replay.ts` normalizes the run-dir path out of the
  key so a new run-id still matches the cached prompts.
- **Session-registry tests must set `$AIKI_HOME`** to a temp dir (else they write the real `~/.aiki`). Engine
  `run()` records sessions; tests use `executeRun` directly and never touch the registry. `$AIKI_HOME`
  overrides `homeAikiRoot()`.
- **Post-v1 quality debt (do NOT touch mid-V4):** S7 blind-spot keyword matching is coarse (over-reports);
  the S7 semantic-grouping model call is the WORKING fix — don't touch it. `routeInput` CODE_MARKER regex can
  misroute idea prose containing `export`/`class`/`;` to code-review (low-risk, flagged not fixed).

## Map (where things are — go straight there)

- **Providers:** `src/providers/` — types (DISPLAY_NAME, PROVIDER_IDS, FlagProfile.model), spawn, detect,
  probe, adapter-core (extractJson/runAdapter), claude/codex/agy (`buildArgs` add `--model`), adapters, smoke.
- **CLI:** `src/cli/` — index (commander entry; VERSION), doctor, providers, run (estimateRun + confirm),
  show (`--html`/`--open`/root), resolve, config (loadLayeredConfig), **models**, **resume**, **sessions**, bench.
- **Engine:** `src/orchestration/context.ts` (`RunCtx`: budget/deadline/`call()` with replay, `setupProviders`
  (models), `resolveRoles`, `RunEvents`/`ClarifyChoice`, timeouts), `jsonStage.ts`, `cluster.ts` (stopword
  tokenize), `engine.ts` (`executeRun`/`run` + session recording + `RunOptions` runsRoot/replay/providerModels).
  Stages: `stages/s0-grill.ts`, `stages/s1..s10`, `stages/cr-{s4-review,s8-crossexam,map,s9-judge,report}`, **`stages/cr-ladder.ts`**
  (`detectCoverageHoles`/`RISK_DEFS`). Workflows: `workflows/{idea-refinement,code-review}.ts`. git: `git.ts`.
- **Storage:** `src/storage/` — `runs.ts` (RunWriter), `runs-read.ts` (resolveRunId/runDir/listRuns),
  `feedback.ts`, **`paths.ts`** (homeAikiRoot/resolveRunsRoot), **`sessions.ts`** (registry), **`replay.ts`**.
- **Config:** `src/config/config.ts` (`AikiConfig` + `models` + `loadConfig`/`loadLayeredConfig`/`mergeConfig`/
  `effectiveConfig`), `smoke-cache.ts`.
- **Council view:** `src/council/view.ts` (loadCouncilView + renderCouncilHtml + cleanTopic).
- **TUI:** `src/tui/` — `app.tsx` (Ink home + run + S0 grill + clarify + panel), `smart-entry.ts` (routeInput +
  parseCommand + COMMANDS), `timeline.ts`, `format.ts`, `index.ts`.
- **Bench:** `bench/` (sets + results) + `src/bench/` (arms.ts, harness.ts, results.ts). Tests: `test/`.
- **Docs:** `README.md`, `CHANGELOG.md`, `BENCHMARK.md` (frozen), `RESULTS.md`, `docs/{PROVIDER_NOTES,POLICY}.md`.
