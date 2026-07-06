# HANDOFF.md — in-flight transfer notes

Read only when `.agent/STATE.md` says "In-flight? yes". Overwrite at each handoff; keep current, not cumulative.

---

**Status (2026-07-06): v2 product round CODE-COMPLETE (V1–V3, V6–V9, V5 ship). 200 tests green, typecheck +
build clean. No half-written code. Only V4 (escalation ladder) unstarted — BLOCKED on the V1 paid bench.
Everything except V1's committed teeth (`aa173bc`) is UNCOMMITTED — the user commits (draft below).**

## Done this session (V5 — consolidate & ship)
- `README.md` (new) — what aiki is; the EXACT RESULTS §7 verdict verbatim with caveats ("caught every
  planted bug where the best single model missed ~1 in 4, at equal precision, 10-case holdout — nothing
  stronger"); requirements; install (`npm install/build/link`, `bin: aiki`); quickstart with the
  slash-command table; headless `aiki run` equivalents; models; sessions/resume; storage; safety model;
  how-it-works; benchmark links.
- `CHANGELOG.md` (new) — 0.2.0 v2 product round.
- Version 0.1.0 → **0.2.0** (`package.json` + `src/cli/index.ts VERSION`).
- Run-cost preview: `estimateRun(workflow,{cheap})` in `src/cli/run.ts` (pure — idea 10/3, code-review 5/2,
  cheap 5/1) + a confirm gate before `runEngine` (skipped on `--yes` or non-TTY; `--yes` added to the run
  command). `test/run-cost.test.ts` (2). NOTE: the confirm is a thin readline shell (not unit-tested), and
  I did NOT invoke `aiki run` (it would spend real calls — no-live-paid-runs).

## Verification (free)
`npm run typecheck` + `npm run build` clean · `npm test` = **200 passed**. `run --help` shows `--yes`;
top-level `--help` lists sessions/resume/models. Did NOT run any workflow.

## DRAFT COMMIT MESSAGE (user runs this — I do NOT commit)
Stage the feature work (`git add -A`, or exclude `AGENTS.md`/graphify if unwanted) then:

```
feat: v2 product round — council view, run-anywhere, resume, model config, slash-command TUI

Product + UX layer on top of v1 (S8-teeth). Read-only orchestration unchanged: no API keys,
no chat, no write/exec tools (§3/§22). 200 tests green; version 0.1.0 → 0.2.0.

- Council View + HTML export: `aiki show <run> --html [--open]` renders a plain-language
  decision brief (verdict, risks, blind spots, next steps; raw analysis collapsible). Renderer
  only — schemas/artifacts unchanged (src/council/view.ts).
- Slash-command home (TUI): /idea /review /resume /sessions /models /config /help; plain text
  still routes to the idea flow. Deterministic parser, not chat (src/tui/{smart-entry,app}.tsx).
- Run from anywhere: hybrid storage (repo .aiki vs ~/.aiki), $AIKI_HOME override
  (src/storage/paths.ts); per-call timeout 180→300s, wall-clock 10→20min.
- Sessions + resume: ~/.aiki/sessions.jsonl registry; `aiki sessions`; `aiki resume <id>`
  replays completed (provider,prompt) calls so only the failed stage re-runs
  (src/storage/{sessions,replay}.ts, src/cli/{sessions,resume}.ts).
- Intent clarify: pick / combine-all / type-your-own; stopword-stripped merge of same-meaning
  readings (src/orchestration/{stages/s2-misread,cluster}.ts).
- Model config: per-provider --model (flags verified via --help); layered config
  (global ~/.aiki + project); `aiki models` (src/cli/models.ts, src/config/config.ts).
- Ship: README, CHANGELOG, run-cost preview on `aiki run` (--yes/non-TTY gated).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

(Optional split: docs `README.md`+`CHANGELOG.md`+version could be a separate `docs: v2 README + 0.2.0`
commit, but many src files are shared across features so a single feat commit is cleanest.)

## What remains
- **V4 — escalation ladder** (only unstarted item, BLOCKED): deterministic cascade for code-review —
  tier1 agy+codex hunt (as `--cheap`); escalate a Claude call ONLY on (a) a disputed finding or (b) a
  coverage hole (diff touches risk globs/keywords with zero findings in that category → one targeted Claude
  hunt on those hunks). Pre-register as amendment L1 in BENCHMARK.md (build set) BEFORE any metered run;
  report strict AND category-relaxed recall. **HARD PREREQ: the V1 S8-teeth disagreement signal must be
  live (needs the V1 paid bench to confirm disputes>0).** So V4 waits on the user's V1 bench.

## Pending USER (metered/manual) — none block committing
1. V1 paid bench `node dist/cli/index.js bench code-review --arms D --set build --yes` (unblocks V4).
2. Fresh-clone quickstart (V5 acceptance). 3. TUI home + `/…` + clarify screens. 4. Live `aiki resume`.
5. A run with a pinned model. 6. `show <run> --html --open`. Metered runs are the user's (no-live-paid-runs).
