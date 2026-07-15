// S9 — chair adjudication over graph-selected escalations. Consensus and shared concerns are
// read-only context; anonymous position text and the verifier record cross the boundary unchanged.

import type { DecisionGraph } from '../decision-graph.js';
import { selectEscalations } from '../decision-graph.js';
import type { ClaimVerificationSet, IdeaChairReportModel as IdeaChairReportModelT, IntentContract, JudgeReport as JudgeReportT, RebuttalEventSet, Recommendation } from '../../schemas/index.js';
import { IdeaChairReportModel } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { RubricItem } from './s7-decision-graph.js';
import { claimVerificationRefIssues } from './s8-verify.js';

type Adjudication = JudgeReportT['adjudications'][number];

const EMPTY_REBUTTALS: RebuttalEventSet = {
  round: 1,
  selected_claim_ids: [],
  events: [],
  stop_reason: 'NO_ESCALATIONS',
};

const S9_PROMPT = `ROLE: Judge. Adjudicate ONLY the anonymous escalated claim IDs below. Settled claims
and shared concerns are read-only context; do not re-litigate them. A context node tagged
UNRESOLVED_SELF_AUTHORED may not be adjudicated or carry the recommendation. Apply this rubric:
{{RUBRIC_JSON}}

Output ONLY JSON matching the judge schema:
- adjudications: each escalated id with valid verification evidence → {claim_id, ruling:
  HOLDS|FAILS|UNRESOLVED, reasoning ≤3 sentences, evidence_ids: [IDs from that claim's verification],
  effect_on_decision, and what_would_change_it when UNRESOLVED}.
  Omit claims with no evidence IDs; they remain unresolved. Never emit evidence_cited prose.
- verdict: a clear 2-5 sentence recommendation grounded in adjudicated and settled claims.
- recommendation: PROCEED, PROCEED_WITH_CONDITIONS, PIVOT, or STOP.
- conditions: required only for PROCEED_WITH_CONDITIONS; a JSON array of AT MOST 6 checkable strings —
  merge related checks rather than exceeding 6.
- recommendation_claim_ids: 1-8 graph claim IDs carrying the verdict's load-bearing reasons.
- condition_claim_ids: required only for PROCEED_WITH_CONDITIONS; 1-8 graph IDs anchoring its conditions.
- pivot: required only for PIVOT; {changed_claim_id, new_risk_claim_id}, both existing graph IDs.
- strongest_counter_case: {claim_ids (1-4), reasoning}; it must argue against the verdict from the same graph.
- key_points: 4-8 standalone decision-relevant bullets.
- dissent: a JSON array of strings (an array even when there is only one) — the strongest arguments
  against your verdict.
- confidence_notes: explain calibrated confidence.
ESCALATED CLAIMS + VERIFICATION: {{ESCALATIONS_JSON}}
APPEND-ONLY REBUTTAL EVENTS: {{REBUTTALS_JSON}}
SETTLED/UNRESOLVED CONTEXT: {{CONTEXT_JSON}}`;

export function adjudicationScopeViolations(report: { adjudications: Array<{ id: string }> }, ids: Iterable<string>): string[] {
  const allowed = new Set(ids);
  return report.adjudications.map((item) => item.id).filter((id) => !allowed.has(id));
}

export function recommendationIssues(report: { recommendation?: Recommendation; conditions?: string[] }): string[] {
  const issues: string[] = [];
  const hasConditions = (report.conditions?.length ?? 0) > 0;
  if (!report.recommendation) issues.push('recommendation is required');
  if (report.recommendation === 'PROCEED_WITH_CONDITIONS' && !hasConditions) issues.push('conditions are required for PROCEED_WITH_CONDITIONS');
  if (hasConditions && report.recommendation !== 'PROCEED_WITH_CONDITIONS') issues.push('conditions are only valid with PROCEED_WITH_CONDITIONS');
  return issues;
}

