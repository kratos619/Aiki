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

## V5 — Consolidate & ship

README: what aiki is, the pre-registered verdict (exact qualified claim from RESULTS §7 — never
stronger), quickstart, `--cheap`, safety model (read-only, no keys), benchmark link. Run-cost
preview on `aiki run` (mirror bench's estimate+confirm; skip prompt when --yes/non-TTY). Version
bump, CHANGELOG. Acceptance: fresh-clone quickstart works on a stranger's repo with 3 CLIs installed.

---

## Deferred / rejected (decided 2026-07-05 — do not re-open without new evidence)

- **Desktop app: NO.** Users are terminal devs; Electron tax > entire current codebase; V3's HTML
  export + Council View covers the visual/shareable need. Revisit only on real external-user signal.
- **General Q&A / chat: NEVER in this product** (§3/§22 + economics: council adds cost not accuracy
  where one right answer exists). The V2 router explains this to users instead of half-supporting it.
- **4th provider, learned routing, write tools: forbidden as ever.**
