# AIKI Report v3 — "Decision Brief that justifies the tokens" (plan)

Goal: the idea-refinement report must read like a staff briefing to a decision-maker (BLUF style):
a clear recommendation, the reasoning, the evidence, an executable validation plan, and a cost
receipt — so a user who spent ~11 frontier calls sees ALL of what they paid for. Task ids: T-R1…T-R7.
Rules of this repo apply unchanged: schema-bound stage outputs (§14), deterministic rendering (§263),
derived — never self-reported — confidence (§624), no new workflows (§3/§22).

> **STATUS: IMPLEMENTED (2026-07-08).** T-R1…T-R7 + the S0 contextual grill (§S0 below) are code-complete;
> 261 tests green + typecheck + build clean **under Node ≥20** (`nvm use 20` — Node 16 crashes vitest at
> startup with `crypto.getRandomValues is not a function`). Remaining is user-metered: one live idea run
> for visual/quality acceptance (§8). This doc is now the as-built record, not a to-do.

## 0. Diagnosis (why v2 under-delivers)

1. "Next steps" are string templates, not synthesized actions — the single weakest section.
2. No explicit decision: verdict prose exists, but no PROCEED / PROCEED-IF / PIVOT / STOP.
3. Paid-for artifacts never reach the HTML: assumption audit (held/failed/unverified),
   open questions, per-dispute who-said-what-who-won narrative.
4. No cost receipt (calls per provider) — cost honesty (§18.6) should be user-facing.
5. Per-model cards show semi-raw lines, not each model's position in one readable digest.

## S0. Contextual grill / intent preflight (IMPLEMENTED — added beyond the original v3 scope)

Front-loads intent BEFORE the council spends the expensive calls: one cheap analyst call turns the raw
idea into a structured brief + 3–4 context-specific questions. Interactive users answer them; headless
runs record explicit best-judgment defaults. Downstream stages then reason over a sharpened intent
instead of a vague sentence — the single biggest lever on report quality.

- **Schemas** (`src/schemas/index.ts`): `GrillQuestionAxis` (decision_frame | evaluation_lens |
  target_user | success_bar | non_negotiables | risk_context | evidence | alternatives | scope);
  `RunBriefQuestion` (id, axis, question, why_it_matters, 2–5 suggested_answers, strict);
  `RunBriefDraft` (subject; decision_frame/evaluation_lens/target_user nullable; constraints/
  claims_to_test/evidence_supplied/missing_axes arrays; 3–4 questions; dup-id refinement);
  `GrillAnswer` (question_id, answer, source ∈ user|suggested|default); `RunBrief` = draft + 3–4
  answers with an answer↔question integrity refinement.
- **Stage** (`src/orchestration/stages/s0-grill.ts`): `s0Grill` — one `S0` call on the analyst seat →
  `RunBriefDraft`; `normalizeAnswers` fills any missing/blank answer as `default`; writes
  `00b-run-brief.json`; `renderGrilledInput` builds enriched `inputs/idea-brief.md` (raw idea + brief +
  Q/A). Interactive path via `ctx.events.grill`; headless → `defaultGrillAnswers` ("Use best judgment").
- **Resume-safe**: raw `inputs/idea.md` is untouched; only the derived brief is enriched.
- **Downstream**: S1/S2/S4 consume `idea-brief.md`, not the raw sentence.
- **Cost**: +1 call → idea pipeline ≈12 calls / ~4 Opus; `DEFAULT_BUDGET` raised 12 → 13 so S9b keeps a
  one-repair cushion. `estimateRun` idea → `{calls: 12, opus: 4}`.
- **Tests**: `test/s0-grill.test.ts` (draft parse, answer normalization/defaults, grilled-input render).

## 1. Target report structure (HTML `council-view.html` + markdown `final-report.md`, same order)

1. **Bottom line** (BLUF): recommendation badge (PROCEED / PROCEED WITH CONDITIONS / PIVOT / STOP)
   + 1-2 sentence why + conditions list when PROCEED-IF. NEW model field (T-R1/T-R2).
