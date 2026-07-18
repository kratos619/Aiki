// S9b — idea validation plan. This is the one report-v3 model call after the judge: it turns the
// adjudicated risks, blind spots, and open questions into anchored validation actions. Rendering stays
// deterministic; if the planner fails or produces unanchored actions, we write flagged unavailability.

import type { ActionPlan as ActionPlanT, ActionPlanArtifact, DeliverableProposal, IntentContract, JudgeReport, PlannerUnavailable, RequestedOutput } from '../../schemas/index.js';
import { ActionPlan, FeatureBacklog, ImplementationPlan, ReaderBrief } from '../../schemas/index.js';
import { z } from 'zod';
import { BudgetExceeded, isFatal, type RunCtx } from '../context.js';
import { coerceToSchema, jsonCall } from '../jsonStage.js';
import { loadSkill } from '../skills.js';
import type { SeatOutput } from './s4-analyze.js';
import { mergeOpenQuestions } from './s10-render.js';
import { interpretClaimOutcome, type DecisionGraph } from '../decision-graph.js';

interface UpheldRisk {
  id: string;
  assumption: string;
  severity: 'HIGH' | 'MED' | 'LOW';
  reasoning: string;
}

export interface PlanAnchors {
  claimIds: string[];
  knownReaderIds?: string[];
  blindSpots: string[];
  openQuestions: string[];
  sourceIds: string[];
}

const PlannerOutput = z.object({
  actions: z.array(z.object({
    order: z.number().int().min(1).optional(),
    action: z.string().min(1),
    why: z.string().min(1),
    validates: z.string().min(1),
    effort: z.string().min(1).optional(),
    kill_signal: z.string().min(1),
  }).strict()).max(7),
  sequencing_note: z.string().min(1),
  feature_backlog: FeatureBacklog.optional(),
  implementation_plan: ImplementationPlan.optional(),
  reader_brief: ReaderBrief.optional(),
}).strict().superRefine((plan, ctx) => {
  if (plan.actions.length === 0 && !plan.reader_brief) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions'], message: 'an empty planner answer requires reader_brief' });
  }
});
type PlannerOutput = z.infer<typeof PlannerOutput>;

const S9B_PROMPT = `ROLE: User answer editor and action planner. The council has already done the analysis.
Turn its strongest supported findings and both scouts' proposals into a useful answer to the original user.{{SKILL}}

Output ONLY JSON matching the ActionPlan schema:
- reader_brief is REQUIRED. It contains:
  - headline: a concrete answer, not a report label.
  - bottom_line: the direct recommendation and why, with no process talk.
  - sections: 2-6 useful sections {heading,summary,bullets}; synthesize the requested deliverables and explain
    why standout ideas matter. Prefer concrete product language over due-diligence language. Explain the verdict,
    selection logic, and trade-offs; do not restate the feature backlog or milestone list.
  - next_step: one action the user should take next.
  - caveats: at most 3 honest limitations that materially affect the answer.
  - source_ids: only ids present in CONTEXT.sources; use [] when no source supports the reader answer.
- reader_brief must never mention graph/claim ids, verification enums, evidence coverage, structural scoring,
  provider-call mechanics, or the fact that an answer editor assembled it.
- CONTEXT.chair is decision reasoning, not factual proof. Treat its recommendation, rationale, conditions, and
  claim outcomes as judgment. Do not call a proposition supported, verified, proven, or factual unless the same
  proposition appears in supported_findings; otherwise frame it as a recommendation, risk, or hypothesis.
- actions: 1-4 ordered validation actions, each imperative and concrete.
- validates MUST anchor to one of:
  - a graph claim id from upheld_risks, e.g. "G3"
  - a blind spot label as "blind:<label>"
  - an open-question prefix as "Q:<question prefix>"
- why ties the action to the risk, blind spot, or question.
- kill_signal is the result that should stop or reshape the idea.
- Preserve CONTEXT.chair's numeric distinctions: operating break-even is not capital payback, and a target cap
  is not a known cost. Do not introduce or reinterpret a number that is absent from CONTEXT.chair.decision_snapshot.
- CONTEXT.as_of_date is the evidence snapshot date, not a deadline. Compare it with any sourced deadline.
- Treat stated deadlines and available time as hard boundaries. When CONTEXT has no numeric deadline or capacity,
  do not invent a day-count calendar; use ordered phases with explicit acceptance tests.
- sequencing_note explains why this order is cheapest and decisive.
- Read requested_outputs in CONTEXT. When it includes FEATURE_BACKLOG, include feature_backlog with
  must/should/later items {feature,user_value,rationale,effort:S|M|L} and wont items {feature,reason}.
  Prioritize the smallest judge-impressing golden path; MUST is required, not a wishlist.
- When requested_outputs includes IMPLEMENTATION_PLAN, include implementation_plan.milestones with
  {order,timebox,outcome,tasks,acceptance_test}. This is a concrete build sequence, not validation prose.
- Do not omit a requested output and do not invent an unrequested product surface.
- Use deliverable_proposals from BOTH seats as options, then select and improve the strongest coherent set.
- Treat supported_findings and sources as factual boundaries. Proposals are product judgment, not proof.

CONTEXT: {{CONTEXT_JSON}}`;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t;
}

