# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Position:** T0–T8 COMPLETE + live-verified. The headless S1→S10 pipeline AND the interactive TUI
  both run end-to-end on real providers. **89 tests** green, typecheck clean, `npm run build` clean,
  `doctor --no-smoke` = 3/3. Nothing half-done.
  - **T8 live proof:** bare `aiki` → full S1→S10 completed through the TUI (run `…-8c44`); **Ctrl+C
    mid-run → `exit_status:aborted`, `aborted:true`, partial artifacts kept** (run `…-2338-…-d09a`, §603
    met). Two UI bugs fixed (multi-line-paste input corruption; label/provider spacing). Cosmetic-only
    leftover: an aborted in-flight stage shows ✖ (killed → quorum-fail) not ⊘ — harmless, not fixed.
  - **T7 live proof (still valid):** run `…-af3d`, consensus=3 cross-provider, anti-blending 0 out-of-scope.
- **First, sanity-check (30s):** `npm run typecheck && npm test` should be green (**89 tests**), and
  `node dist/cli/index.js doctor --no-smoke` should list 3 providers. (Uncommitted tree = finished
  T3–T8 work; user commits — do not re-implement.)
- **Next action — START HERE: T9 (show / resolve / config). USER WANTS TO GRILL T9 FIRST — invoke the
  `grilling` skill and interview them through the design before writing any code (they explicitly asked).**
  §5 commands to design: `aiki show <run>` (render a past run's summary from artifacts — likely reuse
  `src/tui/format.ts` + the S10 renderer), `aiki resolve` (role/config overrides — the seam is already
  built: `resolveRoles(overrides?)` + `RunOptions.roleOverrides`), and **`.aiki/config.json` loading**
  (pin roles, judge override per §CLAUDE.md, and the §8 6h smoke-test cache that doctor/T2 deferred).
  No new pipeline stages. Open design Qs to grill: config schema + precedence (flag > config > default);
  what `show` renders (full report vs summary; for a partial/aborted run?); does `resolve` mutate config
  or just preview; where the smoke cache lives + its interaction with `doctor --fresh`.
- **Tuning debt:** S2 clustering + S2 prompt = **FIXED 2026-07-03** (overlap-coefficient + prompt
  hardening; see traps). Remaining low-priority: S7 blind-spot keyword matching is coarse → over-reports
  (e.g. flags "feasibility" as uncovered though discussed). Not blocking. **Do NOT touch the S7
  semantic-grouping model call — that's the working fix, not the coarse part.**
- **In-flight?** No. T8 finished cleanly (code + tests + live interactive + abort verified). See HANDOFF.

## Task ledger (§24)

