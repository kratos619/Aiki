# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Position:** T0–T5 all COMPLETE. Engine + S1–S3 live: `aiki run idea-refinement "<text>"`
  produces artifacts 00–03 + meta.json (verified live, 6 calls incl. one §14 repair that recovered).
  **65 tests** green (was 56; +9 for T5). Nothing half-done.
- **First, sanity-check (30s):** `npm run typecheck && npm test` should be green (**65 tests**), and
  `node dist/cli/index.js doctor --no-smoke` should list 3 providers. Green → build on it; don't
  redo T0–T5. (Uncommitted tree = finished T3+T4+T5 work; user commits — do not re-implement.)
- **Next action — START HERE: T6 (S4–S7).** Extend `runIdeaRefinement` (src/workflows/
  idea-refinement.ts) past S3. Build in `src/orchestration/stages/`:
  1. **S4 fan-out** (§9, §12.1): `Promise.allSettled` over `ctx.roles.s4` seats (default
     `[agy, codex]`), each runs the filled analyst prompt from 03-prompts/. Validate each with
     `RoleOutput` — **inject the `workflow` discriminator before `.parse()`** (model JSON has none;
     see traps). Quorum ≥2 → continue; 1 → self-consistency; 0 → abort. Write 04-role-outputs/.
     Each failed seat gets its single adapter retry first (already built). Reuse `jsonCall` +
     `isFatal` fan-out pattern from `s2-misread.ts` — S4 is the same shape.
  2. **S5 drift** (§9): deterministic — schema conformity + `task_echo` matches contract (hash/
     similarity). Drifted output excluded; if exclusion breaks quorum → abort. Write 05.
  3. **S6 claims** (§9): deterministic normalize + **fuzzy dedupe ≥0.85** → merged `Claim` with
     multi-provider attribution (`Claim.providers` array already supports this). Write 06.
  4. **S7 disagreement map** (§9): pure code → `DisagreementMap` {consensus, contradictions,
     unique, blind_spots}. Empty contradictions legal → flag `low_diversity`. Firm the
     `Contradiction`/`Claim` shapes now (T4 left them minimal). Write 07.
  - **Acceptance (§24 T6):** fixture-driven tests for dedupe + map; live run yields 04–07.
  - Schemas exist (T4): `RoleOutput`, `Claim`, `DisagreementMap`. `ClaimSet` (S6) composite has no
    schema yet — add one or write as-is (like the 02 composite).
- **In-flight?** No. T5 finished cleanly. See `.agent/HANDOFF.md`.

## Task ledger (§24)