export function chairRecommendationIssues(
  report: Pick<JudgeReportT, 'recommendation' | 'recommendation_claim_ids' | 'condition_claim_ids' | 'pivot' | 'strongest_counter_case' | 'adjudications'>,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
): string[] {
  const issues: string[] = [];
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const recommendationIds = report.recommendation_claim_ids ?? [];
  if (recommendationIds.length === 0) issues.push('recommendation_claim_ids are required');
  for (const id of recommendationIds) if (!claimById.has(id)) issues.push(`unknown recommendation claim id: ${id}`);
  if (recommendationIds.length > 0 && !recommendationIds.some((id) => claimById.get(id)?.load_bearing)) {
    issues.push('recommendation must reference a load-bearing claim');
  }

  const counter = report.strongest_counter_case;
  if (!counter) issues.push('strongest counter-case is required');
  for (const id of counter?.claim_ids ?? []) if (!claimById.has(id)) issues.push(`unknown counter-case claim id: ${id}`);

  if (report.recommendation === 'PIVOT') {
    if (!report.pivot) issues.push('pivot claim links are required for PIVOT');
    else {
      if (!claimById.has(report.pivot.changed_claim_id)) issues.push(`unknown pivot changed claim id: ${report.pivot.changed_claim_id}`);
      if (!claimById.has(report.pivot.new_risk_claim_id)) issues.push(`unknown pivot risk claim id: ${report.pivot.new_risk_claim_id}`);
      if (report.pivot.changed_claim_id === report.pivot.new_risk_claim_id) issues.push('pivot must name a distinct new risk claim');
    }
  } else if (report.pivot) {
    issues.push('pivot links are only valid for PIVOT');
  }

  const conditionIds = report.condition_claim_ids ?? [];
  if (report.recommendation === 'PROCEED_WITH_CONDITIONS' && conditionIds.length === 0) {
    issues.push('condition_claim_ids are required for PROCEED_WITH_CONDITIONS');
  }
  if (report.recommendation !== 'PROCEED_WITH_CONDITIONS' && conditionIds.length > 0) {
    issues.push('condition_claim_ids are only valid for PROCEED_WITH_CONDITIONS');
  }
  for (const id of conditionIds) if (!claimById.has(id)) issues.push(`unknown condition claim id: ${id}`);

  if (report.recommendation === 'STOP') {
    const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
    const rulingById = new Map(report.adjudications.map((item) => [item.id, item.ruling]));
    const positionById = new Map(graph.positions.map((position) => [position.id, position]));
    const failed = recommendationIds.some((id) => {
      const claim = claimById.get(id);
      if (!claim?.load_bearing) return false;
      if (verificationById.get(id)?.status === 'CONTRADICTED') return true;
      if (claim.state === 'DISAGREEMENT') return rulingById.get(id) === 'UPHOLD';
      const stances = claim.position_ids.map((positionId) => positionById.get(positionId)?.stance);
      return claim.state === 'SHARED_CONCERN' || (claim.state === 'UNIQUE' && stances.includes('OPPOSE'));
    });
    if (!failed) issues.push('STOP requires a failed load-bearing claim');
  }
  return issues;
}

function adjudicationDetailViolations(report: JudgeReportT): string[] {
  return report.adjudications.flatMap((item) => [
    ...(!item.effect_on_decision ? [`${item.id}: missing effect_on_decision`] : []),
    ...(item.ruling === 'UNRESOLVED' && !item.what_would_change_it ? [`${item.id}: missing what_would_change_it`] : []),
  ]);
}

export function adjudicationEvidenceViolations(
  report: { adjudications: Array<{ id: string; ruling: string; evidence_ids?: string[] }> },
  verifications: ClaimVerificationSet,
): string[] {
  const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
  return report.adjudications.flatMap((item) => {
    const verification = verificationById.get(item.id);
    if (!verification) return [`${item.id}: missing claim verification`];
    if (!item.evidence_ids?.length) return [`${item.id}: missing evidence_ids`];
    const allowed = new Set(verification.evidence_ids);
    const bad = item.evidence_ids.filter((id) => !allowed.has(id));
    const unsettled = (verification.status === 'PARTIAL' || verification.status === 'UNVERIFIABLE') && item.ruling !== 'UNRESOLVED';
    return [
      ...(bad.length ? [`${item.id}: invalid evidence ids ${bad.join(', ')}`] : []),
      ...(unsettled ? [`${item.id}: ${verification.status} verification requires UNRESOLVED`] : []),
    ];
  });
}