| Task | Status | Note |
|------|--------|------|
| T0 Scaffold + pre-registration | ✅ | BENCHMARK.md, POLICY.md, TS skeleton, npm |
| T1 Detection + probe + doctor | ✅ | 3/3 providers live; PROVIDER_NOTES filled |
| T2 claude + agy adapters + smoke | ✅ | run()+retry+taxonomy+§14; 30 tests; doctor smoke live (claude+agy pass) |
| T3 codex adapter | ✅ | plain `codex exec`; stdout=final msg, stderr=transcript; 3/3 smoke live |
| T4 schemas + artifact writer + meta.json | ✅ | 7 core zod schemas; RunWriter (ordered+atomic); `aiki providers --json`; 56 tests |
| T5 engine + S1–S3 | ✅ | RunCtx+budget/deadline/quorum, S1–S3, `aiki run`, roles decided; live 00–03; 65 tests |
| T6 S4–S7 | ✅ | fan-out+drift+dedupe+map; 71 tests+typecheck+build green; LIVE-verified 00–07 (run …-fe2e) |
| T7 S8–S10 | ✅ | S7 grouping + S8 verify + S9 adjudicate + S10 render; budget→12; 80 tests+build green; LIVE-verified 00–10 (run …-af3d) |
| T8 TUI (ink) | ✅ | event seam + child-kill + 6 screens; 89 tests. LIVE-verified: full S1→S10 run + Ctrl+C→aborted:true (run …-d09a) |
| T9 show / resolve / config | ⏳ NEXT | show <run>, resolve (role/config overrides), .aiki/config.json load (roles, smoke cache) |
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
- **T6 decisions (2026-07-03) — do not re-litigate:**
  - **Claims = the S4 `assumptions`** (already `{statement, type: VERIFIABLE|JUDGMENT}`). `attacks` are
    NOT claims — they are the disagreement signal, re-anchored (per-seat assumption id → merged claim id)
    and carried in the `ClaimSet` for S7. `open_questions`/`strongest_version` feed only the blind-spot corpus.
  - **S7 contradiction = a contested assumption** (a claim with ≥1 attack). This is the deterministic,
    pure-code disagreement signal AND exactly the `{disputed item + evidence}` S8 verifies (§9 S8). This is
    why S7 can be pure code yet still feed S8 — attacks are the disputes.
  - **Thresholds (tunable, same class as the S2 note):** S6 dedupe = Jaccard `overlap` ≥ **0.85** (plan
    number, strict → most claims stay per-provider). S5 drift = **overlapCoefficient** (new export in
    cluster.ts, |A∩B|/min) of `task_echo` vs `contract.task` ≥ **0.3** (coefficient not Jaccard, so a short
    echo isn't penalized vs a long paragraph). Drift also requires ≥1 assumption.
  - **S6 lexical dedup CANNOT do cross-provider consensus — decided, do NOT retune (decision B, 2026-07-03).**
    Calibrated on the live run's 13 real claims: no bag-of-words threshold (Jaccard / overlap-coef /
    +stopwords) separates true merges (C2↔C10 recognition, C1↔C12 willingness-to-pay) from false ones
    (C2↔C3, C1↔C2) — models express the same claim with different words, and different claims share
    context words. Lowering the threshold buys FALSE consensus (worse than none). **Resolution (refined by
    grilling 2026-07-03):** S6 stays deterministic near-dup (correct as-built; `consensus=0` on prose is
    expected, not a bug). Semantic consensus is established by a **constrained model call INSIDE S7** (run
    on the judge role, IDs-only + attribution-withheld + validated by-reference → graceful lexical fallback)
    — NOT by the S9 judge (the plan's S9 keeps consensus read-only, §13/§624). Full build spec in "Next
    action" (T7 step 1). No embeddings (§3 forbids API keys). Do not reopen as a threshold tweak.
- **Budget raised 9 → 12 (T7 grilling, 2026-07-03) — deviation from §19, on evidence.** The plan's
  budget-9/default-8 never summed: real full pipeline = S1(1)+S2(3)+S3(1)+S4(2)+S7-grouping(1)+S8(1)+S9(1)
  = **10** min, **11** with S8's 2nd pass, **11–12** with the routine agy-S2 §14 repair (live run burned 8
  on S1–S4 alone). 9 aborts right before the judge, wasting every prior call. 12 = full run + 1 repair
  without aborting a normal run, still a real cap (pathological repair-storm fails gracefully + flagged).
  `--budget <n>` flag + T9 config override it. Change = `DEFAULT_BUDGET` in `context.ts`.
- **T7 BUILT (2026-07-03) — how the synthesis half works, do not re-derive:**
  - **S7 grouping call** lives in `s7-disagreement.ts` (`s7SemanticGroup` wrapper + `applyGroups` pure).
    Runs on `ctx.roles.judge`, sees IDs+statements only, validates groups by-reference, merges into
    lowest-id canonical (verbatim) with unioned providers; **any non-fatal failure → lexical map unchanged**
    (skips the call entirely if <2 claims). Schema `ClaimGroups` (strict, IDs-only).
  - **S8** `s8-verify.ts`: single anonymized pass on codex; zero disputes → writes empty `08` + no call;
    verifier failure → all items `UNCERTAIN`("unverified"). `REFUTE≥1-or-justify` is prompt-enforced (soft).
  - **S9** `s9-judge.ts`: `JudgeReportModel` (dissent min-0) for the call so S9 can salvage; pure
    `adjudicationScopeViolations` (anti-blending, the §602 test) + `demoteSelfAuthored` (§272, no-op in
    3-prov). One targeted re-ask on scope/dissent violation, then filter + placeholder-dissent + flag.
  - **S10** `s10-render.ts`: pure `deriveAudit` (held/failed/unverified + HIGH/MED/LOW) + `renderReport`
    (markdown decision brief, user-facing → DISPLAY_NAME so agy shows as "Gemini"). Writes `final-report.md`.
  - Tests: `test/synthesis.test.ts` (grouping merge, anti-blending, audit, demotion); `engine.test.ts` now
    e2e S1→S10. Skills/`rubric.json` loader still deferred — rubric stays inline (`IDEA_RUBRIC`).
