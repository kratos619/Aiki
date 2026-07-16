# PROVIDER_NOTES.md — Flag-probe discrepancies

Records where an installed CLI's actual flags differ from the build plan §7.3 assumptions.
Populated at build time by the flag probe (T1+).

## ⚠ Provider migration (T2) — gemini → agy (Antigravity CLI)

Google **discontinued the gemini CLI**; the free-tier `gemini` binary now fails every model
call with `IneligibleTierError: ... no longer supported ... migrate to the Antigravity suite`.
Google's supported replacement is the **Antigravity CLI (`agy`)**, authenticated on Google AI
Pro, running **Gemini 3.1 Pro (High)**.

**Decision:** the third provider is now `agy` (id renamed `gemini` → `agy` across the code).
Wherever the plan says "gemini", it means `agy`.

- **Invocation (verified live T2):** `agy -p "<prompt>" [--sandbox]`. Exit 0, clean stderr,
  returns the model response as **raw text with no envelope** — the cleanest of the three for
  JSON (`-p` output *is* the JSON we ask for → §14 whole-parse succeeds immediately).
- **No JSON-output flag** (no `--output-format`/`-o json`). `jsonOutput: false`; rely on §14.
- **Read-only:** `--sandbox` (boolean, "terminal restrictions"). Mapped to `readOnlyFlag:
  'sandbox'`. **VERIFIED 2026-07-05 (agy 1.0.16): `--sandbox` DOES block file writes.** Probed via
  the real adapter (`agy.run`, cwd = fresh temp dir): with `--sandbox`, a prompt explicitly asking to
  write `PROBE_WROTE.txt` produced NO file on disk (agy even reported "successfully created" — its
  self-reported success is unreliable, but the write was blocked); the no-sandbox control DID write the
  file, confirming the test is valid. So agy is safe at repo cwd as a reviewer *when invoked with
  `--sandbox`* (as the adapter does). CAVEAT: a bare terminal `agy -p ...` goes interactive/hangs and
  does NOT reliably apply the sandbox — only trust the adapter path (spawnCapture, stdin redirected).
  NEVER pass `--dangerously-skip-permissions` (§19).
- **Role rationale flip (revisit at T5, §10):** the plan chose gemini as the *cheap/free*
  analyst to protect metered quotas. `agy` is Gemini 3.1 Pro — **strong + metered**. The §10
  default role assignment (gemini = analyst/prompt-builder for high-frequency cheap calls) no
  longer matches its cost profile. Re-evaluate judge/analyst assignment when building the engine.

## ⚠ Capture note (found T1) — claude truncates piped output at ~8KB