function sevRank(s: string): number {
  return s === 'HIGH' ? 0 : s === 'MED' ? 1 : 2;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function unresolvedRisks(graph: DecisionGraph, judgeReport: JudgeReport): UpheldRisk[] {
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const risks = graph.claims
    .map((claim) => {
      const adj = rulingById.get(claim.id);
      const outcome = interpretClaimOutcome(graph, claim, adj);
      if ((!adj && outcome.decisionEffect !== 'FAILED')
        || (outcome.propositionTruth === 'HOLDS' && outcome.decisionEffect === 'HELD')) return null;
      return {
        id: claim.id,
        assumption: claim.proposition,
        severity: claim.sensitivity === 'DECISIVE' ? 'HIGH' as const : claim.sensitivity === 'MATERIAL' ? 'MED' as const : 'LOW' as const,
        reasoning: adj?.reasoning ?? 'This supported concern works against the decision.',
      };
    })
    .filter((risk): risk is UpheldRisk => risk !== null);
  const seen = new Set(risks.map((risk) => risk.id));
  for (const hole of graph.holes.evidence) {
    if (seen.has(hole.claim_id)) continue;
    const claim = claimById.get(hole.claim_id);
    if (!claim) continue;
    risks.push({
      id: claim.id,
      assumption: claim.proposition,
      severity: claim.sensitivity === 'DECISIVE' ? 'HIGH' : claim.sensitivity === 'MATERIAL' ? 'MED' : 'LOW',
      reasoning: hole.reason,
    });
  }
  return risks.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}

const ANSWER_MATERIAL_FLAGS = new Set([
  'synthesis_suspect', 'low_diversity', 'weak_seat', 'deliverable_gap', 'headless_intent',
  'verification_skipped', 'research_ungrounded', 'source_fallback_search',
]);

function safePublicUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Canonical, decision-relevant input to the existing S9b answer-editor call. */
export function buildAnswerContext(input: {
  originalRequest: string;
  contract: IntentContract;
  seats: SeatOutput[];
  graph: DecisionGraph;
  judgeReport: JudgeReport;
  flags: Iterable<string>;
}) {
  const { contract, graph, judgeReport, seats } = input;
  const evidenceDates = graph.evidence
    .filter((evidence) => evidence.source_kind === 'PRIMARY' || evidence.source_kind === 'SECONDARY')
    .map((evidence) => evidence.accessed_at?.match(/^\d{4}-\d{2}-\d{2}/)?.[0])
    .filter((date): date is string => Boolean(date))
    .sort();
  const asOfDate = evidenceDates.at(-1);
  const requestedOutputs = (contract as IntentContract & { requested_outputs?: RequestedOutput[] }).requested_outputs ?? ['DECISION'];
  const adjudicationById = new Map(judgeReport.adjudications.map((item) => [item.id, item]));
  const outcomes = graph.claims.map((claim) => {
    const adjudication = adjudicationById.get(claim.id);
    const outcome = interpretClaimOutcome(graph, claim, adjudication);
    return {
      id: claim.id,
      proposition: claim.proposition,
      proposition_truth: outcome.propositionTruth,
      decision_effect: outcome.decisionEffect,
      ...(adjudication ? { reasoning: adjudication.reasoning } : {}),
    };
  });
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const deliverableProposals = seats.flatMap((seat) => {
    const seatId = seat.sample ?? seat.provider;
    return (seat.output.deliverable_proposals ?? []).map((proposal) => ({
      ...proposal,
      provider: seat.provider,
      seat_id: seatId,
      evidence_ids: [...new Set(proposal.evidence_ids.flatMap((localId) => graph.evidence
        .filter((evidence) => evidence.provider === seat.provider
          && evidence.source_id === seatId
          && evidence.id === `${seatId}/${localId}`)
        .map((evidence) => evidence.id)))],
    }));
  });
  return {
    original_request: input.originalRequest,
    ...(asOfDate ? { as_of_date: asOfDate } : {}),
    task: contract.task,
    constraints: contract.constraints,
    success_criteria: contract.success_criteria,
    requested_outputs: requestedOutputs,
    chair: {
      epistemic_status: 'DECISION_REASONING_NOT_FACT' as const,
      recommendation: judgeReport.recommendation,
      decision_reasoning: judgeReport.verdict,
      rationale: judgeReport.key_points ?? [],
      decision_conditions: judgeReport.conditions ?? [],
      decision_snapshot: judgeReport.decision_snapshot,
      claim_outcomes: outcomes,
    },
    upheld_risks: unresolvedRisks(graph, judgeReport),
    blind_spots: graph.holes.coverage.map((hole) => hole.label),
    open_questions: mergeOpenQuestions(seats),
    deliverable_proposals: deliverableProposals,
    supported_findings: graph.claims
      .filter((claim) => claim.nature === 'FACTUAL'
        && claim.evidence_state === 'SUPPORTED'
        && outcomeById.get(claim.id)?.proposition_truth === 'HOLDS')
      .map((claim) => ({ id: claim.id, finding: claim.proposition })),
    material_flags: [...input.flags].filter((flag) => ANSWER_MATERIAL_FLAGS.has(flag)),
    sources: graph.evidence.map((evidence) => {
      const url = safePublicUrl(evidence.url) ?? safePublicUrl(evidence.locator);
      return {
        id: evidence.id,
        kind: evidence.source_kind,
        ...(evidence.title ? { title: evidence.title } : {}),
        ...(url ? { url } : {}),
        ...(evidence.accessed_at ? { accessed_at: evidence.accessed_at } : {}),
        supports: evidence.claim_supported,
      };
    }),
  };
}

export function buildActionPlannerPrompt(input: {
  as_of_date?: string;
  task: string;
  constraints?: string[];
  success_criteria?: string[];
  recommendation?: string;
  conditions?: string[];
  decision_snapshot?: JudgeReport['decision_snapshot'];
  upheld_risks: UpheldRisk[];
  blind_spots: string[];
  open_questions: string[];
  requested_outputs?: RequestedOutput[];
  deliverable_proposals?: Array<DeliverableProposal & { provider: string }>;
  supported_findings?: Array<{ id: string; finding: string }>;
  sources?: Array<{ id: string; kind: string; title?: string; url?: string; accessed_at?: string; locator?: string; supports: string }>;
}, skill: string): string {
  return S9B_PROMPT
    .replace('{{SKILL}}', skill ? `\n\n${skill}` : '')
    .replace('{{CONTEXT_JSON}}', JSON.stringify(input, null, 2));
}

export function validAnchor(anchor: string, anchors: PlanAnchors): boolean {
  const a = anchor.trim();
  if (anchors.claimIds.includes(a)) return true;
  if (a.toLowerCase().startsWith('blind:')) {
    const label = norm(a.slice('blind:'.length));
    return anchors.blindSpots.some((b) => {
      const n = norm(b);
      return n.startsWith(label) || label.startsWith(n);
    });
  }
  if (a.toLowerCase().startsWith('q:')) {
    const prefix = norm(a.slice(2));
    return anchors.openQuestions.some((q) => {
      const n = norm(q);
      return n.startsWith(prefix) || prefix.startsWith(n);
    });
  }
  return false;
}

function normalizeSourceIds(ids: string[], allowed: string[]): string[] {
  const normalized = ids.flatMap((id) => {
    if (allowed.includes(id)) return [id];
    const matches = allowed.filter((known) => known.endsWith(`/${id}`));
    return matches.length === 1 ? matches : [];
  });
  return [...new Set(normalized)];
}

/** v6: requested deliverables the accepted plan still lacks — the caller decides whether that is
 *  worth a repair call or an honest `plan_partial` flag. Never a reason to discard the plan. */
export function missingDeliverables(plan: ActionPlanT, requestedOutputs: RequestedOutput[]): RequestedOutput[] {
  return requestedOutputs.filter((output) =>
    (output === 'FEATURE_BACKLOG' && !plan.feature_backlog)
    || (output === 'IMPLEMENTATION_PLAN' && !plan.implementation_plan));
}

export function anchoredActionPlan(
  plan: ActionPlanT,
  anchors: PlanAnchors,
  requestedOutputs: RequestedOutput[] = [],
  requireReaderBrief = false,
): ActionPlanT | null {
  if (requireReaderBrief && !plan.reader_brief) return null;
  // v6: a reader brief citing known claim ids is KEPT — sanitizeReaderText already substitutes
  // labels at render time; rejecting here cost run f740 a paid repair for zero reader benefit.
  const readerBrief = plan.reader_brief ? {
    ...plan.reader_brief,
    source_ids: normalizeSourceIds(plan.reader_brief.source_ids, anchors.sourceIds),
  } : undefined;
  const actions = plan.actions
    .filter((a) => validAnchor(a.validates, anchors))
    .sort((a, b) => a.order - b.order)
    .slice(0, requireReaderBrief ? 4 : 7)
    .map((a, i) => ({ ...a, order: i + 1 }));
  if (actions.length === 0 && !requireReaderBrief) return null;
  return {
    actions,
    sequencing_note: plan.sequencing_note,
    ...(requestedOutputs.includes('FEATURE_BACKLOG') && plan.feature_backlog ? { feature_backlog: plan.feature_backlog } : {}),
    ...(requestedOutputs.includes('IMPLEMENTATION_PLAN') && plan.implementation_plan ? { implementation_plan: plan.implementation_plan } : {}),
    ...(readerBrief ? { reader_brief: readerBrief } : {}),
  };
}

export function normalizeEffort(raw?: string): 'S' | 'M' | 'L' {
  const value = raw?.trim().toLowerCase();
  if (value === 's' || value === 'm' || value === 'l') return value.toUpperCase() as 'S' | 'M' | 'L';
  const match = value?.match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(minute|hour|day|week|month|year)s?/);
  if (!match) return 'M';
  const amount = Number(match[2] ?? match[1]);
  const unit = match[3];
  const days = amount * (unit === 'minute' ? 1 / 1440 : unit === 'hour' ? 1 / 24 : unit === 'day' ? 1 : unit === 'week' ? 7 : unit === 'month' ? 30 : 365);
  return days <= 2 ? 'S' : days <= 14 ? 'M' : 'L';
}

