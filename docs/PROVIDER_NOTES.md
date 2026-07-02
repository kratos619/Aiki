# PROVIDER_NOTES.md — Flag-probe discrepancies

Records where an installed CLI's actual flags differ from the build plan §7.3 assumptions.
Populated at build time by the flag probe (T1+).

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

## Flag discrepancies vs §7.3

| Date | Provider | Version | Plan-assumed flag | Actual | Adapter change | Enforcement impact |
|------|----------|---------|-------------------|--------|----------------|--------------------|
| 2026-07-02 | claude | 2.1.198 | `-p`, `--output-format json`, `--permission-mode plan`, `--append-system-prompt` | all present as assumed | none | read-only via `--permission-mode plan` ✔ |
| 2026-07-02 | codex | 0.135.0 | cwd flag "verify `--cwd`" | cwd is `-C, --cd <DIR>` (not `--cwd`) | use `--cd` | — |
| 2026-07-02 | codex | 0.135.0 | JSON mode "if probe finds `--json`" | `--json` (JSONL) present on `codex exec` | prefer `--json` | — |
| 2026-07-02 | codex | 0.135.0 | `--sandbox read-only` | present (`-s/--sandbox read-only`) | none | read-only enforceable ✔ |
| 2026-07-02 | gemini | 0.46.0 | read-only "best-available / prompt-level fallback" | `--approval-mode plan` = true read-only mode | use `--approval-mode plan` | **upgrade** — real read-only, not prompt-level |
| 2026-07-02 | gemini | 0.46.0 | JSON "probe for `--output-format json`/`-o json`" | `-o, --output-format json` present | use `-o json` | — |