| Task | Status | Note |
|------|--------|------|
| T0 Scaffold + pre-registration | ✅ | BENCHMARK.md, POLICY.md, TS skeleton, npm |
| T1 Detection + probe + doctor | ✅ | 3/3 providers live; PROVIDER_NOTES filled |
| T2 claude + agy adapters + smoke | ✅ | run()+retry+taxonomy+§14; 30 tests; doctor smoke live (claude+agy pass) |
| T3 codex adapter | ✅ | plain `codex exec`; stdout=final msg, stderr=transcript; 3/3 smoke live |
| T4 schemas + artifact writer + meta.json | ✅ | 7 core zod schemas; RunWriter (ordered+atomic); `aiki providers --json`; 56 tests |
| T5 engine + S1–S3 | ✅ | RunCtx+budget/deadline/quorum, S1–S3, `aiki run`, roles decided; live 00–03; 65 tests |
| T6 S4–S7 | ⏳ NEXT | fan-out+drift+claim-dedupe+disagreement map |
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
- **Roles (§10) — DECIDED at T5 (user, 2026-07-02):** idea-refinement → **analyst = agy**
  (S1/S3 + one S4 seat), **judge = claude** (default, doesn't author S4 → clean adjudication),
  **verifier = codex**, S4 seats = [agy, codex] (§10 resolved default). agy metered now, but keeping
  it analyst preserves judge/author separation; revisit only if quota pain appears. Judge must stay
  config/flag-overridable — override **seam** built at T5 (`resolveRoles(overrides?)`); actual config
  loading is T9.
- **npm install** needs `--cache <scratchpad>/.npmcache` on this box (default cache blocked).

## Traps live right now

- **claude 8KB pipe truncation** — capture claude output via fd redirect, not a pipe.
  `spawn.ts::captureFull` (probe) and `spawn.ts::spawnCapture` (adapter run) both do this.
  Full note in `docs/PROVIDER_NOTES.md`.
- **agy `--sandbox` write-blocking UNVERIFIED** — confirm it blocks file writes at T10; if not,
  temp-copy cwd fallback + record enforcement level in meta.json.
- **doctor runs live smoke = paid model calls.** Use `aiki doctor --no-smoke` during dev. The
  §8 6h smoke cache is not built yet (belongs to the config store, T9).
- **S2 clustering is strict on prose (tuning, not a bug):** `cluster.ts` uses Jaccard token
  overlap ≥0.6 (§9). Live, 3 semantically-identical restatements each formed their OWN cluster →
  `how: 'majority-cluster'` (largest, ties→earliest). Real prose rarely hits 0.6 Jaccard, so S2
  will over-report "multiple clusters" → over-triggers the TUI clarification (T8). Revisit at T8:
  lower threshold, use overlap-coefficient `|A∩B|/min`, or normalize (stem/stopword). Spec-faithful
  now; flagged for tuning.
- **T4/T5 schema choices to know before T6–T7:** (1) `RoleOutput` is a zod
  `discriminatedUnion('workflow', …)` but the model JSON (§13) has NO `workflow` field — the
  engine (S4, T6) MUST inject it: `RoleOutput.parse({ workflow, ...modelJson })`. `jsonCall` won't
  do this for you — S4 needs a wrapper or a member schema (`IdeaRoleOutput`/`CodeReviewRoleOutput`,
  both exported). (2) `DisagreementMap` element shapes (`Claim.providers`
  as array; `Contradiction {claim_ids,note?}`) were under-specified in the plan and chosen at T4 —
  firm them when S6/S7 land (T6/T7). (3) `RunWriter` refuses out-of-order + rewrites and skips are
  permanent-forward; `meta.json`/`raw/`/`inputs/` are unordered (meta is overwritable). (4) §14's
  zod→JSON-Schema export was deferred (needs a dep; belongs with skills, T5+).

## Map (where things are — go straight there, don't scan)

- Providers: `src/providers/` — types, spawn (runCommand/captureFull/spawnCapture), detect,
  probe, adapter-core (filterEnv/classify/extractJson/runAdapter), claude/codex/agy, adapters
  (registry), smoke. DISPLAY_NAME lives in types.ts.
- CLI: `src/cli/` (index = commander entry, doctor)
- Schemas: `src/schemas/index.ts` (7 core + `StagePrompts`, T4/T5)  ·  Artifact writer:
  `src/storage/runs.ts` (`RunWriter`, T4)  ·  Capability profiles: `src/providers/profiles.json` +
  `profiles.ts`  ·  `providers`/`run` cmds: `src/cli/providers.ts`, `src/cli/run.ts`
- **Engine (T5):** `src/orchestration/context.ts` = `RunCtx` (budget/deadline/`call()`/`buildMeta`),
  `setupProviders`, `resolveRoles` (override seam), `makeRunId`, errors (`BudgetExceeded`/
  `DeadlineExceeded`/`StageError`), `isFatal`. `jsonStage.ts` = `jsonCall` (call+validate+§14 repair).
  `cluster.ts` = S2 clustering. `engine.ts` = `executeRun`/`run`/WORKFLOWS. `stages/s1|s2|s3`.
  Workflow composition: `src/workflows/idea-refinement.ts` (prompts inline, skills/ loader deferred).
- Skills/workflows content: `skills/<workflow>/`  ·  Bench: `bench/` + `src/bench/`
- Tests: `test/`  ·  Pre-registration: `BENCHMARK.md`  ·  Policy: `docs/POLICY.md`