2. **Chairman's reasoning** — exists (`key_points`). Keep.
3. **Dimension scorecard** — 12 rubric dimensions, each: `contested` (a dispute's claim text matches
   the dimension keywords) / `examined` (some claim matches) / `unexamined` (in `blind_spots`).
   Derived, best-effort keyword matching (same tokenizer as S7; label the section "best-effort").
   Pure function + tests (T-R4).
4. **Assumption audit table** — ALREADY DERIVED (`deriveAudit` in s10-render.ts, exported). Render in
   HTML too: statement · held/failed/unverified · HIGH/MED/LOW · which analysts (T-R6).
5. **Risks that held up** — exists. Keep, unchanged.
6. **The debate** (replaces "How each model saw it" as the primary divergence view): per contradiction,
   deterministic narrative — "<claimant> claimed <claim>. <attacker> countered: <argument>. Chair:
   <UPHOLD→'the objection stands' / REJECT→'the idea holds here' / UNRESOLVED→'left to you'> — <reasoning>."
   All from 07-map + 09-judge; zero new calls (T-R6). Keep the per-model cards AFTER it (digest first).
7. **Validation plan** — THE new synthesis (T-R3): ordered, executable actions (schema `ActionPlan`).
   Falls back to the current template list only when the planner call is skipped/failed (flagged).
8. **Open questions that flip the verdict** — exists in md (mergeOpenQuestions); surface in HTML (T-R6).
9. **Red-team note** — dissent + confidence_notes, prominent (small card, not buried in the fold). Exists.
10. **Receipt** — footer strip from meta: calls/budget, per-provider call counts, wall-clock, models
    (flag_profiles), flags. Deterministic (T-R6).
11. Technical fold (raw per-model output) + Copy-Markdown button — exist; extend markdown serializer
    to the new sections (T-R6).

## 2. Schema changes (T-R1) — `src/schemas/index.ts`

```ts
// JudgeReport gains (both optional → code-review unaffected; idea S9 prompt requires them):
recommendation?: z.enum(['PROCEED','PROCEED_WITH_CONDITIONS','PIVOT','STOP'])
conditions?: z.array(z.string()).max(6)   // required non-empty iff PROCEED_WITH_CONDITIONS (zod refinement on the strict schema; relaxed on JudgeReportModel, enforced by S9 with one re-ask)

// NEW ActionPlan (S9b output):
export const ActionPlan = z.object({
  actions: z.array(z.object({
    order: z.number().int().min(1),
    action: z.string().min(1),          // imperative, concrete ("Interview 5 target users about X")
    why: z.string().min(1),             // ties to a risk/blind spot/question
    validates: z.string().min(1),       // anchor: "D3" | "blind:business model" | "Q:<text>" — validator-checked
    effort: z.enum(['S','M','L']),
    kill_signal: z.string().min(1),     // the result that should kill/reshape the idea
  })).min(1).max(7),
  sequencing_note: z.string().min(1),   // why this order
}).strict();
```

## 3. S9 judge prompt (T-R2) — `s9-judge.ts`

Add to the output spec: `recommendation` (one of the four; PIVOT = core idea unsound but an adjacent
version is; STOP = load-bearing assumptions failed with no repair) and `conditions` (only for
PROCEED_WITH_CONDITIONS: each a checkable statement, not vibes). Enforcement mirror of dissent: missing/
inconsistent recommendation → one re-ask → else flag `synthesis_suspect` and default to
PROCEED_WITH_CONDITIONS with conditions = top upheld risks (deterministic fallback, honest flag).

## 4. S9b action-planner stage (T-R3) — NEW `src/orchestration/stages/s9b-plan.ts`

- Runs AFTER S9, idea workflow only. Provider: the judge seat (no new provider, no role change).
- Prompt inputs (JSON, schema-bound): contract.task, upheld risks (id+assumption+reasoning),
  blind_spots, merged open questions, recommendation. Instruction: write the validation plan a good
  staff officer would — cheapest decisive test first; every action anchored via `validates`; no
  action for anything already settled; ≤7.
