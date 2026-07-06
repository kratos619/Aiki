# AIKI v2 plan — post-verdict product round

v1 is DONE: thesis proven (RESULTS.md — D 100% vs B 77% recall, KC#1+KC#4 pass, KC#2 deferred),
`--cheap` shipped. This file is the v2 task list. Same rules as v1: §-refs point into
`plan/AIKI-build-plan.md`; forbidden scope (§3/§22) still applies — NO chat UI, NO desktop app,
NO new providers, NO learned routing, NO write/exec tools. Execute in order; do not start
V(n+1) while V(n) is red. Every task: typecheck + tests green before "done"; metered validation
is the USER's (no-live-paid-runs).

## Product line (do not drift from this)

aiki = a local model-council for judgment tasks (code review, idea stress-tests) where models can
meaningfully DISAGREE. It is NOT a general assistant. Trivia/chat inputs get routed away, not answered.

---

## V1 — S8-teeth (council actually debates)   [quality core; blocks V4]

Problem: cr-S8 cross-exam returns CONFIRM on ~everything (holdout: disputes on only 3/10 cases;
build: similar). Judge mostly dormant → "council" is two monologues + a rubber stamp.

Build:
1. Rework the S8 prompt contract (cr-s8 + idea s8-verify stay separate; touch cr only):
   reviewer MUST (a) rank the peer's findings weakest-first, (b) pick ≥1 finding to actively
   attempt to refute with file:line evidence, (c) REFUTE only with evidence, else UNCERTAIN with
   the specific doubt. Keep schema (VerificationSet) — this is a prompt+validation change.
2. Deterministic check: if a verification set is 100% CONFIRM with no ranked-weakest section →
   `synthesis_suspect` flag (exists) + one re-ask (mirror S9's retry pattern).
3. Unit tests: scripted adapter returning confirm-all → re-ask fired → flag set; refute-with-evidence
   flows into ReviewMap.disputed → judge path (existing units cover downstream).

Acceptance (V1): tests green (free). USER validation: `bench code-review --arms D --set build --yes`
(~10 Opus) → expect disputes > 0 on ≥2/5 cases and judge S9 calls in metas; recall must NOT drop
below 20/20 (if it drops, the teeth are cutting real findings — revert prompt, iterate on build set).

## V2 — Smart entry (aiki knows where it is)   [UX core]

1. Repo detect at TUI launch: if cwd is a git repo → banner line "repo: <name> — <n> changed files
   vs <default-branch>". Default-branch detect: `origin/HEAD` → fallback `main|master`.
2. Quick actions in TUI input screen: [r] review working tree (diff vs default branch, incl.
   uncommitted), [b] review branch (merge-base three-dot, existing path), [i] idea mode (current).
3. Headless parity: `aiki run code-review` with NO --base → default to merge-base with the detected
   default branch; keep explicit flags winning. Empty diff → existing "no changes" exit.
4. Input router (deterministic, NO model call): TUI free-text input classified — looks like a
   question/trivia (interrogatives, no code markers, short) → print the product line ("aiki
   stress-tests ideas and reviews code; for general questions use a single model — a council adds
   cost, not accuracy, when there's one right answer") + offer [i] if they meant an idea. Code-ish
   paste (diff markers, file paths) → offer review. Everything else → idea flow as today.
   Router = pure function + unit tests; NO general-Q&A path exists.

Acceptance (V2): unit tests for default-branch resolution, router classes, quick-action reducer
(pure). USER: open TUI in aiki repo itself, [r] reviews the working tree end-to-end (1 cheap run,
may use --cheap roles via config).

## V3 — Council View + HTML export   [the "professional/interactive" ask, done honestly]

1. TUI Council View (post-run screen): per-provider column (display names), findings/claims listed,
   consensus rows highlighted, disputes shown with the judge's ruling inline, verdict footer.
   Pure render over existing artifacts (07/09/final-report) — no new model calls, no schema changes.
2. `aiki show <run> --html`: render the same view + §6-style cost line into ONE self-contained
   static HTML file (inline CSS, no JS deps, no server) written next to the run dir; print the path.
   This is the shareable "professional" artifact instead of a desktop app.
3. Keep `show`/`show --raw` unchanged; `--html` is additive.

Acceptance (V3): unit test HTML renderer on a fixture run dir (golden-ish: contains provider names,
dispute count, verdict). USER: `aiki show <recent-run> --html` opens in a browser and reads well.

## V4 — Escalation ladder (needs V1 teeth)   [token endgame; NEW pre-registration]

Deterministic cascade for code-review (NOT learned — §22-safe):
tier1 = agy+codex hunt (as --cheap); escalate a claude call ONLY on (a) disputed findings (thin
judge, exists) or (b) coverage-hole: diff touches risk globs/keywords (auth/payment/crypto/async)
where tier1 reported zero findings in that category → ONE targeted claude hunt on those hunks only.
Pre-register as amendment L1 in BENCHMARK.md (build set, exploratory) BEFORE any metered run;
report strict AND category-relaxed recall (known matcher limitation, see HANDOFF 2026-07-05).
Acceptance: scripted-adapter e2e (hole triggers targeted call; no hole → 0 claude calls); USER:
build-set bench ladder-arm vs D, expect ≈D-adjusted recall at ≤0.5 claude/case.

## V5 — Consolidate & ship   [DONE 2026-07-06]

`README.md` (what aiki is + the EXACT RESULTS §7 verdict with caveats + requirements + install + quickstart
with the slash-command table + headless equivalents + models + sessions/resume + storage + safety model +
how-it-works + benchmark links). `CHANGELOG.md` (0.2.0 v2 product round). Version bump 0.1.0→**0.2.0**
(`package.json` + `cli/index.ts VERSION`). Run-cost preview on `aiki run`: `estimateRun(workflow,{cheap})`
(pure, tested) + a `--yes`/non-TTY-gated confirm before spending. `test/run-cost.test.ts` (2). 200 tests
green. **Remaining acceptance is manual (user):** fresh-clone quickstart on a stranger's repo with the 3
CLIs. **V4 escalation ladder is the only unstarted v2 item — BLOCKED on the V1 paid bench.**

---

## v2.1 — product-hardening round (added 2026-07-06, from real-use feedback)

Execute in order, same discipline. Decisions locked with the user 2026-07-06: **hybrid storage**
(config + session registry in `~/.aiki`; runs in the project's `.aiki/runs` when inside a repo, else
`~/.aiki/runs`) and **config + free model override** (pick provider AND type any model id per role;
adapters pass it through `--model`; no hardcoded versions; enumerate only where a CLI supports listing).

### V6 — Run-anywhere + resilience
1. **Hybrid runs root** — `src/storage/paths.ts` (`homeAikiRoot`, `resolveRunsRoot`); wired into engine
   `run()`, the TUI, and `show`/`resolve`. Library defaults stay `.aiki`; only CLI entry injects the
   hybrid root. **[DONE 2026-07-06]** (`test/paths.test.ts`).
2. **Timeouts raised** (real Opus judge blew them): per-call 180→300s, wall-clock 10→20min
   (`context.ts`, user-authorized §7.1/§19 deviation). **[DONE 2026-07-06]**
3. **Global session registry + resume** — `~/.aiki/sessions.jsonl` records every run {id, workflow, cwd,
   runsRoot, startedAt, status}; `aiki sessions` lists them cross-location; `aiki resume <id>` re-enters a
   killed/timed-out run. **[DONE 2026-07-06]** — implemented via CALL REPLAY (cleaner than stage-skip): the
   pipeline re-runs into a fresh run and `RunCtx.call` replays any completed `(provider,prompt)` from the
   old run's `raw/` outputs, so only the failed stage onward hits a model. Replayed calls don't spend
   budget and don't count as new calls. `$AIKI_HOME` overrides `~/.aiki` (tests + relocation).
   `test/resume.test.ts` (5): full replay → 0 real calls; S9-fail → only judge re-called; registry CRUD.

### V7 — Intent clarify UX (S2 misunderstanding guard)   [DONE 2026-07-06]
`1`/`2`/…/`N+1 = both (combine all)`/`N+2 = other (type your own)` on the clarify prompt, fed back into S3.
`RunEvents.clarify` now returns `ClarifyChoice` (`pick`|`both`|`text`); `s2Misread` maps it to
`chosen.how` = user-selected|user-combined|user-typed; TUI (`app.tsx`) renders the extra options + a
text-entry sub-mode. Tests: `test/s2-clarify.test.ts` (4).
Near-identical readings: added STOPWORD + restatement-framing removal to `cluster.ts tokenize` (content-word
overlap), so same-meaning readings that only differ in framing now merge; the 0.6 threshold is UNCHANGED
(loosening it = false merges = proceeding on a wrong reading, a documented trap). `test/cluster.test.ts`
(+3). **Residual limitation (honest):** bag-of-words still can't merge different-vocabulary/inflected
paraphrases (cli vs clis, orchestration vs orchestrate) — that's WHY the human stays in the loop; `both`
is the reliable one-key merge. No stemming (would risk false merges).

### V8 — Model config (per-provider model)   [DONE 2026-07-06]
Verified flags (docs/PROVIDER_NOTES.md): **claude `--model <alias|name>`, codex `-m/--model` (before the
prompt), agy `--model` + `agy models` LISTS** (only agy enumerates). Implemented as **per-provider** model
(each CLI runs its own families, so provider granularity is the natural fit for "judge model" + each
"hunter model" — simpler + lower-risk than per-role-seat). Config: `models: {claude?,codex?,agy?}` in
`AikiConfig`; **config layering** via `loadLayeredConfig` (global `~/.aiki/config.json` base + project
`.aiki/config.json` override; `mergeConfig` merges roles/models keys). Threading: config.models →
`RunOptions.providerModels`/`AppProps.providerModels` → `setupProviders(models)` sets `FlagProfile.model` →
adapter `buildArgs` adds `--model <id>` (recorded in meta.flag_profiles). `aiki models` lists via `agy
models` (closing stdin — agy blocks without a TTY) else free-text; shows current pins + how to set.
`$AIKI_HOME` overrides `~/.aiki`. No hardcoded versions. Tests: `test/v8-models.test.ts` (6, injected-spawn
argv + schema + mergeConfig) + t9 effective-config updated. Live-verified `aiki models`/`config` with pins.

### V9 — Slash-command home (UI/UX pass)   [DONE 2026-07-06]
TUI entry reworked into a home screen: banner + version + a text box driven by deterministic slash commands
`/idea <text>`, `/review [--branch]`, `/resume <id>`, `/sessions`, `/models`, `/config`, `/help` — replacing
the single-key r/b/i. `parseCommand` (pure) in `smart-entry.ts` + `COMMANDS`; non-slash text still falls
through `routeInput` (idea / route-away). `/sessions`/`/models`/`/config`/`/help` render into an in-screen
panel (no phase change); `/resume` locates the run (registry/`findSession`), recovers input, builds the
replay cache, and starts a run with `replay` (startRun gained a `replay` param). `formatModels()` extracted
from `modelsCommand` for the panel. Still a router NOT chat (§3/§22). Removed the vestigial `routedIdea`
state. Tests: `test/tui.test.ts` +3 (parseCommand). TUI render = manual acceptance (per precedent); module
graph load-verified.

---

**v2.1 hardening round (V6–V9) COMPLETE 2026-07-06.** Remaining from the original v2 plan: V4 escalation
ladder (BLOCKED on the V1 paid bench) and V5 consolidate & ship.

---

## Deferred / rejected (decided 2026-07-05 — do not re-open without new evidence)

- **Desktop app: NO.** Users are terminal devs; Electron tax > entire current codebase; V3's HTML
  export + Council View covers the visual/shareable need. Revisit only on real external-user signal.
- **General Q&A / chat: NEVER in this product** (§3/§22 + economics: council adds cost not accuracy
  where one right answer exists). The V2 router explains this to users instead of half-supporting it.
- **4th provider, learned routing, write tools: forbidden as ever.**
