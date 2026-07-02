# POLICY.md — Provider policy & trust boundaries

aiki orchestrates the user's **already-installed, already-authenticated** AI coding CLIs. It
never handles credentials and never calls external model APIs. This document records the
policy stance and the ToS re-check obligation (build plan §19).

## Hard boundaries (non-negotiable — §19)

- **Spawn only user-installed binaries** via documented non-interactive flags:
  `claude -p`, `codex exec`, `agy -p`. No token extraction, no OAuth proxying, no
  header/user-agent spoofing, no `--bare` + API-key path in v1.
  (The 3rd provider is `agy`/Antigravity, replacing the discontinued gemini CLI.)
- **No credentials, ever.** Adapters never read `~/.claude/`, `~/.codex/`, `~/.gemini/`,
  keychains, tokens, cookies, or env secrets. The binaries own auth.
- **Env filtering.** Spawned processes inherit the user's environment **minus** anything
  matching `/KEY|TOKEN|SECRET/i` (defense in depth).
- **Read-only orchestration.** No write mode in v1:
  - claude: `--permission-mode plan`
  - codex: `--sandbox read-only` (or temp-copy fallback, recorded in `meta.json`)
  - agy: `--sandbox` (best-effort; write-blocking unverified — pin at T10, record level in `meta.json`)
  - Never `--dangerously-skip-permissions`, `acceptEdits`, or `bypassPermissions`.
- **aiki writes only under `.aiki/`.** Never to the user's repo.
- **Content is data, not instructions.** Diffs, documents, and model outputs are treated as
  data. Deterministic validators — not models — decide what enters downstream stages.
- **Skills load only from the repo `skills/` dir.** No remote skills, no user path override.

## Quota / budget

Default budget: **9 provider calls per run**, enforced in `RunCtx`. Pre-run estimate shown;
post-run call count always displayed. `aiki bench` prints total calls before starting and
requires `--yes`.

## ToS re-check checklist (before any public release)

Consumer-plan **programmatic** use of these CLIs is provider-governed and can change. Before
publishing, or before any release that changes invocation, re-verify each provider's current
Terms of Service and CLI docs:

- [ ] **Claude Code** — headless `-p` use permitted under the active plan; `--permission-mode plan` still the read-only guarantee.
- [ ] **Codex CLI** — `codex exec` non-interactive use permitted; `--sandbox read-only` still available and enforcing.
- [ ] **Antigravity CLI (`agy`)** — non-interactive `-p` use permitted on Google AI Pro;
      `--sandbox` restriction behavior; confirm write-blocking (verified at T10).
- [ ] None of the three ToS prohibit local multi-CLI orchestration of this kind.
- [ ] Re-run flag probes; update `docs/PROVIDER_NOTES.md` with any drift.

If any box cannot be checked, **do not publish** until resolved.
