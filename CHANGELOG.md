# Changelog

## Unreleased

### Added
- Public URL snapshots for idea prompts, including an npm registry adapter, private-network rejection,
  auditable `FETCHED` / `BLOCKED` / `FAILED` status, and a research-mode gate that stops before model calls
  when a supplied source cannot be read.
- Requested-output planning: prompts that ask for a feature list or implementation plan now carry that
  requirement through the decision contract, the existing planner call, machine JSON, Markdown, and HTML.

### Changed
- **Report v4 answer-first decisions** — reports now lead with the requested deliverables and chair reasoning,
  substitute readable claim labels for internal ids, dedupe and cap claim-named conditions, frame/cap risks,
  summarize each council seat (including a plain-language `weak_seat` warning), and distinguish FACTUAL
  claims from JUDGMENT calls so verification priority and coverage describe checkable facts honestly.
  Deliverable detection now combines model-backed readings with a widened fallback that hears requests for
  standout or "ultra-level" features.
- Explicit research wording selects research mode deterministically when `--mode` is absent; an explicit
  mode remains authoritative. Preflight asks zero to four questions and may not repeat facts already present
  in the user prompt or a fetched source.
- Reader-facing report sections use human claim text instead of internal graph ids such as `G1`; raw ids
  remain in machine artifacts and the Markdown technical audit.

## 0.3.0 — 2026-07-15 — evidence-grounded decision council

This release turns idea refinement into a bounded, evidence-linked decision workflow with explicit modes,
selective rebuttal, a reader-first dossier, and stronger recovery from malformed provider output. The frozen
code-review result remains unchanged: 100% vs 77% seeded-bug recall at equal precision on the pre-registered
10-case holdout. The idea-v3 evaluation harness ships here, but its paid benchmark is still pending and no
idea-quality lift is claimed yet.

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
- **Idea report v3** — idea-refinement reports now emit an explicit BLUF recommendation
  (`PROCEED`, `PROCEED_WITH_CONDITIONS`, `PIVOT`, `STOP`), conditions when needed, a best-effort
  12-dimension scorecard, assumption audit table in HTML, deterministic debate narrative, anchored
  validation plan with kill signals (`09b-action-plan.json`), open questions, red-team note, and a
  call/provider receipt. The Markdown copy button includes the expanded brief.
- **R7 decision dossier** — `10-decision-report.json` now persists the graph-anchored recommendation chain,
  evidence source/date/freshness/verification table, genuine disagreement and append-only position-change
  events, coverage and sensitivity ledgers, executable experiments, strongest counter-case, strictly
  verified unique-provider contributions, categorized receipt, and technical graph fold. Final Markdown,
  HTML, and Copy-Markdown render from that same dossier; R6-era and older runs retain their legacy HTML. It
  provides the canonical report foundation refined by the reader-first snapshot below.
- **Reader-first decision snapshot (report v3.1)** — terminal, Markdown, and HTML lead with the council
  recommendation, independently verified evidence coverage, decisive facts, first action, strongest
  counter-case, and three critical unknowns. Financial and threshold-heavy chairs can emit strict
  graph-anchored decisive numbers, explicit payback, option commitments marked `KNOWN`, `TARGET_CAP`, or
  `UNKNOWN`, and one go/no-go tripwire. Invalid claim anchors remove the snapshot instead of presenting
  unsupported numbers.
- **Idea-v3 benchmark harness** — the frozen B/C/D2/R protocol now has an eight-case build set, a
  12-case/tag/provenance holdout contract that remains closed until freeze, checkpoint/resume for successes
  and failures, isolated baseline-provider campaigns, three independently shuffled blind-rating packets,
  one-pass scoring, and hash-locked freeze and holdout guards. Build tuning, blind ratings, and the paid
  holdout evaluation remain pending.

### Changed
- **Three-level decision report** — idea-refinement's final report is restructured: (1) a one-screen
  terminal summary (recommendation, decision state, verified evidence coverage, decisive result, dissent,
  next action, and optional tripwire) printed after `aiki run`; (2) a 10-section reader-first graph-backed
  Decision Report markdown (`final-report.md`) ordered as decision, action plan, reasoning, what could change
  the decision, evidence, risks/gaps, dissent, council value, run details, and technical audit; (3)
  machine-readable `10-decision-report.json` that Markdown and HTML render from, so the
  surfaces cannot disagree. Statuses are ACCEPTED / ACCEPTED_WITH_CONDITIONS / INCONCLUSIVE / REJECTED
  (mapped from the judge's recommendation). The structural score is moved behind technical detail and never
  presented as decision accuracy: 40% verification coverage + 25%
  independent convergence + 20% evidence quality + 15% stability − critical-risk penalty; model
  self-confidence never enters it and consensus alone can never reach the High band. Labeled a heuristic in
  the report until benchmark-calibrated.
- Idea-refinement estimates are mode-aware: quick ≈3 calls / 1 Claude-Opus; council 6–8 / ~2 Opus; research
  8–10 / ~2 Opus. Chair and planner calls are reserved before optional graph work.
- **Mode-aware time limits** — quick and council retain a 20-minute run deadline; research uses 45 minutes.
  The per-provider-call ceiling is 15 minutes, so legitimate deep scout work can finish while the overall
  deadline still bounds the run.

### Fixed
- Idea analyst outputs now canonicalize observed Gemini evidence-enum variants before strict validation:
  freshness accepts case-insensitive canonical words, while evidence support accepts a leading known token
  (`SUPPORT`, `OPPOSE`, or `OPPOSES`) and maps it to the canonical enum. Arbitrary prose and unknown values
  still fail the schema boundary.
- A failed S4 repair no longer kills the run for recoverable shape damage: deterministic salvage strips
  unknown keys, drops invalid evidence/calculation/coverage/question entries, removes only individually
  invalid positions, and scrubs their references. It never invents content and an empty claim set remains
  fatal. The same fallback applies when the repair call itself dies (for example, quota).
- All schema-validated model stages now attempt lossless coercion before a paid repair (for example, wrapping
  a lone array item) and bounded lossy coercion only after repair failure (for example, truncating beyond a
  declared maximum). The full zod schema still decides whether data may cross the stage boundary.
- Provider timeouts now resolve immediately after killing the process group and unref a surviving detached
  child, preventing one escaped subprocess from blocking the CLI long after the configured timeout.
- Idea prose containing ordinary words such as `class`, `export`, or `import` no longer misroutes to code
  review; routing now requires actual code structure such as a diff, fence, code file path, declaration, or
  import/export syntax.
- Decisive warnings no longer echo an unresolved affirmative claim as reassurance, and the calculation
  checker now canonicalizes ordinary plurals, dimensionless ratios, and currency-margin units without
  weakening arithmetic validation.
- Benchmark safeguards now redact receipt costs and degradation tokens from blind packets, refuse accidental
  same-day campaign overwrites, and honor the frozen baseline provider when a holdout run does not pass an
  explicit override.
- Release builds now clean `dist/` before compiling, so removed stages cannot survive as stale JavaScript in
  the npm tarball.
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
