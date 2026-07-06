# Changelog

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
