// S9b — idea validation plan. This is the one report-v3 model call after the judge: it turns the
// adjudicated risks, blind spots, and open questions into anchored validation actions. Rendering stays
// deterministic; if the planner fails or produces unanchored actions, we write flagged unavailability.

import type { ActionPlan as ActionPlanT, ActionPlanArtifact, IntentContract, JudgeReport, PlannerUnavailable } from '../../schemas/index.js';
import { ActionPlan } from '../../schemas/index.js';
import { z } from 'zod';
import { BudgetExceeded, isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { loadSkill } from '../skills.js';
import type { SeatOutput } from './s4-analyze.js';
import { mergeOpenQuestions } from './s10-render.js';
import type { DecisionGraph } from '../decision-graph.js';

interface UpheldRisk {
  id: string;
  assumption: string;
  severity: 'HIGH' | 'MED' | 'LOW';
  reasoning: string;
}

export interface PlanAnchors {
  claimIds: string[];
  blindSpots: string[];
  openQuestions: string[];
}

const PlannerOutput = z.object({
  actions: z.array(z.object({
    order: z.number().int().min(1).optional(),
    action: z.string().min(1),
    why: z.string().min(1),
    validates: z.string().min(1),
    effort: z.string().min(1).optional(),
    kill_signal: z.string().min(1),
  }).strict()).min(1).max(7),
  sequencing_note: z.string().min(1),
}).strict();
type PlannerOutput = z.infer<typeof PlannerOutput>;

const S9B_PROMPT = `ROLE: Validation planner. You write the next actions for a decision-maker after an
idea council has already debated and judged the idea. Do not write a build roadmap. Write only validation
actions that test unsettled risks, blind spots, or open questions. Cheapest decisive test first.{{SKILL}}

Output ONLY JSON matching the ActionPlan schema:
- actions: 1-7 ordered actions, each imperative and concrete.
- validates MUST anchor to one of:
  - a graph claim id from upheld_risks, e.g. "G3"
  - a blind spot label as "blind:<label>"
  - an open-question prefix as "Q:<question prefix>"
- why ties the action to the risk, blind spot, or question.
- kill_signal is the result that should stop or reshape the idea.
- sequencing_note explains why this order is cheapest and decisive.

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

function unresolvedRisks(graph: DecisionGraph, judgeReport: JudgeReport): UpheldRisk[] {
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const risks = graph.claims
    .map((claim) => {
      const adj = rulingById.get(claim.id);
      if (adj?.ruling !== 'UPHOLD') return null;
      return {
        id: claim.id,
        assumption: claim.proposition,
        severity: claim.sensitivity === 'DECISIVE' ? 'HIGH' as const : claim.sensitivity === 'MATERIAL' ? 'MED' as const : 'LOW' as const,
        reasoning: adj.reasoning,
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

export function buildActionPlannerPrompt(input: {
  task: string;
  recommendation?: string;
  conditions?: string[];
  upheld_risks: UpheldRisk[];
  blind_spots: string[];
  open_questions: string[];
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

export function anchoredActionPlan(plan: ActionPlanT, anchors: PlanAnchors): ActionPlanT | null {
  const actions = plan.actions
    .filter((a) => validAnchor(a.validates, anchors))
    .sort((a, b) => a.order - b.order)
    .map((a, i) => ({ ...a, order: i + 1 }));
  if (actions.length === 0) return null;
  return { actions, sequencing_note: plan.sequencing_note };
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

export function normalizePlannerOutput(plan: PlannerOutput): ActionPlanT {
  return ActionPlan.parse({
    actions: plan.actions.map((action, i) => ({
      ...action,
      order: i + 1,
      effort: normalizeEffort(action.effort),
    })),
    sequencing_note: plan.sequencing_note,
  });
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
): Promise<ActionPlanArtifact> {
  const openQuestions = mergeOpenQuestions(seats);
  const risks = unresolvedRisks(graph, judgeReport);
  const blindSpots = graph.holes.coverage.map((hole) => hole.label);
  const anchors: PlanAnchors = {
    claimIds: risks.map((r) => r.id),
    blindSpots,
    openQuestions,
  };
  const fallback = async (flag: 'plan_skipped' | 'plan_fallback'): Promise<ActionPlanArtifact> => {
    ctx.addFlag(flag);
    const plan = unavailablePlan(flag === 'plan_skipped' ? 'budget_exhausted' : 'planner_failed', contract, risks, blindSpots, openQuestions);
    await ctx.writer.writeJson('action-plan', plan);
    return plan;
  };

  if (ctx.budget.limit - ctx.budget.used < 2) return fallback('plan_skipped');

  const prompt = buildActionPlannerPrompt({
    task: contract.task,
    recommendation: judgeReport.recommendation,
    conditions: judgeReport.conditions,
    upheld_risks: risks,
    blind_spots: blindSpots,
    open_questions: openQuestions,
  }, loadSkill('idea-refinement', 'planner'));

  try {
    const first = normalizePlannerOutput(await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-plan', prompt, PlannerOutput));
    const anchored = anchoredActionPlan(first, anchors);
    if (anchored) {
      await ctx.writer.writeJson('action-plan', anchored);
      return anchored;
    }
    if (ctx.budget.limit - ctx.budget.used < 1) return fallback('plan_fallback');
    const repair =
      `${prompt}\n\n---\nYour previous plan had no actions with valid anchors.\n` +
      `Valid graph claim ids: ${anchors.claimIds.join(', ') || '(none)'}\n` +
      `Valid blind spots: ${anchors.blindSpots.join(' | ') || '(none)'}\n` +
      `Valid open questions: ${anchors.openQuestions.join(' | ') || '(none)'}\n` +
      `Output ONLY corrected JSON with every action anchored to one of those values.`;
    const repaired = normalizePlannerOutput(await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-anchor-repair', repair, PlannerOutput));
    const repairedAnchored = anchoredActionPlan(repaired, anchors);
    if (repairedAnchored) {
      await ctx.writer.writeJson('action-plan', repairedAnchored);
      return repairedAnchored;
    }
    return fallback('plan_fallback');
  } catch (e) {
    if (isFatal(e) && !(e instanceof BudgetExceeded)) throw e;
    return fallback('plan_fallback');
  }
}
