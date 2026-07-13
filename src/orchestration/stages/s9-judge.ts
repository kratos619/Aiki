// S9 — chair adjudication over graph-selected escalations. Consensus and shared concerns are
// read-only context; anonymous position text and the verifier record cross the boundary unchanged.

import type { DecisionGraph } from '../decision-graph.js';
import { selectEscalations } from '../decision-graph.js';
import type { ClaimVerificationSet, IntentContract, JudgeReport as JudgeReportT, Recommendation } from '../../schemas/index.js';
import { JudgeReportModel } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { RubricItem } from './s7-decision-graph.js';
import { claimVerificationRefIssues } from './s8-verify.js';

type Adjudication = JudgeReportT['adjudications'][number];

const S9_PROMPT = `ROLE: Judge. Adjudicate ONLY the anonymous escalated claim IDs below. Settled claims
and shared concerns are read-only context; do not re-litigate them. Apply this rubric: {{RUBRIC_JSON}}

Output ONLY JSON matching the judge schema:
- adjudications: each escalated id with valid verification evidence → {id, ruling:
  UPHOLD|REJECT|UNRESOLVED, reasoning ≤3 sentences, evidence_ids: [IDs from that claim's verification]}.
  Omit claims with no evidence IDs; they remain unresolved. Never emit evidence_cited prose.
- verdict: a clear 2-5 sentence recommendation grounded in adjudicated and settled claims.
- recommendation: PROCEED, PROCEED_WITH_CONDITIONS, PIVOT, or STOP.
- conditions: required only for PROCEED_WITH_CONDITIONS and must be checkable.
- key_points: 4-8 standalone decision-relevant bullets.
- dissent: at least one strongest argument against your verdict.
- confidence_notes: explain calibrated confidence.
ESCALATED CLAIMS + VERIFICATION: {{ESCALATIONS_JSON}}
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
    const solelyJudge = providers.size === 1 && providers.has(judgeProvider);
    return solelyJudge && adjudication.ruling !== 'UNRESOLVED'
      ? { ...adjudication, ruling: 'UNRESOLVED' as const }
      : adjudication;
  });
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
): string {
  return judgeInput(contract, graph, verifications, rubric).prompt;
}

function judgeInput(
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  rubric: RubricItem[],
): { prompt: string; evidenceRefs: Map<string, string> } {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
  const citedEvidence = [...new Set(verifications.verifications.flatMap((item) => item.evidence_ids))];
  const evidenceRefs = new Map(citedEvidence.map((id, index) => [`E${index + 1}`, id]));
  const aliasByEvidence = new Map([...evidenceRefs].map(([alias, id]) => [id, alias]));
  const escalationIds = new Set(selectEscalations(graph, { max: 8 }).map((item) => item.claim_id));
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
  }));
  const prompt = S9_PROMPT
    .replace('{{RUBRIC_JSON}}', JSON.stringify(rubric.map((item) => item.label)))
    .replace('{{ESCALATIONS_JSON}}', JSON.stringify(escalations, null, 2))
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
): Promise<JudgeReportT> {
  const ids = selectEscalations(graph, { max: 8 }).map((item) => item.claim_id);
  const verificationIssues = claimVerificationRefIssues(graph, verifications, ids);
  if (verificationIssues.length) throw new StageError('S9', 'BAD_OUTPUT', `invalid verification references: ${verificationIssues.join('; ')}`);
  const input = judgeInput(contract, graph, verifications, rubric);
  const basePrompt = input.prompt;
  const judge = ctx.handle(ctx.roles.judge);
  const translateEvidenceRefs = (value: JudgeReportT): JudgeReportT => ({
    ...value,
    adjudications: value.adjudications.map((item) => ({
      ...item,
      evidence_ids: item.evidence_ids?.map((id) => input.evidenceRefs.get(id) ?? id),
    })),
  });
  let report = translateEvidenceRefs(await jsonCall(ctx, judge, 'S9', basePrompt, JudgeReportModel));

  let violations = adjudicationScopeViolations(report, ids);
  let evidenceViolations = adjudicationEvidenceViolations(report, verifications);
  let recIssues = recommendationIssues(report);
  if (violations.length || evidenceViolations.length || report.dissent.length === 0 || recIssues.length) {
    const repair = `${basePrompt}\n\n---\nCorrect these problems:\n`
      + (violations.length ? `- adjudications may reference only [${ids.join(', ')}], not ${violations.join(', ')}\n` : '')
      + (evidenceViolations.length ? `- evidence reference errors: ${evidenceViolations.join('; ')}\n` : '')
      + (report.dissent.length === 0 ? '- dissent must contain at least one item\n' : '')
      + (recIssues.length ? `- ${recIssues.join('; ')}\n` : '')
      + 'Output ONLY corrected JSON.';
    try {
      report = translateEvidenceRefs(await jsonCall(ctx, judge, 'S9-repair', repair, JudgeReportModel));
      violations = adjudicationScopeViolations(report, ids);
      evidenceViolations = adjudicationEvidenceViolations(report, verifications);
      recIssues = recommendationIssues(report);
    } catch (error) {
      if (isFatal(error)) throw error;
    }
  }

  const allowed = new Set(ids);
  const inScope = report.adjudications.filter((item) => allowed.has(item.id));
  const evidenceValid = inScope.filter((item) => adjudicationEvidenceViolations({ adjudications: [item] }, verifications).length === 0)
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
  if (recIssues.length || evidenceViolations.length) {
    ctx.addFlag('synthesis_suspect');
    recommendation = 'PROCEED_WITH_CONDITIONS';
    conditions = fallbackConditions(graph, adjudications);
  } else if (recommendation !== 'PROCEED_WITH_CONDITIONS') {
    conditions = undefined;
  }

  const final: JudgeReportT = { ...report, adjudications, dissent, recommendation, conditions };
  await ctx.writer.writeJson('judge-report', final);
  return final;
}