export function demoteSelfAuthored(adjudications: Adjudication[], graph: DecisionGraph, judgeProvider: ProviderId): Adjudication[] {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  return adjudications.map((adjudication) => {
    const claim = claimById.get(adjudication.id);
    const providers = new Set(claim?.position_ids.map((id) => positionById.get(id)?.provider).filter((provider): provider is ProviderId => provider !== undefined));
    const judgeAuthored = providers.has(judgeProvider);
    return judgeAuthored && adjudication.ruling !== 'UNRESOLVED'
      ? { ...adjudication, ruling: 'UNRESOLVED' as const }
      : adjudication;
  });
}

/** Exclude judge-authored nodes before prompt construction, not merely after a ruling is returned. */
export function adjudicableClaimIds(graph: DecisionGraph, ids: Iterable<string>, judgeProvider: ProviderId): string[] {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  return [...ids].filter((id) => !claimById.get(id)?.position_ids
    .some((positionId) => positionById.get(positionId)?.provider === judgeProvider));
}

function fallbackConditions(graph: DecisionGraph, adjudications: Adjudication[]): string[] {
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const upheld = adjudications
    .filter((item) => item.ruling === 'UPHOLD')
    .map((item) => `Proceed only if you can resolve: ${claimById.get(item.id)?.proposition ?? item.id}.`);
  const holes = graph.holes.coverage.map((hole) => `Proceed only after examining the ${hole.label} gap.`);
  const evidenceHoles = graph.holes.evidence.map((hole) => `Proceed only after resolving evidence gap ${hole.claim_id}: ${hole.reason}.`);
  return [...upheld, ...holes, ...evidenceHoles, 'Proceed only after one cheap test confirms the core user need.'].slice(0, 6);
}

export function buildJudgePrompt(
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  rubric: RubricItem[],
  rebuttals: RebuttalEventSet = EMPTY_REBUTTALS,
  judgeProvider?: ProviderId,
): string {
  return judgeInput(contract, graph, verifications, rubric, rebuttals, judgeProvider).prompt;
}

function judgeInput(
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  rubric: RubricItem[],
  rebuttals: RebuttalEventSet,
  judgeProvider?: ProviderId,
): { prompt: string; evidenceRefs: Map<string, string> } {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
  const citedEvidence = [...new Set([
    ...verifications.verifications.flatMap((item) => item.evidence_ids),
    ...rebuttals.events.flatMap((item) => item.evidence_ids),
  ])];
  const evidenceRefs = new Map(citedEvidence.map((id, index) => [`E${index + 1}`, id]));
  const aliasByEvidence = new Map([...evidenceRefs].map(([alias, id]) => [id, alias]));
  const selectedIds = selectEscalations(graph, { max: 8 }).map((item) => item.claim_id);
  const eligibleIds = judgeProvider ? adjudicableClaimIds(graph, selectedIds, judgeProvider) : selectedIds;
  const escalationIds = new Set(eligibleIds);
  const escalations = graph.claims.filter((claim) => escalationIds.has(claim.id)).map((claim) => {
    const verification = verificationById.get(claim.id);
    return {
      id: claim.id,
      proposition: claim.proposition,
      positions: claim.position_ids.map((id) => {
        const position = positionById.get(id)!;
        return { stance: position.stance, reasoning: position.reasoning };
      }),
      verification: verification ? {
        ...verification,
        evidence_ids: verification.evidence_ids.map((id) => aliasByEvidence.get(id) ?? id),
      } : {
        claim_id: claim.id,
        status: 'UNVERIFIABLE',
        reasoning: 'No verifier record.',
        evidence_ids: [],
        missing_evidence: ['independent verification'],
      },
    };
  });
  const context = graph.claims.filter((claim) => !escalationIds.has(claim.id)).map((claim) => ({
    id: claim.id,
    proposition: claim.proposition,
    state: claim.state,
    evidence_state: claim.evidence_state,
    evidence_hole: graph.holes.evidence.find((hole) => hole.claim_id === claim.id)?.reason,
    ...(selectedIds.includes(claim.id) ? { adjudication: 'UNRESOLVED_SELF_AUTHORED' } : {}),
  }));
  const rebuttalContext = rebuttals.events.filter((event) => escalationIds.has(event.claim_id)).map((event) => ({
    claim_id: event.claim_id,
    response: event.response,
    reasoning: event.reasoning,
    evidence_ids: event.evidence_ids.map((id) => aliasByEvidence.get(id) ?? id),
    ...(event.narrowed_proposition ? { narrowed_proposition: event.narrowed_proposition } : {}),
  }));
  const prompt = S9_PROMPT
    .replace('{{RUBRIC_JSON}}', JSON.stringify(rubric.map((item) => item.label)))
    .replace('{{ESCALATIONS_JSON}}', JSON.stringify(escalations, null, 2))
    .replace('{{REBUTTALS_JSON}}', JSON.stringify(rebuttalContext, null, 2))
    .replace('{{CONTEXT_JSON}}', JSON.stringify(context, null, 2))
    .concat(`\nTASK: ${contract.task}`);
  return { prompt, evidenceRefs };
}

