# BENCHMARK-IDEA-V3.md — pre-registered decision-council evaluation

**Status: PRE-REGISTERED 2026-07-10. Frozen at the user commit containing R0.**

No paid idea-v3 comparison has run under this protocol. The commit containing this file, the scorer at
`src/bench/scoring/decision-insights.ts`, and the initial build fixtures is the freeze boundary. After that
commit, this document and the scorer contract are append-only. Any amendment must be dated, justified, and
reported beside the final result; it cannot retroactively change an earlier score.

The existing `BENCHMARK.md` remains frozen and unchanged. Water-reminder and nurse-marketplace outputs were
already inspected, so both are build-only cases and can never support a holdout claim.

## 1. Question and arms

The primary question is whether an evidence-grounded cross-provider council surfaces more correct,
decision-critical insight than a strong single model or same-provider self-consistency.

| Arm | Frozen description |
|---|---|
| **B** | Best single available provider, one call, using a strong structured adversarial prompt: analyze, self-attack, and issue a decision brief. This is the primary baseline. |
| **C** | The same provider and prompt as B, sampled independently three times, followed by one same-provider synthesis call. No sample sees another before synthesis. Nominal cost: 4 calls. |
| **D2** | The current two-scout Aiki idea pipeline at the R0 freeze. Build-set diagnostic only; it carries no holdout weight. |
| **R** | The v3 evidence-grounded council after R1–R7 and the build-tuning freeze. Its prompts, schemas, lanes, roles, model selections, thresholds, and report contract must be committed before the holdout run. |

The provider/model used by B is selected once on the build set, recorded with the build results, and then
fixed for B and C before any holdout case is opened. Role or lane rotations are build-only. R may not add a
fourth provider, hosted API, API key, learned router, write tool, or unbounded debate.

## 2. Sets and contamination rules

- **Build:** 8 tuning cases. The R0 fixtures capture the two already-inspected cases under
  `bench/sets/idea-refinement/build/`. Six further authored build cases must use the same manifest schema and
  be committed before the first paid v3 build comparison.
- **Holdout:** 12 unseen cases, sealed until the R protocol is frozen. There is one scored holdout pass.
- Across the 12 holdout cases, tags may overlap, but the set must contain at least: 2 obvious decisions,
  2 contestable decisions, 2 ambiguous decisions, 2 evidence-rich cases, 2 evidence-poor cases, 2 cases
  requiring current facts, 2 regulated cases, 1 technical decision, 1 marketplace decision, and 1
  non-commercial decision.
- Every case is authored before its first model call and contains: the input, decision-critical claims,
  acceptable stances, evidence requirements, common false claims, all 12 required analysis dimensions, a
  source pack, and acceptable unresolved outcomes.
- An empty source pack is valid only for an intentionally evidence-poor case. It makes unsupported current
  claims ineligible as true positives; model memory is not evidence.

No build output, including water or nurse artifacts, may be copied into a holdout manifest. No case or arm
may be dropped after results are seen.

## 3. Primary metric: decision-critical insight F1

The single primary metric is **micro decision-critical insight F1** across all cases.

Before any arm runs, experts write each load-bearing proposition and its acceptable stance(s). After each
run, raters extract every load-bearing claim used to justify the report's recommendation. Cosmetic detail
and explicitly non-load-bearing background do not enter the precision denominator.

A pre-written expert claim counts as recalled only when:

1. a report claim is adjudicated as the same proposition;
2. the report's stance is one of the pre-written acceptable stances;
3. the report claim is judged correct and decision-relevant; and
4. when the expert claim requires evidence, the cited evidence supports the exact claim.

A reported load-bearing claim counts as a precision true positive only when it is judged correct and
decision-relevant. A current factual claim additionally requires supporting evidence. A correct novel claim
may improve precision but cannot improve recall. Matching is one-to-one: one report claim cannot satisfy two
expert claims, and duplicate paraphrases cannot score the same expert claim twice.

- Recall = matched expert claims / all expert claims.
- Precision = correct, relevant, evidence-eligible report claims / all reported load-bearing claims.
- F1 = harmonic mean of precision and recall; it is 0 if either both rates are 0 or no claim is scored.
- Aggregate counts are summed before rates are calculated. Per-case macro F1 is diagnostic only.

The frozen executable contract is `DecisionInsightAdjudication` and `scoreDecisionInsights` in
`src/bench/scoring/decision-insights.ts`.

## 4. Blind adjudication

Provider names, model names, run ids, call logs, report order, and stylistic provider tells are removed or
normalized before rating. Report order is randomized independently per rater. Raters do not see arm labels,
costs, or one another's labels.

At least three human raters independently label:

