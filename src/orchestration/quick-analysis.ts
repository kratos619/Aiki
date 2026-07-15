import type { ProviderId } from '../providers/types.js';
import {
  ActionPlan,
  JudgeReport,
  QuickDecisionModel,
  type ActionPlanArtifact,
  type DecisionContract,
  type JudgeReport as JudgeReportT,
  type QuickDecisionModel as QuickDecisionModelT,
} from '../schemas/index.js';
import type { DecisionGraph } from './decision-graph.js';
import type { EvidencePack } from './evidence-pack.js';
import type { RunCtx } from './context.js';
import { jsonCall } from './jsonStage.js';
import type { SeatOutput } from './stages/s4-analyze.js';

const QUICK_PROMPT = `ROLE: Single decision analyst. This is explicit QUICK mode, not a multi-model
council. Give one strong structured analysis and do not claim independent consensus or verification.{{SKILL}}

DECISION CONTRACT: {{CONTRACT_JSON}}
INPUT DOCUMENT: read the file at {{INPUT_PATH}}
EVIDENCE PACK MANIFEST: {{EVIDENCE_PACK_JSON}}

Output ONLY JSON:
{
  "analysis": <the idea analyst object: task_echo, strongest_version, positions, evidence,
    calculations, coverage, decision_questions>,
  "verdict": "<2-5 sentence decision and core reason>",
  "recommendation": "PROCEED|PROCEED_WITH_CONDITIONS|PIVOT|STOP",
  "conditions": ["<only for PROCEED_WITH_CONDITIONS>"],
  "key_points": ["<2-8 decision reasons>"],
  "dissent": ["<strongest counter-case>"],
  "confidence_notes": "<calibrated limits; explicitly single-analyst>",
  "action_plan": {"actions":[{"order":1,"action":"<test>","why":"<reason>",
    "validates":"<a local position id such as P1, or Q:<question prefix>>","effort":"S|M|L",
    "kill_signal":"<result that stops or reshapes the idea>"}],"sequencing_note":"<why this order>",
    "feature_backlog":{"must":[{"feature":"<name>","user_value":"<value>","rationale":"<why now>","effort":"S|M|L"}],"should":[],"later":[],"wont":[{"feature":"<name>","reason":"<why excluded>"}]},
    "implementation_plan":{"milestones":[{"order":1,"timebox":"<Day 1>","outcome":"<working outcome>","tasks":["<task>"],"acceptance_test":"<observable pass condition>"}]}}
}
Honor DECISION CONTRACT.requested_outputs. Include feature_backlog and implementation_plan whenever
those exact outputs are requested; keep them concrete and scoped to the smallest useful golden path.
Use only supplied evidence or clearly labeled MODEL_KNOWLEDGE. Never invent URLs. JSON only.`;

export function buildQuickPrompt(
  contract: DecisionContract,
  inputPath: string,
  evidencePack: EvidencePack | undefined,
  skill: string,
): string {
  return QUICK_PROMPT
    .replace('{{SKILL}}', skill ? `\n\n${skill}` : '')
    .replace('{{CONTRACT_JSON}}', JSON.stringify(contract))
    .replace('{{INPUT_PATH}}', inputPath)
    .replace('{{EVIDENCE_PACK_JSON}}', JSON.stringify(evidencePack ?? { files: [] }));
}

export async function s4QuickAnalyze(
  ctx: RunCtx,
  prompt: string,
): Promise<{ seat: SeatOutput; decision: QuickDecisionModelT }> {
  const provider = ctx.roles.judge;
  const decision = await jsonCall(ctx, ctx.handle(provider), 'Q1', prompt, QuickDecisionModel);
  const output = { workflow: 'idea-refinement' as const, ...decision.analysis };
  await ctx.writer.writeRoleOutput(provider, output);
  return { seat: { provider, sample: provider, output }, decision };
}

function claimAnchors(graph: DecisionGraph): string[] {
  const loadBearing = graph.claims.filter((claim) => claim.load_bearing).map((claim) => claim.id);
  return (loadBearing.length ? loadBearing : graph.claims.map((claim) => claim.id)).slice(0, 8);
}

export function quickJudgeReport(decision: QuickDecisionModelT, graph: DecisionGraph): JudgeReportT {
  const anchors = claimAnchors(graph);
  const first = anchors[0]!;
  return JudgeReport.parse({
    adjudications: [],
    verdict: decision.verdict,
    recommendation: decision.recommendation,
    ...(decision.conditions.length ? { conditions: decision.conditions } : {}),
    recommendation_claim_ids: anchors,
    ...(decision.recommendation === 'PROCEED_WITH_CONDITIONS' ? { condition_claim_ids: anchors } : {}),
    ...(decision.recommendation === 'PIVOT' && anchors.length >= 2
      ? { pivot: { changed_claim_id: anchors[0], new_risk_claim_id: anchors[1] } }
      : {}),
    strongest_counter_case: { claim_ids: [first], reasoning: decision.dissent[0]! },
    key_points: decision.key_points,
    dissent: decision.dissent,
    confidence_notes: decision.confidence_notes,
  });
}

export function quickActionPlan(
  ctx: RunCtx,
  provider: ProviderId,
  decision: QuickDecisionModelT,
  graph: DecisionGraph,
  contract: DecisionContract,
): ActionPlanArtifact {
  const claimByPosition = new Map(graph.claims.flatMap((claim) => claim.position_ids.map((id) => [id, claim.id] as const)));
  const claimIds = new Set(graph.claims.map((claim) => claim.id));
  const actions = decision.action_plan.actions.flatMap((action) => {
    const local = claimByPosition.get(`${provider}/${action.validates}`);
    const validates = local ?? action.validates;
    const valid = claimIds.has(validates) || /^(?:Q|blind):/i.test(validates);
    return valid ? [{ ...action, validates }] : [];
  }).map((action, index) => ({ ...action, order: index + 1 }));
  const requestedOutputs = contract.requested_outputs ?? ['DECISION'];
  if (actions.length > 0) return ActionPlan.parse({
    actions,
    sequencing_note: decision.action_plan.sequencing_note,
    ...(requestedOutputs.includes('FEATURE_BACKLOG') && decision.action_plan.feature_backlog
      ? { feature_backlog: decision.action_plan.feature_backlog } : {}),
    ...(requestedOutputs.includes('IMPLEMENTATION_PLAN') && decision.action_plan.implementation_plan
      ? { implementation_plan: decision.action_plan.implementation_plan } : {}),
  });
  ctx.addFlag('plan_fallback');
  return {
    kind: 'PlannerUnavailable',
    reason: 'planner_failed',
    unresolved_questions: (decision.analysis.decision_questions.length
      ? decision.analysis.decision_questions.map((question) => question.question)
      : ['What evidence would change this single-analyst recommendation?']).slice(0, 10),
  };
}
