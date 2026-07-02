# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Last commit:** `9d44c74` — T1 complete.
- **Next action:** start **T2** — claude + gemini adapter `run()` (timeout, single retry,
  error taxonomy AUTH|QUOTA|TIMEOUT|BAD_OUTPUT|CRASH, env filtering, §14 JSON extraction),
  then wire smoke tests into `aiki doctor`. Acceptance: §24 T2.
- **In-flight?** No. Tree clean. (If this ever says "yes", read `.agent/HANDOFF.md`.)

## Task ledger (§24)

| Task | Status | Note |
|------|--------|------|
| T0 Scaffold + pre-registration | ✅ | BENCHMARK.md, POLICY.md, TS skeleton, npm |
| T1 Detection + probe + doctor | ✅ | 3/3 providers live; PROVIDER_NOTES filled |
| T2 claude + gemini adapters + smoke | ⏳ NEXT | fd-capture required (see trap below) |
| T3 codex adapter | ⬜ | parsing quarantined in codex.ts |
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
- **Providers (verified live, T1):** claude 2.1.198, codex 0.135.0, gemini 0.46.0 — all
  installed, all JSON-capable. Read-only flags: claude `--permission-mode plan`,
  codex `--sandbox read-only`, gemini `--approval-mode plan`. Full detail + §7.3
  discrepancies in `docs/PROVIDER_NOTES.md` — read it before any adapter work.
- **Default roles (§10 resolved):** idea-refinement → S4 codex+gemini, judge claude;
  code-review → S4 claude+codex, judge gemini. Rule: judge never authored what it adjudicates.
- **npm install** needs `--cache <scratchpad>/.npmcache` on this box (default cache blocked).

## Traps live right now

- **claude 8KB pipe truncation** — capture large claude output via fd redirect, not a pipe.
  `spawn.ts::captureFull` already does this for probing; T2 adapter `run()` must too.
  Full note in `docs/PROVIDER_NOTES.md`.

## Map (where things are — go straight there, don't scan)

- Providers: `src/providers/` (types, spawn, detect, probe; adapters claude/codex/gemini = T2/T3)
- CLI: `src/cli/` (index = commander entry, doctor)
- Schemas: `src/schemas/` (T4)  ·  Engine: `src/orchestration/` (T5+)
- Skills/workflows content: `skills/<workflow>/`  ·  Bench: `bench/` + `src/bench/`
- Tests: `test/`  ·  Pre-registration: `BENCHMARK.md`  ·  Policy: `docs/POLICY.md`