const CALENDAR_TIMEBOX = /\b(?:days?|weeks?|months?|years?)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const EXPLICIT_SCHEDULE = /\b(?:\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?\s*[-–]?\s*(?:hours?|days?|weeks?|months?|years?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)\b/i;

function hasExplicitSchedule(context: ReturnType<typeof buildAnswerContext>): boolean {
  return EXPLICIT_SCHEDULE.test(JSON.stringify({
    original_request: context.original_request,
    constraints: context.constraints,
    success_criteria: context.success_criteria,
    chair: context.chair,
    supported_findings: context.supported_findings,
    sources: context.sources.map((source) => source.supports),
  }));
}

export function normalizePlannerOutput(plan: PlannerOutput, calendarAllowed = true): ActionPlanT {
  const built = {
    actions: plan.actions.map((action, i) => ({
      ...action,
      order: i + 1,
      effort: normalizeEffort(action.effort),
    })),
    sequencing_note: plan.sequencing_note,
    ...(plan.feature_backlog ? { feature_backlog: plan.feature_backlog } : {}),
    ...(plan.implementation_plan ? { implementation_plan: {
      milestones: plan.implementation_plan.milestones.map((milestone, index) => ({
        ...milestone,
        timebox: !calendarAllowed && CALENDAR_TIMEBOX.test(milestone.timebox) ? `Phase ${index + 1}` : milestone.timebox,
      })),
    } } : {}),
    ...(plan.reader_brief ? { reader_brief: plan.reader_brief } : {}),
  };
  const parsed = ActionPlan.safeParse(built);
  if (parsed.success) return parsed.data;
  // v6 deterministic floor for offline/replay callers (jsonCall applies the same floor live):
  // clip over-cap strings, truncate over-cap arrays — never discard a complete plan over cosmetics.
  const eased = ActionPlan.safeParse(coerceToSchema(ActionPlan, built, true));
  if (eased.success) return eased.data;
  return ActionPlan.parse(built);
}

function unavailablePlan(
  reason: PlannerUnavailable['reason'],
  contract: IntentContract,
  risks: UpheldRisk[],
  blindSpots: string[],
  openQuestions: string[],
): PlannerUnavailable {
  const unresolved = openQuestions.length ? openQuestions : [
    ...risks.map((risk) => `What evidence would resolve whether ${risk.assumption}?`),
    ...blindSpots.map((spot) => `What evidence resolves the ${spot} gap?`),
  ];
  return {
    kind: 'PlannerUnavailable',
    reason,
    unresolved_questions: (unresolved.length ? unresolved : [`What evidence would change the verdict for ${clip(contract.task, 100)}?`]).slice(0, 10),
  };
}

export async function s9bPlan(
  ctx: RunCtx,
  contract: IntentContract,
  seats: SeatOutput[],
  graph: DecisionGraph,
  judgeReport: JudgeReport,
  originalRequest = contract.task,
): Promise<ActionPlanArtifact> {
  const answerContext = buildAnswerContext({ originalRequest, contract, seats, graph, judgeReport, flags: ctx.flags });
  const openQuestions = answerContext.open_questions;
  const requestedOutputs = answerContext.requested_outputs;
  const risks = answerContext.upheld_risks;
  const blindSpots = answerContext.blind_spots;
  const sourceIds = graph.evidence.map((evidence) => evidence.id);
  const requireReaderBrief = 'success_bar' in contract;
  const anchors: PlanAnchors = {
    claimIds: risks.map((r) => r.id),
    knownReaderIds: graph.claims.map((claim) => claim.id),
    blindSpots,
    openQuestions,
    sourceIds,
  };
  const fallback = async (flag: 'plan_skipped' | 'plan_fallback'): Promise<ActionPlanArtifact> => {
    ctx.addFlag(flag);
    const plan = unavailablePlan(flag === 'plan_skipped' ? 'budget_exhausted' : 'planner_failed', contract, risks, blindSpots, openQuestions);
    await ctx.writer.writeJson('action-plan', plan);
    return plan;
  };

  if (ctx.budget.limit - ctx.budget.used < 1) return fallback('plan_skipped');

  const prompt = buildActionPlannerPrompt(answerContext, loadSkill('idea-refinement', 'planner'));
  const calendarAllowed = hasExplicitSchedule(answerContext);

  // v6: a plan the model actually produced is never replaced by PlannerUnavailable. Complete →
  // accept; missing a requested deliverable → one repair when budget allows, else accept partial
  // with an honest `plan_partial` flag. PlannerUnavailable is reserved for nothing-parseable.
  const accept = async (plan: ActionPlanT): Promise<ActionPlanT> => {
    if (missingDeliverables(plan, requestedOutputs).length) ctx.addFlag('plan_partial');
    await ctx.writer.writeJson('action-plan', plan);
    return plan;
  };

  let anchored: ActionPlanT | null = null;
  try {
    const first = normalizePlannerOutput(await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-plan', prompt, PlannerOutput, {
      repair: ctx.budget.limit - ctx.budget.used >= 2,
    }), calendarAllowed);
    anchored = anchoredActionPlan(first, anchors, requestedOutputs, requireReaderBrief);
    if (anchored && missingDeliverables(anchored, requestedOutputs).length === 0) {
      await ctx.writer.writeJson('action-plan', anchored);
      return anchored;
    }
    if (ctx.budget.limit - ctx.budget.used < 1) {
      if (anchored) return accept(anchored);
      return fallback('plan_fallback');
    }
    const repair =
      `${prompt}\n\n---\nYour previous response had invalid anchors, omitted a requested deliverable or reader_brief, or cited an unknown source id.\n` +
      `Valid graph claim ids: ${anchors.claimIds.join(', ') || '(none)'}\n` +
      `Valid blind spots: ${anchors.blindSpots.join(' | ') || '(none)'}\n` +
      `Valid open questions: ${anchors.openQuestions.join(' | ') || '(none)'}\n` +
      `Valid source ids: ${anchors.sourceIds.join(', ') || '(none)'}\n` +
      `Required outputs: ${requestedOutputs.join(', ')}\n` +
      `Output ONLY corrected JSON with every action anchored, reader_brief present, and every requested deliverable present.`;
    const repaired = normalizePlannerOutput(await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-anchor-repair', repair, PlannerOutput, { repair: false }), calendarAllowed);
    const repairedAnchored = anchoredActionPlan(repaired, anchors, requestedOutputs, requireReaderBrief);
    if (repairedAnchored && missingDeliverables(repairedAnchored, requestedOutputs).length === 0) {
      await ctx.writer.writeJson('action-plan', repairedAnchored);
      return repairedAnchored;
    }
    const best = repairedAnchored ?? anchored;
    if (best) return accept(best);
    return fallback('plan_fallback');
  } catch (e) {
    if (isFatal(e) && !(e instanceof BudgetExceeded)) throw e;
    if (anchored) return accept(anchored);
    return fallback('plan_fallback');
  }
}
