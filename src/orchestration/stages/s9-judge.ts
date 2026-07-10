// S9 — chair adjudication over graph-selected escalations. Consensus and shared concerns are
// read-only context; anonymous position text and the verifier record cross the boundary unchanged.

import type { DecisionGraph } from '../decision-graph.js';
import { selectEscalations } from '../decision-graph.js';
import type { IntentContract, JudgeReport as JudgeReportT, Recommendation, VerificationSet } from '../../schemas/index.js';
import { JudgeReportModel } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { RubricItem } from './s7-decision-graph.js';

type Adjudication = JudgeReportT['adjudications'][number];

const S9_PROMPT = `ROLE: Judge. Adjudicate ONLY the anonymous escalated claim IDs below. Settled claims
and shared concerns are read-only context; do not re-litigate them. Apply this rubric: {{RUBRIC_JSON}}

Output ONLY JSON matching the judge schema:
- adjudications: each escalated id → {id, ruling: UPHOLD|REJECT|UNRESOLVED, reasoning ≤3 sentences, evidence_cited}.
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
  return [...upheld, ...holes, 'Proceed only after one cheap test confirms the core user need.'].slice(0, 6);
}

export function buildJudgePrompt(
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: VerificationSet,
  rubric: RubricItem[],
): string {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const verificationById = new Map(verifications.verifications.map((item) => [item.target_id, item]));
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
      verifier_status: verification?.verdict ?? 'UNVERIFIED',
      verifier_evidence: verification?.evidence ?? '(no verifier evidence recorded)',
      verifier_note: verification?.note ?? '',
    };
  });
  const context = graph.claims.filter((claim) => !escalationIds.has(claim.id)).map((claim) => ({
    id: claim.id,
    proposition: claim.proposition,
    state: claim.state,
    evidence_state: claim.evidence_state,
  }));
  return S9_PROMPT
    .replace('{{RUBRIC_JSON}}', JSON.stringify(rubric.map((item) => item.label)))
    .replace('{{ESCALATIONS_JSON}}', JSON.stringify(escalations, null, 2))
    .replace('{{CONTEXT_JSON}}', JSON.stringify(context, null, 2))
    .concat(`\nTASK: ${contract.task}`);
}

export async function s9Judge(
  ctx: RunCtx,
  contract: IntentContract,
  graph: DecisionGraph,
  verifications: VerificationSet,
  rubric: RubricItem[],
): Promise<JudgeReportT> {
  const ids = selectEscalations(graph, { max: 8 }).map((item) => item.claim_id);
  const basePrompt = buildJudgePrompt(contract, graph, verifications, rubric);
  const judge = ctx.handle(ctx.roles.judge);
  let report = await jsonCall(ctx, judge, 'S9', basePrompt, JudgeReportModel);

  let violations = adjudicationScopeViolations(report, ids);
  let recIssues = recommendationIssues(report);
  if (violations.length || report.dissent.length === 0 || recIssues.length) {
    const repair = `${basePrompt}\n\n---\nCorrect these problems:\n`
      + (violations.length ? `- adjudications may reference only [${ids.join(', ')}], not ${violations.join(', ')}\n` : '')
      + (report.dissent.length === 0 ? '- dissent must contain at least one item\n' : '')
      + (recIssues.length ? `- ${recIssues.join('; ')}\n` : '')
      + 'Output ONLY corrected JSON.';
    try {
      report = await jsonCall(ctx, judge, 'S9-repair', repair, JudgeReportModel);
      violations = adjudicationScopeViolations(report, ids);
      recIssues = recommendationIssues(report);
    } catch (error) {
      if (isFatal(error)) throw error;
    }
  }

  const allowed = new Set(ids);
  const inScope = report.adjudications.filter((item) => allowed.has(item.id));
  if (inScope.length !== report.adjudications.length) ctx.addFlag('synthesis_suspect');
  const adjudications = demoteSelfAuthored(inScope, graph, ctx.roles.judge);
  let dissent = report.dissent;
  if (dissent.length === 0) {
    ctx.addFlag('synthesis_suspect');
    dissent = ['(none produced — flagged synthesis_suspect)'];
  }
  let recommendation = report.recommendation;
  let conditions = report.conditions;
  if (recIssues.length) {
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