- which report claims are load-bearing;
- correctness and decision relevance;
- `CURRENT_FACT`, `DURABLE_FACT`, or `INFERENCE`;
- `SUPPORTED`, `UNSUPPORTED`, or `NOT_REQUIRED` evidence status;
- stance (`SUPPORT`, `OPPOSE`, `QUALIFY`, or `UNRESOLVED`); and
- semantic match to a pre-written expert claim.

A boolean or categorical label needs at least 2 of 3 votes. A claim pair enters the scorer only when at least
2 raters select the same pair. If accepted pairs collide, the pair with more votes survives; an equal-vote
collision scores neither pair. If stance has no majority, the claim cannot satisfy recall. Raw ratings and
the resolved adjudication are retained. Raters may not discuss a case until their independent labels are
locked.

Subjective actionability and pairwise preference use the same blinding, at least three raters, and
position-randomized reports. A pairwise case is won only when a majority prefers the same arm.

## 5. Pre-registered gates

R passes the primary quality claim only if, on the frozen holdout:

1. `F1(R) > F1(B)` and `F1(R) >= 1.20 × F1(B)`; and
2. `F1(R) > F1(C)` and `F1(R) >= 1.10 × F1(C)`.

Both comparisons are required. D2 cannot rescue a loss. Secondary metrics cannot rescue a primary-metric
loss.

Additional product gates:

| Gate | Threshold |
|---|---|
| Load-bearing factual precision | At least 95% supported by cited evidence or explicitly marked `UNVERIFIED`/`INFERENCE` |
| Citation support | At least 95% of cited evidence cards support the exact linked claim |
| Coverage | 100% of required dimensions end as `ASSESSED`, `NOT_APPLICABLE`, or `MISSING_EVIDENCE` |
| Genuine-disagreement precision | At least 90% contain opposing stances on the same normalized proposition |
| Validation plan | Every action has method, sample/source, metric, threshold, kill/pivot signal, timebox, and claim anchor; at least 90% score 4/5 or better for blinded actionability |
| Honesty | Unsupported current facts and unresolved decision-critical claims are never rendered as settled conclusions |
| Blind preference | R wins a majority of raters on at least 70% of holdout cases |

Secondary reporting also includes factual precision, evidence freshness, disagreement recall, calibrated
`UNRESOLVED` outcomes, unique verified contribution per provider, coverage, preference, actionability, calls,
per-provider calls, wall-clock, repairs, fallbacks, and failures.

## 6. Cost and operational gates

- **Council mode:** at most 8 nominal provider calls per case and median wall-clock at most 5 minutes.
- **Research mode:** at most 10 nominal provider calls per case and median wall-clock at most 8 minutes.
- Every attempted call counts, including retries and schema repairs. Skips, fallbacks, timeouts, and provider
  failures are reported per arm and case.
- B's nominal cost is 1 call and C's is 4. D2 and R report actual totals; quality is never presented without
  the adjacent cost and failure table.

Passing F1 while failing an operational gate may support a research result, but not a claim that the product
passed all gates.

## 7. Failure and negative-result policy

- An arm failure stays in the dataset. Its case contributes all expert claims and zero matched claims; any
  usable load-bearing report claims still enter precision. Attempted costs remain counted.
- A provider or infrastructure failure before any output may be retried once only if the failure and retry
  are recorded before the case is inspected. A semantic, schema, repair, or low-quality output is a result,
  not infrastructure, and cannot be rerun away.
- R losing or tying B or C is published with the same prominence as a win. The claim becomes "no measured
  cross-provider advantage under this protocol," regardless of secondary wins.
- Failed thresholds are not lowered after build or holdout results. New thresholds require a dated amendment,
  a newly frozen protocol version, and a fresh holdout.
- No "10/10," "best," or "beats one model" language is allowed unless the corresponding frozen gates pass.

## 8. R0 fixture inventory

Build manifests use the `IdeaV3CaseManifest` schema in the frozen scorer module.

- `01-water-reminder/`: sanitized input and expert case manifest; intentionally evidence-poor.
- `02-nurse-marketplace/`: sanitized input and expert case manifest; intentionally evidence-poor and
  regulated.
- `02-nurse-marketplace/regression/07-disagreement-map.json`
- `02-nurse-marketplace/regression/08-verifications.json`
- `02-nurse-marketplace/regression/09-judge-report.json`
- `02-nurse-marketplace/regression/09b-first.out`
- `02-nurse-marketplace/regression/09b-repair.out`

The regression captures are defect-reproduction data, not ground truth. They exclude prompts, home paths,
credentials, tokens, provider configuration, run metadata, and unrelated artifacts.