- **T8 BUILT (2026-07-03) — TUI + the engine seam it needed, do not re-derive:**
  - **Engine seam (additive, headless unchanged):** `RunEvents` + `runStage` + `StageInfo` in
    `context.ts`; `RunCtx.events`/`.aborted` getter; `ctx.call` passes `this.signal`; `RunOptions.events`
    + `executeRun` emits `onStart` and finalizes `aborted = ctx.aborted || classified.aborted`.
  - **Child-kill:** `RunRequest.signal`/`SpawnOpts.signal` → `spawnCapture` `killGroup()` on abort (shared
    with the timeout path) → `runAdapter` skips its retry when `req.signal.aborted`.
  - **s2Misread** gained the `clusters>1 && ctx.events?.clarify` branch + `how:'user-selected'`.
  - **Workflow** wraps every stage in `runStage(ctx,'Sn',fn)` + exports `IDEA_STAGES` manifest.
  - **TUI** in `src/tui/`: `timeline.ts` (pure reducer/glyphs/provider-resolution), `format.ts` (pure
    completion/error), `app.tsx` (Ink state machine: detecting→input→running→clarify→finished; composes
    engine primitives directly, NOT `run()`; Ctrl+C via AbortController), `index.ts` (`startTui`,
    render `exitOnCtrlC:false`). Bare `aiki` → `startTui` (cli/index.ts default action). Names via DISPLAY_NAME.
  - Tests: `test/tui.test.ts` (timeline + formatters); `engine.test.ts` +2 abort tests. app.tsx render is
    NOT unit-tested (pure logic is) — the interactive run is the user's manual §603 acceptance.
  - **INTERACTIVELY VERIFIED (2026-07-03):** user ran bare `aiki` → full S1→S10 completed live through
    the TUI (detect → input → clarify → timeline → completion with verdict + top disagreements + report
    path, run `…-8c44`). Two UI bugs found + fixed: (1) multi-line paste corrupted the single-line input
    → onChange now collapses newlines to spaces (+ hint to use the file path for long ideas); (2) the
    "Misunderstanding guard" label (22 chars) butted against the provider column → label pad 22→24. Ctrl+C
    abort not yet user-tested. **S2 over-triggered the clarification live** (the known Jaccard debt) AND a
    provider META-MISREAD the S2 prompt (echoed the instruction as the "interpretation") → a garbage
    option-3. Both = S2 quality debt (clustering tune + S2-prompt hardening: "ORIGINAL TEXT is the task").
  - **Self-consistency (S4, 1 survivor):** resample the survivor once → 2 samples, run flagged `low_diversity`.
    Full 1-provider mode (§8 banner/self-judge) stays a T7+ concern. Provider attribution dedupes, so a
    resampled claim shows `providers:[agy]` (honest: 1 provider) not `[agy,agy]`.
  - **Flags plumbing:** `RunCtx.flags` set + `ctx.addFlag(...)`; `buildMeta` folds them into `meta.flags`.
    S4 & S7 raise `low_diversity`; `synthesis_suspect` reserved for S9 (T7).
  - **meta.roles** now also carries `s4_1..s4_n` seat entries (RunMeta.roles is `record<string,ProviderId>`;
    seats appended as separate keys — no schema change).
  - **Rubric (12 items) inlined** as `IDEA_RUBRIC` in `workflows/idea-refinement.ts` (T5 precedent — the
    skill/`rubric.json` loader is still deferred). Moves to `skills/idea-refinement/rubric.json` at the loader task.
  - **S6/S7 split pure core** (`mergeClaims`, `buildDisagreementMap`) from the ctx/write wrapper → the
    fixture tests (`test/disagreement.test.ts`) hit the pure fns directly, no engine/I-O.