`claude --help` emits ~15.7KB, but when its stdout is a **pipe** (execa's default capture,
including execa's `{file}` redirect which pipes-then-writes), only the first **8192 bytes**
survive — claude calls `process.exit()`, dropping un-flushed async pipe writes. A **true fd
redirect** (child's stdout inherits an open file descriptor) captures the full output.

- **T1 fix:** `captureFull()` in `spawn.ts` uses `spawn(bin, args, { stdio: ['ignore', fd, fd] })`
  for `--help` probing. Detection (`--version`, tiny) still uses the execa pipe path.
- **T2 obligation:** the claude adapter's `run()` MUST NOT capture model output over a plain
  pipe — a JSON result >8KB would be silently truncated → `BAD_OUTPUT` or, worse, malformed
  JSON that parses partially. Capture claude output via fd redirect to a file, then read it.
  Re-verify codex/gemini for the same behavior before trusting pipe capture.

## Display naming (T2 decision)

Internal id / artifacts / meta.json / logs use the **true id** for audit accuracy:
`claude`, `codex`, `agy`. The **UI shows familiar model names** via `DISPLAY_NAME` (types.ts):
`agy → "Gemini"`, `codex → "Codex"`, `claude → "Claude"`. Users know "Gemini", not the
Antigravity binary. Command/binary references in fixes (e.g. "run `agy`") keep the real id.

## codex exec output (verified live, T3)

- `codex exec --skip-git-repo-check [-s read-only] "<prompt>"` — **stdout = the model's final message only**; the
  session transcript (session id, echoed prompt, "tokens used") goes to **stderr**. So stdout
  *is* the result → §14 extraction parses directly. We use **plain mode, not `--json` JSONL**
  (plain stdout is already clean; JSONL would need event-stream parsing for no gain).
- Consequence: codex mirrors prompt + result into stderr. `adapter-core.classify` therefore
  **short-circuits to OK on exit 0** and only scans stderr on failure — otherwise innocent
  content ("rate limit", "login") in a successful transcript would false-positive AUTH/QUOTA.
- cwd is set via the spawn cwd option (no `-C` needed for the common case). `--skip-git-repo-check`
  is required for run-anywhere support; it does not bypass approvals or the read-only sandbox.

## R4 provider-native investigation observations (2026-07-13)

Verified from the installed CLIs' complete `--help` output; no model calls and no credential reads:

- **Claude Code 2.1.204:** exposes general `--tools` / `--allowedTools` controls, but its help does not
  advertise a dedicated web/search/research flag. Do not assume a research tool is available. Aiki keeps
  `--permission-mode plan`; no R4 adapter flag changed.
- **Codex CLI 0.144.1:** root `codex --help` explicitly exposes `--search` (live web search); `codex exec
  --help` does not list a separate research flag. R6 verifies placement as `codex --search exec ...`;
  aiki enables it for Codex scout calls in every full idea council (`research` is an alias). Existing
  `-s read-only` stays.
- **Antigravity `agy` 1.1.1:** help exposes `--sandbox` but no explicit web/search/research flag. Do not
  infer provider-native investigation beyond prompt-visible local files.

R4 evidence-pack files are therefore read through the existing read-only adapter profiles only. No
dangerous bypass, write permission, credential directory, or unverified flag was added.

## Flag discrepancies vs §7.3

| Date | Provider | Version | Plan-assumed flag | Actual | Adapter change | Enforcement impact |
|------|----------|---------|-------------------|--------|----------------|--------------------|
| 2026-07-02 | claude | 2.1.198 | `-p`, `--output-format json`, `--permission-mode plan`, `--append-system-prompt` | all present as assumed | none | read-only via `--permission-mode plan` ✔ |
| 2026-07-02 | codex | 0.135.0 | cwd flag "verify `--cwd`" | cwd is `-C, --cd <DIR>` (not `--cwd`) | use `--cd` | — |
| 2026-07-02 | codex | 0.135.0 | JSON mode "if probe finds `--json`" | `--json` (JSONL) present on `codex exec` | prefer `--json` | — |
| 2026-07-02 | codex | 0.135.0 | `--sandbox read-only` | present (`-s/--sandbox read-only`) | none | read-only enforceable ✔ |
| 2026-07-02 | claude | 2.1.198 | envelope shape (verified live) | `{type, subtype, is_error, result, session_id, total_cost_usd, usage}`; model text in `.result` | extract `.result`; `is_error:true`→CRASH; cost→providerMeta | — |
| 2026-07-02 | ~~gemini~~ → agy | 1.0.15 | gemini CLI discontinued | replaced by Antigravity `agy` (Gemini 3.1 Pro) | new adapter agy.ts | see migration note above |
| 2026-07-02 | agy | 1.0.15 | (was gemini `-o json`) | no JSON flag; `-p` returns raw text | `jsonOutput:false`, §14 extraction | — |
| 2026-07-02 | agy | 1.0.15 | (was gemini `--approval-mode plan`) | `--sandbox` (boolean, terminal restrictions) | `readOnlyFlag:'sandbox'` | ✔ write-blocking **VERIFIED 2026-07-05** (agy 1.0.16, adapter probe): `--sandbox` blocks disk writes; no-sandbox control writes. Safe at repo cwd via adapter. (Bare terminal `agy -p` hangs interactive — sandbox only reliable through spawnCapture.) |
| 2026-07-04 | codex | 0.135.0→**0.142.5** | (user upgrade after install break) | `--help` probe: `exec` + `-s/--sandbox read-only` + `--cd` unchanged | none needed | ✔ smoke PASSED on 0.142.5 (`doctor` 2026-07-04, 9.1s) — stdout/stderr split works. NOTE: the 2026-07-04 22:16 codex CRASH was NOT quota/flags — install was broken (`Missing optional dependency @openai/codex-darwin-arm64`), fixed by reinstall |
| 2026-07-06 | claude | 2.1.201 | model selection (V8) | `--model <alias\|fullname>` (Model for the session). No "list models" command. | adapter buildArgs adds `--model` when config sets it; `aiki models` → free-text | user-configurable model ✔ |
| 2026-07-06 | codex | 0.142.5 | model selection (V8) | `-m, --model <MODEL>` (also on `codex exec`, must precede the prompt). No list command. | adapter buildArgs adds `--model` before the prompt; free-text | ✔ |
| 2026-07-06 | agy | 1.0.16 | model selection (V8) | `--model <id>` AND `agy models` LISTS available (e.g. "Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)" — ids have spaces/parens, pass as one argv elem) | adapter `--model`; `aiki models` runs `agy models` | ✔ only CLI that enumerates |
| 2026-07-09 | codex | 0.142.5 | run-anywhere smoke in arbitrary cwd | `--skip-git-repo-check` present on `codex exec`; without it, non-git cwd fails: "Not inside a trusted directory..." | adapter always adds `--skip-git-repo-check` after `exec` | read-only unchanged: still uses `-s read-only`; no dangerous bypass |
| 2026-07-11 | codex | 0.142.5→**0.144.1** | configured CLI-default model `gpt-5.6-sol` | 0.142.5 returned HTTP 400: model requires newer Codex; `codex update` installed 0.144.1 | no adapter flag change | version probe green; live retry remains USER-approved only |
| 2026-07-13 | codex | 0.144.1 | provider-native investigation | root help exposes verified `--search`; `codex --search exec --help` succeeds while `codex exec --search --help` rejects the option | enable on full idea-council scout calls | existing `-s read-only` unchanged |
| 2026-07-13 | claude / agy | 2.1.204 / 1.1.1 | provider-native investigation | no dedicated web/search/research flag in complete help output | none | existing `plan` / `sandbox` enforcement unchanged |
