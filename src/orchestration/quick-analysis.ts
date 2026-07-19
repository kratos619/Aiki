import type { ProviderId } from '../providers/types.js';
import {
  ActionPlan,
  JudgeReport,
  QuickDecisionModel,
  readerBriefIssues,
  salvageIdeaRoleOutputModel,
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
  "analysis": <the idea analyst object with EXACTLY these fields:
    task_echo: restate the task in ≤2 sentences.
    strongest_version: the best honest version of this idea in ≤150 words.
    positions: [{local_id, proposition, dimension_id, stance SUPPORT|OPPOSE|MIXED|UNKNOWN,
      basis EVIDENCE|INFERENCE|ASSUMPTION, nature FACTUAL|JUDGMENT, load_bearing,
      if_false STOP|PIVOT|CONDITION|MINOR, reasoning, evidence_ids, depends_on}]
    evidence: [{id, claim_supported, source_kind USER|PRIMARY|SECONDARY|MODEL_KNOWLEDGE (exact token),
      support SUPPORTS|CONTRADICTS|CONTEXT_ONLY, freshness CURRENT|DATED|UNKNOWN (exact token),
      locator/url, accessed_at for current external sources}]. MODEL_KNOWLEDGE freshness is UNKNOWN.
    calculations: [] or per derived numeric claim {id, claim_id, inputs: [{id,name,value,unit,evidence_ids}],
      steps: [{id,operation ADD|SUBTRACT|MULTIPLY|DIVIDE,left,right,result,unit}], result_step}
    coverage: one entry per rubric dimension {dimension_id, status COVERED|NOT_APPLICABLE,
      position_ids ([] when none), rationale (required for NOT_APPLICABLE)} — no other keys.
    decision_questions: [{question, claim_ids}]
    deliverable_proposals: [] unless requested_outputs asks for FEATURE_BACKLOG or IMPLEMENTATION_PLAN,
      then [{output FEATURE_BACKLOG|IMPLEMENTATION_PLAN, title, detail, user_value, why_distinctive, evidence_ids}].
    Use ONLY these field names — no extra or renamed keys anywhere in analysis.>,
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
    "implementation_plan":{"milestones":[{"order":1,"timebox":"<Day 1>","outcome":"<working outcome>","tasks":["<task>"],"acceptance_test":"<observable pass condition>"}]},
    "reader_brief":{"headline":"<direct answer>","bottom_line":"<recommendation and why>",
      "sections":[{"heading":"<useful heading>","summary":"<plain-language synthesis>","bullets":["<specific insight>"]},{"heading":"<useful heading>","summary":"<plain-language synthesis>","bullets":[]}],
      "next_step":"<one action>","caveats":["<material limitation>"],"source_ids":["<evidence id from analysis, or empty>"]}}
}
Honor DECISION CONTRACT.requested_outputs. Include feature_backlog and implementation_plan whenever
those exact outputs are requested; keep them concrete and scoped to the smallest useful golden path.
reader_brief is always required. It directly answers the user, summarizes requested outputs, and never mentions
claim ids, verification enums, structural scoring, evidence coverage, or model mechanics.
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

/** Auto standard path keeps the same typed one-call output without claiming explicit quick mode. */
export function buildAdaptivePrompt(
  contract: DecisionContract,
  inputPath: string,
  evidencePack: EvidencePack | undefined,
  skill: string,
): string {
  return buildQuickPrompt(contract, inputPath, evidencePack, skill).replace(
    'ROLE: Single decision analyst. This is explicit QUICK mode, not a multi-model\ncouncil. Give one strong structured analysis and do not claim independent consensus or verification.',
    'ROLE: Primary decision analyst in an adaptive auto run. Give one strong structured analysis.\nDo not claim council consensus or independent verification. Use provider-native read-only source\ninvestigation when available; otherwise leave current facts visibly unverified.',
  );
}

export async function s4QuickAnalyze(
  ctx: RunCtx,
  prompt: string,
  opts: { persist?: boolean; stage?: string } = {},
): Promise<{ seat: SeatOutput; decision: QuickDecisionModelT }> {
  const provider = ctx.roles.judge;
  const decision = await jsonCall(ctx, ctx.handle(provider), opts.stage ?? 'Q1', prompt, QuickDecisionModel, {
    // Same deterministic last resort as council S4, applied to the nested analysis object.
    salvage: (json) => (json && typeof json === 'object' && !Array.isArray(json)
      ? { ...(json as Record<string, unknown>), analysis: salvageIdeaRoleOutputModel((json as Record<string, unknown>).analysis) }
      : json),
  });
  const output = { workflow: 'idea-refinement' as const, ...decision.analysis };
  if (opts.persist !== false) await ctx.writer.writeRoleOutput(provider, output);
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
  const sourceIds = new Set(graph.evidence.map((evidence) => evidence.id));
  const readerBrief = {
    ...decision.action_plan.reader_brief,
    source_ids: decision.action_plan.reader_brief.source_ids.flatMap((id) => {
      const global = graph.evidence.find((evidence) =>
        evidence.provider === provider && (evidence.id === id || evidence.id.endsWith(`/${id}`)))?.id ?? id;
      return sourceIds.has(global) ? [global] : [];
    }),
  };
  const deliverablesPresent = (!requestedOutputs.includes('FEATURE_BACKLOG') || decision.action_plan.feature_backlog)
    && (!requestedOutputs.includes('IMPLEMENTATION_PLAN') || decision.action_plan.implementation_plan);
  if (deliverablesPresent && readerBriefIssues(readerBrief, graph.claims.map((claim) => claim.id)).length === 0) {
    return ActionPlan.parse({
    actions,
    sequencing_note: decision.action_plan.sequencing_note,
    reader_brief: readerBrief,
    ...(requestedOutputs.includes('FEATURE_BACKLOG') && decision.action_plan.feature_backlog
      ? { feature_backlog: decision.action_plan.feature_backlog } : {}),
    ...(requestedOutputs.includes('IMPLEMENTATION_PLAN') && decision.action_plan.implementation_plan
      ? { implementation_plan: decision.action_plan.implementation_plan } : {}),
    });
  }
  ctx.addFlag('plan_fallback');
  return {
    kind: 'PlannerUnavailable',
    reason: 'planner_failed',
    unresolved_questions: (decision.analysis.decision_questions.length
      ? decision.analysis.decision_questions.map((question) => question.question)
      : ['What evidence would change this single-analyst recommendation?']).slice(0, 10),
  };
}