- Deterministic validator after schema: every `validates` anchor must resolve (a real dispute id /
  blind-spot label / question text prefix) → drop unanchored actions; if 0 survive → one repair
  re-ask → else fall back to template list + flag `plan_fallback`.
- BUDGET GUARD: nominal idea pipeline ≈10 calls + this = 11 (default budget 12). If
  `budget.remaining < 2` at S9b start → skip the call, use template fallback, flag `plan_skipped`
  (never let the planner starve a repair). `estimateRun` idea estimate is `{calls: 12, opus: 4}` (T-R7;
  reflects the +1 S0 grill call — see §S0).
- Artifact: write via the run writer AFTER 09-judge-report and BEFORE final-report. INTEGRATION CHECK
  (RESOLVED at build): the RunWriter accepted the new artifact — it lands as `09b-action-plan.json`
  (after `09-judge-report.json`, before `final-report.md`).
- Skills seam: give S9b a `{{SKILL}}` slot + `skills/idea-refinement/planner.md` playbook (same add-to
  pattern; loadSkill already lints).

## 5. Scorecard derivation (T-R4) — pure, in `s10-render.ts` (exported for view.ts)

`deriveScorecard(rubric, map): Array<{id,label,status:'contested'|'examined'|'unexamined'}>` —
unexamined = label ∈ blind_spots; contested = any contradiction's contested-claim text shares a
keyword (S7 tokenizer); else examined. Unit-test all three states + the honesty cap (never throws,
coarse matching acceptable — same known coarseness as S7, documented).

## 6. Render (T-R5 md, T-R6 html)

- `s10-render.ts`: add Bottom line (recommendation + conditions), Validation plan (table: # · action ·
  why · validates · effort · kill signal + sequencing note), scorecard, receipt. Keep every existing
  section. Fail-soft: absent optional fields render nothing (old runs stay renderable).
- `council/view.ts`: sections in §1 order; recommendation badge tone: PROCEED=good,
  PROCEED_WITH_CONDITIONS/PIVOT=caution, STOP=risk; "The debate" narrative cards; audit table;
  open questions; receipt strip; extend `councilMarkdown` with all new sections (Copy button = full brief).
- Old-run compatibility test: render a fixture WITHOUT recommendation/plan → no new sections, no crash.

## 7. Tests (every task lands with its tests; model calls always faked)

- schemas: ActionPlan valid/invalid (anchor format free-text ok; caps; effort enum; strictness).
- s9b: fake adapter returns (a) good plan → merged; (b) unanchored actions → dropped, repair fires;
  (c) budget.remaining<2 → 0 calls + `plan_skipped`; (d) planner crash → fallback + `plan_fallback`.
- s9: recommendation enforcement (missing → re-ask → fallback + flag).
- scorecard: 3-state derivation.
- render md/html: new sections present with data, absent without (t9-style fixture test extension).
- e2e (t11-style, scripted): idea pipeline with fakes → 11 calls, plan artifact written, html has badge.

## 8. Acceptance (one live run, user-metered, after implementation)

On a genuinely contestable idea: badge + conditions present; ≥4 chairman bullets; scorecard with ≤3
unexamined; audit table rendered; debate section names who-vs-who + ruling; validation plan ≥4 anchored
actions with kill signals; receipt shows per-provider calls; Copy button yields the full brief as md.

## 9. Explicit non-goals

No build-roadmap ("step 1 scaffold repo…") — aiki vets, it doesn't architect. No new providers/roles.
No HTML for code-review changes beyond what falls out of shared code (its report is a later round).
No learned routing, no chat. Budget default raised 12 → 13 (S0 grill + S9b need the headroom).

Order (as built): S0 grill → T-R1 → T-R2 → T-R3 → T-R4 → T-R5 → T-R6 → T-R7 (estimate + README/CHANGELOG).
Each task gated the next (typecheck + tests green). All shipped; §8 acceptance (one live run) is the only
remaining, user-metered step.
