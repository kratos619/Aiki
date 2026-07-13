# Changelog

## Unreleased

### Added
- **Explicit idea modes and adaptive budgets (R6)** — `aiki run idea-refinement --mode
  quick|council|research` defaults to council without a learned router. Quick is one structured analyst and
  never presents itself as a council; council uses a 6-call base with at most two graph-triggered extras;
  research permits up to four extras and enables the verified `codex --search exec ...` capability only on
  Codex scout calls while retaining `-s read-only`. Mode-aware defaults are 4/10/12 calls respectively.
- **Two-view decision preflight (R6)** — two readings run in parallel and deterministically merge into one
  user-confirmed or visibly headless/defaulted decision contract. The old S1/S2/S3 model calls are gone;
  analyst prompts are filled deterministically. Receipts split calls into discovery, verification, repair,
  and planning, and resume preserves the original mode.
- **Evidence and calculation integrity (R4)** — idea runs accept `--evidence <file|directory>` and persist
  only source paths + SHA-256 hashes; evidence cards enforce source/freshness rules; derived numeric claims
  can carry a pure arithmetic ledger whose values/units are recomputed; S8 emits typed claim verification;
  and invalid evidence references are rejected before the chair call.
- **Selective rebuttal and evidence-linked chair (R5)** — only verdict-flipping graph nodes enter one
  anonymous rebuttal round; council coverage-fill and rebuttal share a two-call cap while chair/planner
  budget stays reserved; responses append as immutable `08b-rebuttals.json` events; and the chair must emit
  graph-linked rulings, recommendation reasons, conditions, pivots, and strongest counter-cases. A judge-
  authored node is excluded before the chair prompt and remains unresolved under degradation.
- **Startup preflight** — typing bare `aiki` now runs the full doctor before the home screen: per-provider
  progress rows checking CLI presence, version, and auth/quota (smoke, cached 6h). Fewer than 2 providers
  ready shows a failure screen with the exact fix per provider; a single degraded provider shows a warning
  on the home screen and the council continues with the remaining quorum.
- **Idea-lane bench resume** — `aiki bench idea-refinement --set build --resume [--yes]` continues the
  latest campaign file in `bench/results/`: completed case×rotation pairs are kept (never re-paid), missing
  or failed pairs re-run, and new observations append to the same file. The dry-run estimate reflects only
  what is left to run. `--case <id>` restricts the metered run to one build case (an unknown id fails loud
  with the list of valid cases), and a run that completes `low_diversity` (a scout seat died mid-run) is
  rejected instead of being recorded — it is not a valid rotation sample.
- **Adjudication import** — `aiki bench idea-refinement --import <file>` (offline, no provider calls)
  imports blind adjudications: each `{ case_id, rotation, adjudication }` entry flows through the frozen R0
  scorer and fills that pair's null recall/precision in the campaign file. Unknown pairs fail loud;
  re-scoring an already-scored pair is refused (blind adjudication is one pass); when every pair is scored
  it prints the lane default selection.
- **Contextual intent questions** — the merged idea preflight generates 3-4 context-specific questions, the
  TUI asks them before the main work, and answers persist in `00b-run-brief.json`.
- **Idea report v3** — idea-refinement reports now emit an explicit BLUF recommendation
  (`PROCEED`, `PROCEED_WITH_CONDITIONS`, `PIVOT`, `STOP`), conditions when needed, a best-effort
  12-dimension scorecard, assumption audit table in HTML, deterministic debate narrative, anchored
  validation plan with kill signals (`09b-action-plan.json`), open questions, red-team note, and a
  call/provider receipt. The Markdown copy button includes the expanded brief.

