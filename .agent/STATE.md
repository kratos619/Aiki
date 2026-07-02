# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Position:** T0–T4 all COMPLETE. `aiki doctor` shows **3/3 providers ready**; `aiki providers
  --json` prints resolved capability profiles. 56 tests green (was 33; +23 for T4). Nothing half-done.
- **First, sanity-check (30s):** `npm run typecheck && npm test` should be green (**56 tests**), and
  `node dist/cli/index.js doctor --no-smoke` should list 3 providers. If green → build on it;
  don't redo T0–T4. (Uncommitted changes in the tree = the finished T3+T4 work; the user handles
  commits — do not re-implement.)
- **Next action — START HERE: T5 (Engine + S1–S3).** Build in `src/orchestration/`:
  1. **Stage runner + `RunCtx`** (§6 invariants): typed `Stage<In,Out>` where Out is
     zod-validated before the next stage; RunCtx carries run id, workflow id, provider handles,
     call budget (default 9), wall-clock deadline (default 10 min), abort signal, the **T4
     `RunWriter`** (`src/storage/runs.ts`), logger. Every stage writes input+output before the
     next starts (RunWriter already enforces ordered/crash-safe writes — just call it).
  2. **Quorum + budget guard + deadline** (§6, §19 "runaway loops"): each provider call
     decrements budget; a call that would exceed throws `BudgetExceeded` → run fails gracefully
     with partial artifacts + finalized `meta.json`. Wall-clock kill = process-tree kill.
  3. **S1 intent-contract, S2 misread-prediction, S3 prompt-gen** with idea-refinement prompts
     (verbatim from §13). S1/S3 → analyst provider; S2 → ALL providers parallel + deterministic
     cluster comparator (token-overlap ≥0.6; §9 S2 row). Schemas already exist: `IntentContract`,
     `Interpretation` (T4). The **02 composite** ("all interpretations, clusters, chosen one") has
     NO T4 schema — write it via `RunWriter.writeJson('misunderstanding-guard', …)` (schema:null,
     writes as-is) or add its schema now.
  - **Acceptance (§24 T5):** headless run produces artifacts 00–03 on sample input; a budget
    breach aborts gracefully.
  - **Role assignment (REVISIT now — see decided-facts below):** §10 role rationale assumed the
    old free gemini; agy is metered Gemini 3.1 Pro. Re-decide analyst/critic/verifier here. Judge
    stays claude default but must be config/flag-overridable (build the override seam at T5).
- **In-flight?** No. T4 finished cleanly. See `.agent/HANDOFF.md`.

## Task ledger (§24)

| Task | Status | Note |
|------|--------|------|
| T0 Scaffold + pre-registration | ✅ | BENCHMARK.md, POLICY.md, TS skeleton, npm |
| T1 Detection + probe + doctor | ✅ | 3/3 providers live; PROVIDER_NOTES filled |
| T2 claude + agy adapters + smoke | ✅ | run()+retry+taxonomy+§14; 30 tests; doctor smoke live (claude+agy pass) |
| T3 codex adapter | ✅ | plain `codex exec`; stdout=final msg, stderr=transcript; 3/3 smoke live |
| T4 schemas + artifact writer + meta.json | ✅ | 7 core zod schemas; RunWriter (ordered+atomic); `aiki providers --json`; 56 tests |
| T5 engine + S1–S3 | ⏳ NEXT | + revisit role assignment (§10) for metered agy |
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
- **All 3 adapters live (T3):** claude/codex/agy each pass smoke in `aiki doctor` → 3/3 ready.
- **Display naming (user decision):** id stays `agy` internally/artifacts/meta; UI shows
  "Gemini" via `DISPLAY_NAME` (types.ts). Don't show "agy" to users; keep it in typed commands.
- **Judge = claude by default (user decision):** Opus 4.8, strongest → default judge. But make
  the judge provider **user-overridable** via config (`.aiki/config.json → roles`) and/or a run
  flag. Build overridability at T5 (roles) / T9 (config); do NOT hardcode claude as only judge.
- **Other roles (§10) — REVISIT at T5:** agy is strong+metered (Gemini 3.1 Pro), not the old
  cheap/free gemini, so §10's analyst rationale no longer holds. Re-decide analyst/critic/
  verifier assignment when building the engine. Judge stays claude (above) unless user overrides.
- **npm install** needs `--cache <scratchpad>/.npmcache` on this box (default cache blocked).

## Traps live right now

- **claude 8KB pipe truncation** — capture claude output via fd redirect, not a pipe.
  `spawn.ts::captureFull` (probe) and `spawn.ts::spawnCapture` (adapter run) both do this.
  Full note in `docs/PROVIDER_NOTES.md`.
- **agy `--sandbox` write-blocking UNVERIFIED** — confirm it blocks file writes at T10; if not,
  temp-copy cwd fallback + record enforcement level in meta.json.
- **doctor runs live smoke = paid model calls.** Use `aiki doctor --no-smoke` during dev. The
  §8 6h smoke cache is not built yet (belongs to the config store, T9).
- **T4 schema/writer choices to know before T5–T7:** (1) `RoleOutput` is a zod
  `discriminatedUnion('workflow', …)` but the model JSON (§13) has NO `workflow` field — the
  engine must inject it before `.parse()`. (2) `DisagreementMap` element shapes (`Claim.providers`
  as array; `Contradiction {claim_ids,note?}`) were under-specified in the plan and chosen at T4 —
  firm them when S6/S7 land (T6/T7). (3) `RunWriter` refuses out-of-order + rewrites and skips are
  permanent-forward; `meta.json`/`raw/`/`inputs/` are unordered (meta is overwritable). (4) §14's
  zod→JSON-Schema export was deferred (needs a dep; belongs with skills, T5+).

## Map (where things are — go straight there, don't scan)

- Providers: `src/providers/` — types, spawn (runCommand/captureFull/spawnCapture), detect,
  probe, adapter-core (filterEnv/classify/extractJson/runAdapter), claude/codex/agy, adapters
  (registry), smoke. DISPLAY_NAME lives in types.ts.
- CLI: `src/cli/` (index = commander entry, doctor)
- Schemas: `src/schemas/index.ts` (7 core zod schemas + inferred types, T4)  ·  Artifact writer:
  `src/storage/runs.ts` (`RunWriter`, T4)  ·  Capability profiles: `src/providers/profiles.json` +
  `profiles.ts` (`resolveProfiles`)  ·  `providers` cmd: `src/cli/providers.ts`  ·  Engine:
  `src/orchestration/` (T5+)
- Skills/workflows content: `skills/<workflow>/`  ·  Bench: `bench/` + `src/bench/`
- Tests: `test/`  ·  Pre-registration: `BENCHMARK.md`  ·  Policy: `docs/POLICY.md`
