<p align="center">
  <img src="docs/One.png" alt="aiki — a local model council" width="820">
</p>

<h1 align="center">aiki</h1>

<p align="center"><em>A local <strong>model council</strong> for code review and idea stress-testing — driven by the AI CLIs you already have.</em></p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node ≥ 20" src="https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg">
  <img alt="Local-first, no API keys" src="https://img.shields.io/badge/local--first-no%20API%20keys-informational.svg">
  <img alt="Read-only orchestration" src="https://img.shields.io/badge/orchestration-read--only-success.svg">
  <img alt="Tests" src="https://img.shields.io/badge/tests-261%20passing-success.svg">
</p>

---

**aiki** runs the AI coding CLIs you already have installed and logged in (Claude Code, Codex, Antigravity/Gemini)
as a **panel that can genuinely disagree** — they review independently, cross-examine each other, a judge
adjudicates the disputes, and you get a clear decision brief.

It does two jobs, well:

- **Code review** — catch the bugs a single model misses.
- **Idea stress-testing** — pressure-test a plan before you build it.

aiki is **not** a general assistant. Trivia and chat are routed away, not answered — a council adds cost, not
accuracy, when there's one right answer.

**Jump to:** [Why](#why) · [Benchmark](#benchmark) · [Requirements](#requirements) · [Install](#install) · [Quickstart](#quickstart) · [The two workflows](#the-two-workflows) · [Example](#example-a-real-idea-run) · [Configuration](#configuration) · [Sessions & resume](#sessions--resume) · [Safety](#safety-model) · [Costs & limits](#costs--limits) · [How it works](#how-it-works)

---

## Why

On a code review or an "is this idea sound?" call, a single model has one blind spot. Two or three *different*
models — each analyzing independently, then cross-examining — catch what any one misses. aiki orchestrates
that locally: **no API keys, no new subscriptions**. It uses the CLIs and logins you already pay for, so you
stop copy-pasting between them by hand.

<p align="center">
  <img src="docs/Three.png" alt="One model's field of view lets bugs slip past; three overlapping fields catch them all" width="820">
</p>

## Benchmark

On a **pre-registered, 10-case held-out** code-review benchmark (frozen before the run so it couldn't be
tuned post-hoc — see [BENCHMARK.md](BENCHMARK.md) and [RESULTS.md](RESULTS.md)):

> **The cross-provider council caught _every_ planted bug where the best single model missed ~1 in 4 — at
> equal precision, zero false positives.**

| Arm | What it is | Seeded-bug recall | Precision | Provider calls |
|---|---|---|---|---|
| **B** | best single model — structured, self-adversarial review | 77% (33/43) | 1.00 | 10 |
| **D** | **cross-provider council** — Claude + Codex review, Gemini judges | **100% (43/43)** | **1.00** | 44 |

**→ 1.30× the recall at identical precision** (0 false positives across 59 adjudicated unmatched findings).

<details>
<summary><strong>Per-case results (every case, no cherry-picking)</strong></summary>

| Case | Seeded bugs | B (single) | D (council) |
|---|---|---|---|
| 01 payments | 4 | 4/4 | 4/4 |
| 02 inventory | 4 | 4/4 | 4/4 |
| 03 comments | 4 | **1/4** | 4/4 |
| 04 search | 5 | **2/5** | 5/5 |
| 05 notifications | 4 | **2/4** | 4/4 |
| 06 profile | 4 | 4/4 | 4/4 |
| 07 dashboard | 5 | **3/5** | 5/5 |
| 08 upload | 4 | 4/4 | 4/4 |
| 09 sessions | 4 | 4/4 | 4/4 |
| 10 analytics | 5 | 5/5 | 5/5 |
| **Total** | **43** | **33/43 (77%)** | **43/43 (100%)** |

The single model's misses cluster on 4 cases (03/04/05/07); the council caught all of them.
</details>

**Reproduce it yourself:** `aiki bench code-review --arms B,D --set holdout --yes`

**Honest caveats (in full).** The win is a **recall** win — precision was non-discriminating on this bug-dense
set. It is **not** a claim of beating cheap self-consistency (that comparison is deferred, not evaluated).
n = 10 cases, single run per arm — directional, not a p-value. Full method and every number in
[RESULTS.md §7](RESULTS.md).

## Requirements

> ⚠️ **aiki drives your existing CLIs — it does not ship or host any model.** You must have the provider CLIs
> **installed and already logged in.** aiki never sees, stores, or transmits your credentials.

- **Node ≥ 20.** (Node 16/18 will crash at startup — this is a hard requirement.)
- **macOS or Linux** (WSL2 works).
- The provider CLIs on your `PATH`, **each already authenticated**:
  | CLI | Command | Shown in aiki as |
  |---|---|---|
  | Claude Code | `claude` | Claude |
  | Codex | `codex` | Codex |
  | Antigravity | `agy` | Gemini |
- **At least 2 of the 3** must be ready (a council needs a panel). Check anytime with `aiki doctor`.

```bash
aiki doctor          # lists each provider: version, ready/not, read-only mode
```

## Install

```bash
git clone https://github.com/kratos619/Aiki.git
cd Aiki
npm install
npm run build
npm link             # puts `aiki` on your PATH   (or run directly: node dist/cli/index.js)
```

## Quickstart

```bash
aiki                 # opens the interactive home screen
```

Type a command, or just describe an idea and press Enter:

| Command | What it does |
|---|---|
| `/idea <text>` | stress-test an idea with the council |
| `/review [--branch]` | review your working-tree changes (or this branch vs its base) |
| `/resume <id>` | continue a killed/timed-out run — replays finished work, only redoes the rest |
| `/sessions` | list past runs (newest first) |
| `/models` | show / choose the model each provider uses |
| `/config` | show the effective config |
| `/help` | the command list |

The command palette filters as you type (`/mo` → `/models`); **Tab** completes, **↑/↓** pick, **Enter** runs.
Plain text is never charged silently — you get a confirm step before any run spends model calls.

**Headless (scriptable):**

```bash
aiki run idea-refinement "a fridge-photo-to-recipe app for busy parents"
aiki run idea-refinement ./idea.md
aiki run code-review --base main             # review this branch vs main
aiki run code-review --diff ./changes.patch  # review a patch file
aiki run code-review --cheap                 # Gemini+Codex review, Claude judges only disputes (~⅓ the Opus)
aiki show <run-id> --html --open             # open the shareable decision brief in your browser
```

An idea run **auto-opens** its report in your browser when it finishes.

## The two workflows

<p align="center">
  <img src="docs/Four.png" alt="Three reviewers → cross-examination → a judge → a decision brief" width="820">
</p>

**Code review** — parallel blind review → deterministic file:line validation (every finding must point at a
real line in the diff) → mutual adversarial cross-examination → consensus/dispute map → the judge adjudicates
only the disputes → report.

**Idea refinement** — a contextual preflight (a few sharp questions to pin down what you actually mean) →
intent contract → misunderstanding guard → parallel adversarial analysis → disagreement map → verifier →
judge → a validation planner. The report is a **decision brief**, not an essay:

- a **BLUF recommendation** — `PROCEED` / `PROCEED WITH CONDITIONS` / `PIVOT` / `STOP`
- the **chairman's reasoning** (what decided it, where the models split, whose side the judge took)
- a **dimension scorecard** (which of 12 angles were examined, contested, or missed)
- an **assumption audit** (held / failed / unverified, with confidence)
- **the debate** (who argued what, who won)
- an **anchored validation plan** — concrete next actions, each with an effort estimate and a *kill signal*
- a **cost receipt** (calls per provider)

## Example: a real idea run

<p align="center">
  <img src="docs/Two.png" alt="Three models deliberate and cross-examine; the judge reaches a verdict" width="760">
</p>

```bash
aiki run idea-refinement "Users keep asking for more features, so we should add a plugin marketplace to boost retention."
```

The council's verdict on that one:

> **Recommendation: STOP.** The premise (churn is caused by missing features) is unproven; a marketplace adds
> a security-vs-capability dilemma and a developer cold-start problem, and simpler alternatives dominate
> (build the top-3 requested features natively, or integrate an existing automation platform).

…followed by **7 anchored validation actions**, e.g. *"Pull the last 90 days of churned users and tag each
with their primary churn reason"* (effort S, kill signal: churn isn't feature-driven). The full brief opens in
your browser and has a **Copy report (Markdown)** button so you can paste it straight into your coding assistant.

## Configuration

Each provider runs its own model families — pick one per provider. Nothing is hardcoded, so a new model works
the day it ships.

```bash
aiki models          # lists what each CLI offers
```

Set models, roles, and budget in `.aiki/config.json` (per-project) or `~/.aiki/config.json` (global default):

```json
{
  "models": { "agy": "Gemini 3.1 Pro (High)", "claude": "opus", "codex": "gpt-5-codex" },
  "roles":  { "judge": "claude" },
  "budget": 18
}
```

`roles` pins which provider judges and which review; `budget` is the max provider calls per run (a guard
against repair storms — most runs use far fewer).

## Sessions & resume

Every run is recorded in a global registry (`~/.aiki/sessions.jsonl`), so you can find and continue runs from
anywhere:

```bash
aiki sessions             # all runs, newest first, resumable ones flagged
aiki resume <session-id>  # continue a killed/timed-out run (or /resume in the TUI)
```

Resume re-runs the pipeline but **replays** every step that already finished from the saved outputs on disk —
so only the failed step onward spends a real model call. (A step that failed on bad *content*, not a crash,
will replay that content; resume is for timeouts, crashes, and Ctrl-C.)

## Safety model

This is the part that makes aiki trustworthy to point at a real repo:

- **Read-only orchestration.** Providers run with their read-only flags (`claude --permission-mode plan`,
  `codex --sandbox read-only`, `agy --sandbox`). aiki never uses `--dangerously-skip-permissions` or any
  edit/exec mode.
- **No credentials, ever.** aiki never reads credential directories and filters `KEY|TOKEN|SECRET` out of the
  environment before spawning a provider.
- **Writes only under `.aiki/` / `~/.aiki/`.** Nothing else on your disk is touched.
- **No API keys, no chat UI, no write/exec tools, no "learned" routing** — by design.
- Skill playbooks load **only** from the repo and are scanned for exfiltration patterns before use.

## Costs & limits

- **Runs cost real model calls** against your existing CLI subscriptions/quota. Idea refinement is about
  **12 provider calls** (~4 on Claude/Opus); code review is about **5**. `aiki run` shows an estimate and asks
  to confirm (skip with `--yes`).
- **Not a general assistant.** Questions and "explore my whole codebase" requests are redirected, not answered
  — aiki reviews a *diff* and vets a *stated idea*.
- **Analysis, not advice.** Every report is a decision aid. Verify before acting.
- Every run leaves a full audit trail (each stage's prompt + raw output + intermediate artifacts) under its
  run directory, and every stage's output is schema-validated before the next stage sees it — free-form prose
  never crosses a stage boundary.

## Where files live

- Inside a git repo → the project's `.aiki/` (runs stay with the project).
- Anywhere else → `~/.aiki/`. `$AIKI_HOME` overrides the global home.
- The global session registry always lives in `~/.aiki/`.

## How it works

Every stage is a small, independently-testable unit with a zod-validated output contract. Model text lives in
bounded, capped fields slotted into deterministic report structure — so the output is a briefing, not a chat
transcript. The council's disagreement is the signal: consensus is trusted, disputes are adjudicated, and
what nobody examined is flagged as a blind spot.

## License

MIT — see [LICENSE](LICENSE). Analysis, not advice — verify before acting.