## Traps live right now

- **claude 8KB pipe truncation** — capture claude output via fd redirect, not a pipe.
  `spawn.ts::captureFull` (probe) and `spawn.ts::spawnCapture` (adapter run) both do this.
  Full note in `docs/PROVIDER_NOTES.md`.
- **agy `--sandbox` write-blocking UNVERIFIED** — confirm it blocks file writes at T10; if not,
  temp-copy cwd fallback + record enforcement level in meta.json.
- **doctor runs live smoke = paid model calls.** Use `aiki doctor --no-smoke` during dev. The
  §8 6h smoke cache is not built yet (belongs to the config store, T9).
- **S2 clustering FIXED (2026-07-03), was over-triggering the clarification:** `cluster.ts`
  `clusterInterpretations` now uses **overlap-coefficient** (|A∩B|/min), not Jaccard, at the same
  §9 threshold 0.6. Calibrated on the live T8 case: two same-meaning readings scored Jaccard ~0.60
  (split, spurious clarification) → overlap-coef 0.76 (cluster); a genuine divergence is ~0.50 (still
  splits → real clarifications preserved). PLUS the **S2 prompt was hardened** (a provider had
  meta-misread the instruction as the task → garbage clarification option): it now pins the
  interpretation to the USER'S request + marks the request as data-not-instructions (also §7.2
  injection safety); output contract unchanged. Regression test in `cluster.test.ts`. NOTE: S6 dedupe
  still uses Jaccard 0.85 (near-dup only, correct); S7 blind-spot keyword matching still coarse
  (over-reports, e.g. "feasibility") — that one is still open, low priority.
- **T4/T5 schema choices to know before T6–T7:** (1) `RoleOutput` is a zod
  `discriminatedUnion('workflow', …)` but the model JSON (§13) has NO `workflow` field — the
  engine (S4, T6) MUST inject it: `RoleOutput.parse({ workflow, ...modelJson })`. `jsonCall` won't
  do this for you — S4 uses `IdeaRoleOutputModel` (= `IdeaRoleOutput` minus `workflow`, exported at
  T6) with `jsonCall`, then injects `workflow` + persists via `writeRoleOutput`. (2) `DisagreementMap`
  element shapes now FIRMED (T6): `Claim.providers` stays an array; `Contradiction` is now
  `{id, claim_ids(min1), attacks[{provider,argument,severity}](min1), note?}` — a contested assumption
  + the attacks against it (= the S8-ready disputed item); old `claim_ids min2` replaced. (3) `RunWriter`
  refuses out-of-order + rewrites and skips are
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
  `cluster.ts` = S2 clustering + `overlap`(Jaccard)/`overlapCoefficient`. `engine.ts` =
  `executeRun`/`run`/WORKFLOWS. `stages/s1|s2|s3`, (T6) `s4-analyze`/`s5-drift`/`s6-claims`(`mergeClaims`)/
  `s7-disagreement`(`buildDisagreementMap`+`applyGroups`+`s7SemanticGroup`), (T7) `s8-verify`, `s9-judge`
  (`adjudicationScopeViolations`/`demoteSelfAuthored`), `s10-render` (`deriveAudit`/`renderReport`).
  Workflow: `src/workflows/idea-refinement.ts` (full S1→S10, `runStage`-wrapped, + `IDEA_RUBRIC` + `IDEA_STAGES`).
- **TUI (T8):** `src/tui/` — `timeline.ts` (pure), `format.ts` (pure), `app.tsx` (Ink), `index.ts` (`startTui`).
  Engine seam: `RunEvents`/`runStage`/`StageInfo` in context.ts; abort signal threaded ctx→adapter→spawn.
- Skills/workflows content: `skills/<workflow>/`  ·  Bench: `bench/` + `src/bench/`
- Tests: `test/`  ·  Pre-registration: `BENCHMARK.md`  ·  Policy: `docs/POLICY.md`
