# STATE.md — read this first, then stop reading

Single source of truth for project position. Small on purpose. Update at each task end.
For full history: `git log --oneline` (free). For the spec: `plan/AIKI-build-plan.md`.

## Now

- **Position:** T0–T11 COMPLETE. **T12 buildable half DONE this session** (frozen 10-diff holdout set +
  locate-check test + RESULTS.md scaffold + .gitignore fix). Remaining T12 = the USER's metered holdout
  eval + RESULTS fill + §23 verdict (no-live-paid-runs). **148 tests** green (145 + 3 T12), typecheck +
  `npm run build` clean. T0–T8 live-verified; T9/T10/T11 verified by tests + free CLI paths.
  - **T12 built (2026-07-04):** `bench/sets/code-review/holdout/{01-payments…10-analytics}/` = **10 cases /
    43 seeded bugs** (4–5 each, MERN-style, all 5 canonical classes + 6 categories). Each = src file +
    `diff.patch` (whole-file add via `git diff --no-index`, `+++ b/<file>`) + `bugs.json`. Ground truth
    verified by `test/t12.test.ts` (loadCases=10, per-bug file-exists + line-in-bounds + valid category +
    class-coverage). `RESULTS.md` = full scaffold: protocol/freeze table, holdout table, run commands,
    per-arm summary + per-case×per-arm recall tables (placeholders `—`), cost/latency, and **an explicit
    pass/fail line per §23 criterion with the gate arithmetic pre-wired** (KC#1 `rD≥1.20·rB ∧ pD≥pB−0.10`,
    KC#2 `rD≥1.10·rC`, KC#4 wall<8min ∧ ≤15% quota). Fill from `bench/results/*.json` + resolve FP labels.
  - **Cheap sample verified (2026-07-04, 1 metered call):** Arm A on a throwaway copy of `01-payments` →
    **4/4 recall**, 10 reported / 5 unmatched, scorer resolved file:line correctly, ~93s/call. Confirms
    wiring + ground-truth matchability end-to-end. (Temp `_sample` set + its results JSON deleted after.)
    Implication: full 120-call sequential bench ≈ 2.5–3h wall; incremental writes survive a mid-run stop.
  - **.gitignore FIX (2026-07-04, user-approved):** `bench/*` had been ignoring ALL bench content — the
    T11 build set was NEVER committed (only `.gitkeep` was tracked; STATE's "committed through 63b9fd8"
    was true for src/ but NOT the seeded diffs). Added `!bench/sets/` + `!bench/sets/**` so ground-truth
    task sets are committable (freeze integrity, §18) while `bench/results/*` stays ignored. 45 set files
    (15 build + 30 holdout) now show as `??` — user commits them.
  - **T11 proof:** scripted-adapter bench e2e — all 4 arms A/B/C/D scored, recall computed, result JSON
    written incrementally, table rendered; provider-absent arms skipped. Units: scorer (category-strict
    match), micro-aggregation, Arm-C `mergeSamples` (≥2/3 consensus), resolve-CR (finding verdicts). Real
    build set = 5 cases / 20 seeded bugs, each diff→bug-file→exists verified. Free CLI: `bench idea-refinement`
    rejected, bad `--arms` rejected, empty `--set` → "no cases". LIVE 4-arm bench = user's §606 acceptance.
  - **T10 proof:** scripted e2e S4→S10 + LIVE run `…-aa6d` (4 calls, §487 merged 3 dup pairs → 5 consensus,
    0 disputes → judge-skip, file:line validator ran, "Gemini" judge). §605 met.
  - **T9 (still true):** config/show/resolve/config.json all built + CLI-verified; §604 met.
  - **T8 live proof:** bare `aiki` → full S1→S10 completed through the TUI (run `…-8c44`); **Ctrl+C
    mid-run → `exit_status:aborted`, `aborted:true`, partial artifacts kept** (run `…-2338-…-d09a`, §603
    met). Two UI bugs fixed (multi-line-paste input corruption; label/provider spacing). Cosmetic-only
    leftover: an aborted in-flight stage shows ✖ (killed → quorum-fail) not ⊘ — harmless, not fixed.
  - **T7 live proof (still valid):** run `…-af3d`, consensus=3 cross-provider, anti-blending 0 out-of-scope.
- **First, sanity-check (30s):** `npm run typecheck && npm test` should be green (**148 tests**), and
  `node dist/cli/index.js doctor --no-smoke` should list 3 providers.
- **The 2026-07-04 holdout run is VOID (Opus exhaustion mid-sweep) — do NOT fill RESULTS.md from it.**
  Opus quota died after case 02: A/B/C (claude-only) crashed with `provider claude call failed (CRASH)`
  from case 03 on (2/2/1 scored cases resp.); Arm D tolerated the dead claude reviewer and silently
  finished cases 03–10 on **codex+agy only** (proof: run `…-8773` meta `S4-claude:CRASH`, `exit ok`) — NOT
  the registered 3-provider D. Summary compares arms over different case counts (A=2,B=2,C=1,D=10) → the §23
  gates on that JSON are meaningless. The raw JSON stays as forensic evidence. **Decision (user, 2026-07-04):
  a crash on infrastructure (quota) is NOT "the one frozen eval pass" — the pre-registration freeze guards
  against outcome-driven tuning, and there is no valid comparative outcome here. So non-result-affecting
  harness robustness fixes are allowed; arms/matcher/`bugs.json`/thresholds stay frozen and were NOT touched.**
- **T12 HARNESS HARDENED (2026-07-04, uncommitted) — three fixes, none touch what's measured:**
  1. **`--resume`** (`runBench`/`planBench` + `resolveCampaign`/`priorScored` in `src/bench/harness.ts`):
     continues the latest `code-review-YYYY-MM-DD.json`, KEEPS `status:'scored'` case×arm pairs, retries
     error/skipped ones → re-run the same command each Opus window until complete. Matcher is date-strict so
     an archived `.void.json` is ignored.
  2. **Pre-run Opus estimate + `--yes` gate** (`planBench`/`estimateClaudeCalls`/`CLAUDE_CALLS_PER_CASE` +
     `src/cli/bench.ts renderPlan`): no `--yes` → prints "≈N claude/Opus calls" and EXITS without running.
     Full sweep ≈ **80 Opus calls** (C≈4/case is ~40 of them). Closes the §19 gap.
  3. **Degradation guard** (`runArmOnCase`): a `scored` outcome with ANY errored `ctx.calls` entry →
     downgraded to `status:'error'` (`DEGRADED: …`), so D can't silently score a claude-less run and
     `--resume` retries it. (Safe: a recovered §14 repair pushes no errored record — see jsonStage.)
  Tests: `test/bench-resume.test.ts` (10, scripted adapters, NO paid calls). 158 tests green; build clean.
- **STAGE 0 DONE (2026-07-04 late session) — Amendment A1 pre-declared in RESULTS.md §1; read it first.**
  What happened after the first void run: the user re-ran bench same evening (attempt 2) → **codex crashed**
  in case-01 D, killed during case 02 (runs 2229/2242 have no meta = hard kill; its case-02 A/B/C Opus calls
  burned unrecorded). Both attempts VOID, archived as `bench/results/code-review-2026-07-04.attempt{1,2*}.void.json`
  (attempt 1 restored verbatim from session memory after the dated file got overwritten). **Salvage
  (mechanical rule: scored pair kept iff run meta has ZERO errored calls; earliest clean wins):** 6 pairs →
  cleaned campaign `code-review-2026-07-04.json` (01 A/B/C/D + 02 A/B). Attempt-1's 02 D dropped — meta shows
  claude CRASHED mid-case-02-D (results JSON hid it; Opus died earlier than first diagnosed). Noise caveat
  logged: case-01 recall flipped ±1 bug between identical attempts (A1 §5). Harness also gained (tested,
  160 green): carry-forward of non-requested arms on narrower `--arms` resume + prior-case preservation on
  mid-run kill (both prevent campaign-file data loss). Arm A = no further metered runs (in no §23 gate).
- **Next action — the USER's staged metered pass (no-live-paid-runs). Commands also in RESULTS.md §3:**
  1. Check codex health first (attempt 2 died on codex): `node dist/cli/index.js doctor --no-smoke`, and
     dry-run `bench code-review --arms B,D --set holdout --resume` (free, prints ≈26 Opus / pairs left).
  2. **Stage 1:** same command + `--yes` (≈26 Opus + ≈18 GPT) → KC#1 + KC#4. Re-run same command each
     quota window; `--resume` fills gaps.
  3. **Stage 2:** `--arms B,C,D --set holdout --resume --yes` (≈36 more Opus) → KC#2.
  4. FP-label (`resolve <run-id> --verdict <id>=false-positive`), fill RESULTS §4–§6, §7 verdict — only
     after B,C,D × all 10 cases scored.
  Frozen still frozen: arms/matcher/`bugs.json`/thresholds/pipeline. Post-eval fix list (do NOT touch now):
  S8 never-refutes (agy judge dormant in bench — 0 calls ever), agy sandbox verify, S7 coarse keywords.
- **T11 SHIPPED 2026-07-04 (as-built, do not re-litigate).** BENCHMARK.md is FROZEN pre-registration —
  arms/metrics/matching/thresholds NOT editable. `aiki bench code-review --arms A,B,C,D --set build`
  (code-review only). Pieces:
  1. **Arms = engine compositions** (each run via `executeRun` → a full `.aiki/runs` record per
     BENCHMARK.md §5, and returns its `Finding[]` to the harness for in-memory scoring). Each case runs
     with **cwd = the case dir** so the reviewer file:line validator resolves. Arms:
     - **A** = 1 claude call, plain "review this diff" → findings (validate file:line). No synthesis.
     - **B** = 1 claude call, structured adversarial (analyze → self-attack → re-answer, schema-forced).
       **B is the real opponent** — draft a strong single prompt.
     - **C** = **bespoke sample-keyed** self-consistency: sample claude 3× (keyed by sample idx, NOT
       provider — 3 claude samples all have provider=claude, which would break the provider-keyed D
       pipeline), file:line-validate each, merge via `sameFinding` (found in ≥2/3 → consensus), reuse
       `s9ReviewJudge` on singletons/disputes. Leaves the live-verified D pipeline untouched.
     - **D** = existing `runCodeReview` (claude+codex reviewers, agy judge).
  2. **Ground truth:** each build case = dir `bench/sets/code-review/build/<name>/` holding the buggy
     source file + `diff.patch` (whole-file add via `git diff --no-index`, so every bug line is a
     reviewable change) + `bugs.json` = `[{id, file, line_start, line_end, category (6-enum), class}]`.
     **Matcher = loosen `sameFinding`** to compare file + overlap + category enum (reuse for scoring).
     Enum map: off-by-one→CORRECTNESS, race→CONCURRENCY, unhandled-rejection→ERROR_HANDLING,
     auth-gap→SECURITY, N+1→PERF. Category-enum equality IS the frozen "same defect class" (a
     mis-categorized find won't count — pre-registered rule, not changeable).
  3. **Metrics:** recall (PRIMARY, **micro** = total matched / total seeded across cases; macro shown as
     secondary), precision (**nullable** — needs FP adjudication), F1, calls, wall-clock. Also report
     reported/matched/**unmatched** counts (unmatched = candidate FPs, labeled UNADJUDICATED, not precision).
  4. **resolve-CR (build now — the deferred T10 piece):** generalize `FeedbackEntry` (item_type
     `finding|adjudication`; verdict = union of idea `correct/incorrect/unsure` + CR
     `fixed/wontfix/false-positive`; `ruling`→string snapshot). `resolve` reads `meta.workflow` → picks
     item source (idea: adjudications; CR: review-map kept findings) + vocab. True precision fills from
     `feedback.jsonl` when FP labels exist, else null.
  5. **CLI + results:** `aiki bench` command; writes `bench/results/<suite>-<date>.json` (per-case
     per-arm {recall, matched, reported, unmatched, calls, wallMs, runId} + summary) — zod schema. Run
     cases/arms SEQUENTIALLY, write results INCREMENTALLY after each case (a ~20-run metered bench must
     survive a mid-run quota stop). Detect providers; skip/mark arms whose providers are absent (D needs 3).
  6. **Build set:** author all **5** cases now, each a SINGLE small file + 4-6 precisely-located seeded
     bugs (off-by-one, race, unhandled-rejection, auth-gap, N+1 across the set) + bugs.json.
  - **Verify (NO paid calls):** scripted-adapter e2e (fake providers → canned per-arm findings → assert
     recall/result-JSON/table + resolve-CR JSONL) + pure-unit the matcher/scorer. Real 4-arm bench run is
     metered → user's manual §606 acceptance. Acceptance §606: `bench code-review --set build` outputs
     per-arm scores table + result JSON.
- **T10 SHIPPED 2026-07-04 (as-built, do not re-litigate). Bespoke lean composition — NOT the idea
  S1–S10 stages** (findings have no assumption/attack structure; §12.2 only specs CR's S4/S8/S9/report).
  ~5 model calls. Pipeline:
  1. **Diff plumbing** (CLI/git util): `run code-review --base <ref>` (req) `--head <ref>` (default HEAD)
     OR `--diff <file>`. `git diff --unified=3 <base>...<head>` (THREE-DOT merge-base = what HEAD added)
     → write `inputs/diff.patch` (+ 00-original). Reviewer-call cwd = `git rev-parse --show-toplevel`.
     Empty diff → clean exit "no changes"; not-a-git-repo & no --diff → error.
  2. **S1 deterministic (NO call):** synth trivial IntentContract {task:"review the diff",
     task_type:"code-review"} → 01. **S2 skipped.** **S3 deterministic (NO call):** fill reviewer
     template {{DIFF_PATH}} → 03-prompts.
  3. **S4 reviewers** claude+codex, blind/parallel, cwd=repo root, read-only (plan/sandbox, VERIFIED) →
     CodeReviewRoleOutput (≤12 findings) → 04. Then **file:line validator** (deterministic, pre-S8):
     DROP findings whose file ∉ diff / ∉ HEAD / lines out-of-bounds; keep valid; flag dropped count.
  4. **S8 mutual cross-exam** (2 calls; skip a side if its target has 0 findings): each reviewer sees the
     OTHER's findings ANONYMIZED → Verification CONFIRM/REFUTE/UNCERTAIN per finding → 08 (reuse
     VerificationSet). Confirm-all-no-justification → `synthesis_suspect` flag (soft, no re-ask).
  5. **ReviewMap builder** (deterministic, replaces idea S6/S7): merge findings BOTH reviewers
     independently raised via the **§487 matcher** (same file + overlapping lines + same category) →
     consensus; classify each by cross-exam verdict. NEW `ReviewMap` zod {consensus:Finding[],
     disputed:{finding,refutation}[], single_reviewer:Finding[], per_reviewer_stats} → 07 (new writer slot).
  6. **S9 judge=agy** (1 call, cwd = RUN-DIR not repo → sidesteps the agy --sandbox trap; judge only sees
     findings text): adjudicate disputed (REFUTEd) findings → UPHOLD/REJECT/UNRESOLVED + verdict (reuse
     JudgeReport) → 09.
  7. **Confidence (deterministic):** both-independent OR CONFIRMed→HIGH; single/UNCERTAIN→MEDIUM;
     REFUTEd+UPHOLD/UNRESOLVED→LOW; REFUTEd+REJECT→false-positive (excluded from P0/P1 table, separate
     "rejected" section).
  8. **S10 CR report** (pure): verdict → P0/P1 table → disagreement map (A-found/B-missed, contradictions,
     adjudications) → per-reviewer stats → raw links → final-report.md.
  - **Roles:** resolveRoles branches on workflow — code-review → s4=[claude,codex], judge=agy, verifier
     unused; config/flag overridable (hardcode per-workflow defaults per §271, NOT a general priority algo).
     Degradation <3 providers → judge falls back to a reviewer + `synthesis_suspect` (edge, low-pri).
  - **Engine tweaks:** `RunOptions.cwd` override (CLI passes repo root); RunWriter gets a `review-map`
     slot (07); `ctx.call` per-call cwd already exists (judge uses it).
  - **Tests (scripted, NO paid calls):** pure units (git-range, file:line validator drop-invalid, §487
     matcher/ReviewMap builder, confidence, S10 render, resolveRoles CR) + **scripted-adapter e2e** CR run
     (fake providers → S4→S10 wiring + budget, like engine.test.ts) + real temp-git diff-plumbing test incl.
     the §605 file:line-rejection. Live run on a real small diff = USER's manual §605 acceptance (give steps
     + cheap sample; no-live-paid-runs).
  - **Deferred:** resolve-CR vocab (fixed/wontfix/false-positive) + FeedbackEntry generalization
     (item_type finding|adjudication, verdict union, ruling→string) → **T11** (bench FP labeling, §487).
     agy --sandbox live verification still deferred (CR doesn't depend on it). Skill/validate.ts registry
     stays inline (idea precedent). Acceptance §605: real diff → adjudicated findings; unresolvable
     file:line rejected pre-model (tested).
- **T9 SHIPPED 2026-07-04 (as-built, do not re-litigate). No new pipeline stages.** Correction now fixed:
  `aiki resolve` = interactive **feedback annotation** → `.aiki/feedback.jsonl` (plan §127/§604/§444), NOT
  role overrides (`resolveRoles()` is an unrelated same-named internal fn; role pinning is a config concern).
  T9 = four pieces (all built + unit-tested in `test/t9.test.ts`, 35 tests):
  1. **`aiki show <run-id>` [`--raw`]** — complete run → cat `final-report.md`; `--raw` → list artifact
     files; partial/aborted (no final-report.md) → short summary from meta.json (exit_status, stages,
     flags) + "use --raw". Uses the shared run-id resolver (below).
  2. **`aiki resolve <run-id>`** — walks the run's **adjudicated contradictions** (artifacts 07
     DisagreementMap + 09 JudgeReport); user labels each ruling `correct/incorrect/unsure` (+optional
     note) → append to global **`.aiki/feedback.jsonl`** (append-only). Pure core
     (`buildFeedbackEntries`+`appendFeedback`, unit-tested) under a thin readline loop; non-interactive
     hook = repeatable `--verdict <id>=<c|i|u>` (drives §604 test headlessly — no TTY, no paid calls).
     JSONL line `{run_id, workflow, item_type:"adjudication", item_id, verdict, ruling(snapshot), at,
     note?}`, zod-validated. Verdict vocab workflow-aware (code-review fixed/wontfix/false-positive later).
  3. **`aiki config` [`--edit`]** — bare → print EFFECTIVE config (built-in defaults merged with
     `.aiki/config.json`) as JSON. `--edit` → open `.aiki/config.json` in $EDITOR/$VISUAL, create `{}` if
     missing; no $EDITOR → print path.
  4. **`.aiki/config.json` loading** — project-local (cwd), zod `{roles?:Partial<RoleMap>, budget?:number,
     deadlineMs?:number}`. `roles` = FLAT GLOBAL → feeds existing `resolveRoles(wf,avail,overrides)` for
     every workflow. Precedence **flag > config > default**. Missing = defaults; present-but-invalid =
     HARD-FAIL naming file+zod error (never silently ignore). Threaded into BOTH headless `run()` AND the
     TUI (app.tsx `resolveRoles` call + RunCtx budget — 2 additive edits). NO CLI role flags (config-only;
     `--budget` stays).
  - **Smoke cache** (§242, 6h): SEPARATE tool-owned **`.aiki/smoke-cache.json`** (`{provider:{pass,at,
     version}}`), NOT inside config.json — logged deviation from plan's literal "in config.json" (avoids
     clobbering the human-edited `config --edit` file). Consumed by `doctor`; add **`doctor --fresh`** to
     bypass. Entry stale if >6h OR detected version ≠ cached version. NO smoke on TUI launch (defer the §5
     "detect→smoke→panel" gap — would be a paid call every launch). Retires the T2/doctor smoke-cache debt.
  - **Shared run-id resolver** (show+resolve): exact dir name OR unique suffix/substring (so `8c44`
     works); ambiguous → list candidates; no-arg → most recent run.
  - **Files (go straight here):** `src/config/config.ts` (AikiConfig zod + `loadConfig`/`effectiveConfig`/
     `ConfigError`), `src/config/smoke-cache.ts` (`isFresh`/`toEntry`/`entryToSmoke`/read/write, pure core),
     `src/storage/runs-read.ts` (`matchRunId` pure + `listRuns`/`resolveRunId`/`readFinalReport`/
     `listArtifacts`), `src/storage/feedback.ts` (`FeedbackEntry` zod + `buildFeedbackEntries`/
     `parseVerdictFlags`/`appendFeedback`, pure core), `src/cli/{show,resolve,config}.ts`. Edits: `doctor.ts`
     (+`--fresh`, cache read/write), `run.ts` (config precedence), `cli/index.ts` (3 commands + config→TUI),
     `tui/{index,app}.tsx` (`AppProps` roleOverrides+budget), `context.ts` (exported DEFAULT_BUDGET/DEADLINE).
  - **DEVIATION (logged):** smoke cache is a separate `.aiki/smoke-cache.json`, NOT inside config.json as
     the plan's literal §242 text says — to avoid `doctor` clobbering the human-edited `config --edit` file.
     Corrupt/missing cache = silently empty (disposable); corrupt/missing *config* = hard-fail (user intent).
  - **Deferred (not a bug):** §5 "TUI detect→smoke→panel" — TUI still detect-only (no smoke on launch, would
     be a paid call each launch). `resolve` interactive readline path is NOT unit-tested (the `--verdict`
     non-interactive path is; readline shell is thin, like app.tsx). Verdict vocab is idea-only
     (correct/incorrect/unsure); code-review's fixed/wontfix/false-positive lands with T10.
- **Tuning debt:** S2 clustering + S2 prompt = **FIXED 2026-07-03** (overlap-coefficient + prompt
  hardening; see traps). Remaining low-priority: S7 blind-spot keyword matching is coarse → over-reports
  (e.g. flags "feasibility" as uncovered though discussed). Not blocking. **Do NOT touch the S7
  semantic-grouping model call — that's the working fix, not the coarse part.**
- **In-flight?** No half-written code. T12's buildable half is complete + green; the only remaining T12
  work is the USER's metered holdout eval + RESULTS fill (see "Next action"). See HANDOFF.

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
| T9 show / resolve / config | ✅ | show <run>, resolve (feedback→JSONL), config cmd, .aiki/config.json load + separate smoke-cache; 35 tests, CLI-verified |
| T10 code-review workflow | ✅ | bespoke S4→S10; §487 matcher (`sameFinding`); file:line validator; agy judge; 12 tests + scripted e2e |
| T11 bench harness + build set | ✅ | arms A–D, `sameFinding` scorer, resolve-CR, 5 cases/20 bugs, incremental results; 9 tests + scripted bench e2e |
| T12 freeze + holdout + RESULTS.md | 🔶 STAGE 0 DONE | 2 void attempts archived; Amendment A1 pre-declared; 6 pairs salvaged; harness: resume+estimate+`--yes`+guard+carry-forward+bench-findings persist; resolve falls back to bench-findings (A/B FP-labelable, 4 runs backfilled) — 161 tests. Awaiting USER: FP labels (free) + staged pass B,D (≈26 Opus) then B,C,D (+≈36) → fill + §23 verdict |

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
- **agy `--sandbox` write-blocking UNVERIFIED** — but **code-review SIDESTEPS it** (T10): the judge
  (agy) runs with cwd=RUN-DIR, never the repo, and only sees findings text, so it has no repo write path.
  Reviewers (claude/codex) are the ones at repo cwd and their read-only is verified. Still confirm agy's
  sandbox before any workflow gives agy repo cwd; record enforcement level in meta.json.
- **doctor runs live smoke = paid model calls.** Use `aiki doctor --no-smoke` during dev. The §8 6h
  smoke cache IS built now (T9): `.aiki/smoke-cache.json`, `doctor --fresh` bypasses, version-change busts it.
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
