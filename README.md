# aiki

A local **model council** for judgment work — code review and idea stress-testing — that drives the AI
CLIs you already have installed and logged in (Claude Code, Codex, Antigravity/Gemini). It runs them as a
panel that can genuinely **disagree**, then adjudicates and hands you a decision brief.

aiki is **not** a general assistant. Trivia and chat get routed away, not answered — a council adds cost,
not accuracy, when there's one right answer.

## Why

On a code review or an "is this idea sound?" call, a single model has one blind spot. Two or three
different models, each reviewing independently and then cross-examining, catch what any one misses. aiki
orchestrates that locally: no API keys, no new subscriptions — it uses the CLIs and logins you already pay
for, so you stop copy-pasting between them by hand.

## What the benchmark actually shows

On a pre-registered, 10-case held-out code-review benchmark (see [BENCHMARK.md](BENCHMARK.md) and
[RESULTS.md](RESULTS.md)):

> **cross-provider structured review caught every planted bug where the best single model missed ~1 in 4,
> at equal precision, on a 10-case held-out set.**

Nothing stronger. Honest caveats, in full: the win is a **recall** win (precision was non-discriminating on
this bug-dense set); it is **not** a claim of beating cheap self-consistency (that comparison is deferred,
not evaluated); n=10, single run per arm — directional, not a p-value. Details in RESULTS.md §7.

## Requirements

- **Node ≥ 20**
- The provider CLIs installed and **already authenticated** (aiki never handles your credentials):
  - `claude` (Claude Code) · `codex` · `agy` (Antigravity, shown as "Gemini")
- At least 2 of the 3 must be ready (`aiki doctor`).

## Install

```bash
npm install
npm run build
npm link          # puts `aiki` on your PATH  (or just run: node dist/cli/index.js)
```

## Quickstart

```bash
aiki              # opens the home screen
```

Then type a command, or just describe your idea and press Enter:

| Command | What it does |
|---|---|
| `/idea <text>` | stress-test an idea with the council |
| `/review [--branch]` | review your working-tree changes (or the branch vs its base) |
| `/resume <id>` | continue a killed/timed-out run — replays finished work, only redoes the rest |
| `/sessions` | list past runs (newest first) |
| `/models` | show / choose the model each provider uses |
| `/config` | show the effective config |
| `/help` | the command list |

Headless (scriptable) equivalents:

```bash
aiki run idea-refinement "a fridge-photo-to-recipe app for busy people"
aiki run idea-refinement ./idea.md
aiki run code-review --base main            # review this branch vs main
aiki run code-review --diff ./changes.patch
aiki run code-review --cheap                # Gemini+Codex review, Claude judges only disputes (~⅓ the Opus)
aiki show <run-id> --html --open            # open the shareable decision brief in a browser
```

`aiki run` shows a run-cost estimate and asks to confirm (skip with `--yes` or in a non-interactive shell).

## Choosing models

Each provider runs its own model families; pick one per provider — no versions are hardcoded, so a new
model works the day it ships.

```bash
aiki models       # lists what each CLI offers (Gemini enumerates; Claude/Codex take any id you type)
```

Set them in `.aiki/config.json` (this project) or `~/.aiki/config.json` (global default, overridden per
project):

```json
{ "models": { "agy": "Gemini 3.1 Pro (High)", "claude": "opus", "codex": "gpt-5-codex" } }
```

The same file pins **roles** (which provider judges, which review) and `budget`:

```json
{ "roles": { "judge": "claude" }, "budget": 12 }
```

## Sessions & resume

Every run is recorded in a global registry (`~/.aiki/sessions.jsonl`), so you can find and continue runs
from anywhere:

```bash
aiki sessions             # all runs, newest first, resumable ones flagged
aiki resume <session-id>  # continue a killed/timed-out run (or /resume in the TUI)
```

Resume re-runs the pipeline but **replays** every step that already finished (from the saved outputs on
disk), so only the failed step onward spends a real model call.

## Where files live

- Inside a git repo → the project's `.aiki/` (runs stay with the project).
- Anywhere else → `~/.aiki/`. `$AIKI_HOME` overrides the global home.
- The global session registry always lives in `~/.aiki/`.

## Safety model

- **Read-only orchestration.** Providers run with their read-only flags (`claude --permission-mode plan`,
  `codex --sandbox read-only`, `agy --sandbox`). aiki never uses `--dangerously-skip-permissions` or edit/
  exec modes.
- **No credentials.** aiki never reads credential dirs and filters `KEY|TOKEN|SECRET` from the environment
  before spawning a provider.
- **Writes only under `.aiki/` / `~/.aiki/`.** Nothing else on your disk is touched.
- **No API keys, no chat UI, no write/exec tools, no "learned" routing** — by design.

## How it works

Every stage's output is zod-validated before the next stage sees it — free-form prose never crosses a stage
boundary. A run leaves a full audit trail (each stage's prompt + raw output + the intermediate artifacts)
under its run directory.

- **idea-refinement:** intent contract → misunderstanding guard (you resolve any ambiguity) → parallel
  analysis → disagreement map → verifier → judge → decision brief.
- **code-review:** parallel blind review → file:line validation → mutual adversarial cross-examination →
  consensus/dispute map → judge adjudicates disputes → report.

## License

MIT — see [LICENSE](LICENSE). Analysis, not advice — verify before acting.
