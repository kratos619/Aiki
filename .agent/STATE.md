# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Last commit:** `4b06027` — then T2 done + gemini→agy migration (UNCOMMITTED in tree; user commits).
- **Next action:** start **T3** — codex adapter (`codex exec`, parsing quarantined in
  `codex.ts`), add it to `ADAPTERS` in `adapters.ts`, probe-driven flag selection. Acceptance:
  §24 T3 + codex smoke passes in doctor (→ 3/3 ready). Note codex uses `--cd` (not `--cwd`) and
  `--json` (JSONL) — see PROVIDER_NOTES.
- **In-flight?** No (T2 complete). But there are uncommitted changes for the user to commit.

## Task ledger (§24)

| Task | Status | Note |
|------|--------|------|
| T0 Scaffold + pre-registration | ✅ | BENCHMARK.md, POLICY.md, TS skeleton, npm |
| T1 Detection + probe + doctor | ✅ | 3/3 providers live; PROVIDER_NOTES filled |
| T2 claude + agy adapters + smoke | ✅ | run()+retry+taxonomy+§14; 30 tests; doctor smoke live (claude+agy pass) |
| T3 codex adapter | ⏳ NEXT | parsing quarantined in codex.ts; add to adapters.ts |
| T4 schemas + artifact writer + meta.json | ⬜ | |
| T5 engine + S1–S3 | ⬜ | |
| T6 S4–S7 | ⬜ | |
| T7 S8–S10 | ⬜ | idea-refinement end-to-end |
| T8 TUI (ink) | ⬜ | |
| T9 show / resolve / config | ⬜ | |
| T10 code-review workflow | ⬜ | |
| T11 bench harness + build set | ⬜ | |
| T12 freeze + holdout + RESULTS.md | ⬜ | |

## Facts already decided (do not re-derive, do not re-litigate)

- **Package manager: npm** (plan said pnpm; user chose npm). Gate = `npm run typecheck`.
- **Node:** v20.19.3 installed (plan needs ≥20). ✔
- **Providers (live):** claude 2.1.198, codex 0.135.0, **agy 1.0.15** (Antigravity/Gemini 3.1
  Pro — REPLACES the discontinued gemini CLI). Read-only: claude `--permission-mode plan`,
  codex `--sandbox read-only`, agy `--sandbox` (write-blocking unverified). Invocation: claude
  `-p --output-format json` (envelope, text in `.result`); agy `-p` (raw text, no envelope);
  codex `exec` (T3). Detail in `docs/PROVIDER_NOTES.md` — read before adapter work.
- **agy smoke passes; codex smoke = FAIL until T3 adapter.** 2/3 ready now → quorum met.
- **Default roles (§10) — REVISIT at T5:** plan picked gemini as cheap/free analyst; agy is
  strong+metered (Gemini 3.1 Pro), so §10's cost rationale no longer holds. Re-decide
  judge/analyst assignment when building the engine. (Plan default: idea-refinement S4
  codex+agy judge claude; code-review S4 claude+codex judge agy.)
- **npm install** needs `--cache <scratchpad>/.npmcache` on this box (default cache blocked).

## Traps live right now

- **claude 8KB pipe truncation** — capture claude output via fd redirect, not a pipe.
  `spawn.ts::captureFull` (probe) and `spawn.ts::spawnCapture` (adapter run) both do this.
  Full note in `docs/PROVIDER_NOTES.md`.
- **agy `--sandbox` write-blocking UNVERIFIED** — confirm it blocks file writes at T10; if not,
  temp-copy cwd fallback + record enforcement level in meta.json.
- **doctor runs live smoke = paid model calls.** Use `aiki doctor --no-smoke` during dev. The
  §8 6h smoke cache is not built yet (belongs to T4 config store).

## Map (where things are — go straight there, don't scan)

- Providers: `src/providers/` (types, spawn, detect, probe; adapters claude/codex/gemini = T2/T3)
- CLI: `src/cli/` (index = commander entry, doctor)
- Schemas: `src/schemas/` (T4)  ·  Engine: `src/orchestration/` (T5+)
- Skills/workflows content: `skills/<workflow>/`  ·  Bench: `bench/` + `src/bench/`
- Tests: `test/`  ·  Pre-registration: `BENCHMARK.md`  ·  Policy: `docs/POLICY.md`