export async function s9Judge(
  ctx: RunCtx,
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  rubric: RubricItem[],
  rebuttals: RebuttalEventSet = EMPTY_REBUTTALS,
): Promise<JudgeReportT> {
  const selectedIds = selectEscalations(graph, { max: 8 }).map((item) => item.claim_id);
  const verificationIssues = claimVerificationRefIssues(graph, verifications, selectedIds);
  if (verificationIssues.length) throw new StageError('S9', 'BAD_OUTPUT', `invalid verification references: ${verificationIssues.join('; ')}`);
  const ids = adjudicableClaimIds(graph, selectedIds, ctx.roles.judge);
  const selfAuthored = new Set(selectedIds.filter((id) => !ids.includes(id)));
  const input = judgeInput(contract, graph, verifications, rubric, rebuttals, ctx.roles.judge);
  const basePrompt = input.prompt;
  const judge = ctx.handle(ctx.roles.judge);
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const legacyRuling = (claimId: string, ruling: IdeaChairReportModelT['adjudications'][number]['ruling']) => {
    if (ruling === 'UNRESOLVED') return 'UNRESOLVED' as const;
    const firstPosition = positionById.get(claimById.get(claimId)?.position_ids[0] ?? '');
    const propositionIsObjection = firstPosition?.stance === 'OPPOSE';
    if (ruling === 'HOLDS') return propositionIsObjection ? 'UPHOLD' as const : 'REJECT' as const;
    return propositionIsObjection ? 'REJECT' as const : 'UPHOLD' as const;
  };
  const translateChairReport = (value: IdeaChairReportModelT): JudgeReportT => {
    const { adjudications, ...report } = value;
    return {
      ...report,
      adjudications: adjudications.map((item) => ({
        id: item.claim_id,
        // Legacy reports rule on the objection; translate relative to the preserved proposition stance.
        ruling: legacyRuling(item.claim_id, item.ruling),
        reasoning: item.reasoning,
        evidence_ids: item.evidence_ids.map((id) => input.evidenceRefs.get(id) ?? id),
        effect_on_decision: item.effect_on_decision,
        what_would_change_it: item.what_would_change_it,
      })),
    };
  };
  // Preserve one call for the planner. A chair repair is allowed only when a third call remains.
  let report = translateChairReport(await jsonCall(ctx, judge, 'S9', basePrompt, IdeaChairReportModel, {
    repair: ctx.budget.limit - ctx.budget.used >= 3,
  }));

  let violations = adjudicationScopeViolations(report, ids);
  let evidenceViolations = adjudicationEvidenceViolations(report, verifications);
  let recIssues = recommendationIssues(report);
  let chairIssues = [
    ...chairRecommendationIssues(report, graph, verifications),
    ...adjudicationDetailViolations(report),
    ...(report.recommendation_claim_ids?.filter((id) => selfAuthored.has(id)).map((id) => `${id}: judge-authored claim cannot carry the recommendation`) ?? []),
  ];
  if (
    (violations.length || evidenceViolations.length || report.dissent.length === 0 || recIssues.length || chairIssues.length)
    && ctx.budget.limit - ctx.budget.used > 1
  ) {
    const repair = `${basePrompt}\n\n---\nCorrect these problems:\n`
      + (violations.length ? `- adjudications may reference only [${ids.join(', ')}], not ${violations.join(', ')}\n` : '')
      + (evidenceViolations.length ? `- evidence reference errors: ${evidenceViolations.join('; ')}\n` : '')
      + (report.dissent.length === 0 ? '- dissent must contain at least one item\n' : '')
      + (recIssues.length ? `- ${recIssues.join('; ')}\n` : '')
      + (chairIssues.length ? `- chair contract errors: ${chairIssues.join('; ')}\n` : '')
      + 'Output ONLY corrected JSON.';
    try {
      report = translateChairReport(await jsonCall(ctx, judge, 'S9-repair', repair, IdeaChairReportModel, {
        repair: ctx.budget.limit - ctx.budget.used > 2,
      }));
      violations = adjudicationScopeViolations(report, ids);
      evidenceViolations = adjudicationEvidenceViolations(report, verifications);
      recIssues = recommendationIssues(report);
      chairIssues = [
        ...chairRecommendationIssues(report, graph, verifications),
        ...adjudicationDetailViolations(report),
        ...(report.recommendation_claim_ids?.filter((id) => selfAuthored.has(id)).map((id) => `${id}: judge-authored claim cannot carry the recommendation`) ?? []),
      ];
    } catch (error) {
      if (isFatal(error)) throw error;
    }
  }

  const allowed = new Set(ids);
  const inScope = report.adjudications.filter((item) => allowed.has(item.id));
  const evidenceValid = inScope.filter((item) => adjudicationEvidenceViolations({ adjudications: [item] }, verifications).length === 0)
    .filter((item) => adjudicationDetailViolations({ ...report, adjudications: [item] }).length === 0)
    .map(({ evidence_cited: _legacy, ...item }) => item);
  if (evidenceValid.length !== report.adjudications.length) ctx.addFlag('synthesis_suspect');
  const adjudications = demoteSelfAuthored(evidenceValid, graph, ctx.roles.judge);
  let dissent = report.dissent;
  if (dissent.length === 0) {
    ctx.addFlag('synthesis_suspect');
    dissent = ['(none produced — flagged synthesis_suspect)'];
  }
  let recommendation = report.recommendation;
  let conditions = report.conditions;
  let recommendationClaimIds = report.recommendation_claim_ids;
  let conditionClaimIds = report.condition_claim_ids;
  let pivot = report.pivot;
  let strongestCounterCase = report.strongest_counter_case;
  if (recIssues.length || evidenceViolations.length || chairIssues.length) {
    ctx.addFlag('synthesis_suspect');
    recommendation = 'PROCEED_WITH_CONDITIONS';
    conditions = fallbackConditions(graph, adjudications);
    const anchors = graph.claims.filter((claim) => claim.load_bearing && !selfAuthored.has(claim.id)).slice(0, 6).map((claim) => claim.id);
    recommendationClaimIds = anchors.length ? anchors : undefined;
    conditionClaimIds = recommendationClaimIds;
    pivot = undefined;
    strongestCounterCase = recommendationClaimIds ? {
      claim_ids: recommendationClaimIds.slice(0, 1),
      reasoning: dissent[0] ?? 'The strongest remaining graph-linked objection is unresolved.',
    } : undefined;
  } else if (recommendation !== 'PROCEED_WITH_CONDITIONS') {
    conditions = undefined;
    conditionClaimIds = undefined;
  }

  const final: JudgeReportT = {
    ...report,
    adjudications,
    dissent,
    recommendation,
    conditions,
    recommendation_claim_ids: recommendationClaimIds,
    condition_claim_ids: conditionClaimIds,
    pivot,
    strongest_counter_case: strongestCounterCase,
  };
  await ctx.writer.writeJson('judge-report', final);
  return final;
}