### Changed
- **Three-level decision report** — idea-refinement's final report is restructured: (1) a one-screen
  terminal summary (verdict, status, structural confidence, consensus counts, primary reason, dissent,
  verification checks, next action) printed after `aiki run`; (2) a 12-section Multi-Model Decision Report
  markdown (`final-report.md`): metadata, executive verdict, problem interpretation, per-model positions,
  claim-level consensus map, key agreements/disagreements, minority report, verification results, final
  synthesis, risks, audit; (3) machine-readable `10-decision-report.json` the markdown is rendered from, so
  the two can never disagree. Statuses are ACCEPTED / ACCEPTED_WITH_CONDITIONS / INCONCLUSIVE / REJECTED
  (mapped from the judge's recommendation). Confidence is structural — 40% verification coverage + 25%
  independent convergence + 20% evidence quality + 15% stability − critical-risk penalty; model
  self-confidence never enters it and consensus alone can never reach the High band. Labeled a heuristic in
  the report until benchmark-calibrated.
- Idea-refinement estimates are mode-aware: quick ≈3 calls / 1 Claude-Opus; council 6–8 / ~2 Opus; research
  8–10 / ~2 Opus. Chair and planner calls are reserved before optional graph work.

### Fixed
- Idea analyst outputs now canonicalize the observed Gemini evidence enum aliases before strict validation:
  any casing of the exact enum word (`SUPPORT`, `current`, `Current`) maps to the canonical value, while
  prose or unknown values still fail the schema boundary.
- A failed S4 repair no longer kills the run when the damage is limited to evidence cards: a deterministic
  salvage drops the still-invalid cards and scrubs their references (positions are never altered — a broken
  claim set stays fatal). Applies both when the repair output fails validation and when the repair call
  itself dies (e.g. quota), and costs no extra provider call.
- Codex provider smoke no longer crashes in non-git folders; Aiki now passes Codex's verified
  `--skip-git-repo-check` flag while keeping `-s read-only`.
- `aiki --version` now reads from `package.json`, preventing CLI/package version drift.

## 0.2.0 — 2026-07-06 — v2 product round

### Added
- **Council View + HTML export** — `aiki show <run> --html [--open]` renders a plain-language decision
  brief (verdict, risks that held up, blind spots, recommended next steps; raw per-model analysis in a
  collapsible section). Renderer-only; artifacts/schemas unchanged.
- **Slash-command home screen** — the TUI opens on a command home: `/idea <text>`, `/review [--branch]`,
  `/resume <id>`, `/sessions`, `/models`, `/config`, `/help`. Plain (non-slash) text still routes to the
  idea flow, or is redirected if it's a general question / code paste. It's a fixed parser, not chat.
- **Run from anywhere** — hybrid storage: runs live in the project's `.aiki/` when inside a git repo, else
  in `~/.aiki/`. `$AIKI_HOME` overrides the global home.
- **Sessions + resume** — global registry (`~/.aiki/sessions.jsonl`); `aiki sessions` lists runs across
  locations; `aiki resume <id>` (or `/resume`) continues a killed/timed-out run by **replaying** every
  completed provider call from disk, so only the failed stage onward spends a real call.
- **Per-provider models** — `aiki models` (Gemini enumerates via `agy models`; Claude/Codex take any id).
  Pin a model per provider in `.aiki/config.json` or global `~/.aiki/config.json`. No hardcoded versions.
- **Richer intent clarify** — the misunderstanding guard now offers pick-one / combine-all / type-your-own,
  and merges same-meaning readings more reliably (stopword-stripped content overlap; threshold unchanged).
- **Run-cost preview** — `aiki run` prints a call estimate and confirms before spending (skip with `--yes`
  or in a non-interactive shell).

### Changed
- Per-call timeout 180→300s and wall-clock deadline 10→20min (a real Opus judge exceeded both).
- Config is now layered: global `~/.aiki/config.json` (base) + project `.aiki/config.json` (override);
  `aiki config` shows the merged effective config.

### Safety (unchanged)
- Read-only orchestration, no credential handling, no API keys, no write/exec tools, no chat. aiki writes
  only under `.aiki/` / `~/.aiki/`.

## 0.1.0 — v1

- Local multi-model orchestration binding installed AI CLIs into schema-validated workflows
  (idea-refinement + code-review) with a pre-registered benchmark harness. Thesis proven (RESULTS.md):
  cross-provider structured review caught every planted bug where the best single model missed ~1 in 4, at
  equal precision, on a 10-case held-out set.
