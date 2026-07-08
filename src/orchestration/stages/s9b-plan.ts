// S9b — idea validation plan. This is the one report-v3 model call after the judge: it turns the
// adjudicated risks, blind spots, and open questions into anchored validation actions. Rendering stays
// deterministic; if the planner fails or produces unanchored actions, we write a flagged fallback plan.

import type { ActionPlan as ActionPlanT, DisagreementMap, IntentContract, JudgeReport } from '../../schemas/index.js';
import { ActionPlan } from '../../schemas/index.js';
import { BudgetExceeded, isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { loadSkill } from '../skills.js';
import type { SeatOutput } from './s4-analyze.js';
import { mergeOpenQuestions } from './s10-render.js';

interface UpheldRisk {
  id: string;
  assumption: string;
  severity: 'HIGH' | 'MED' | 'LOW';
  reasoning: string;
}

export interface PlanAnchors {
  disputeIds: string[];
  blindSpots: string[];
  openQuestions: string[];
}

const S9B_PROMPT = `ROLE: Validation planner. You write the next actions for a decision-maker after an
idea council has already debated and judged the idea. Do not write a build roadmap. Write only validation
actions that test unsettled risks, blind spots, or open questions. Cheapest decisive test first.{{SKILL}}

Output ONLY JSON matching the ActionPlan schema:
- actions: 1-7 ordered actions, each imperative and concrete.
- validates MUST anchor to one of:
  - a dispute id from upheld_risks, e.g. "D3"
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

function questionAnchor(q: string): string {
  return `Q:${clip(q, 90)}`;
}

function blindAnchor(b: string): string {
  return `blind:${b}`;
}

function upheldRisks(map: DisagreementMap, judgeReport: JudgeReport): UpheldRisk[] {
  const claimById = new Map([...map.consensus, ...map.unique].map((c) => [c.id, c.statement]));
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  return map.contradictions
    .map((d) => {
      const adj = rulingById.get(d.id);
      if (adj?.ruling !== 'UPHOLD') return null;
      return {
        id: d.id,
        assumption: d.claim_ids.map((id) => claimById.get(id) ?? id).join(' / '),
        severity: [...d.attacks].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))[0]?.severity ?? 'MED',
        reasoning: adj.reasoning,
      };
    })
    .filter((r): r is UpheldRisk => r !== null)
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
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
  if (anchors.disputeIds.includes(a)) return true;
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

export function fallbackActionPlan(contract: IntentContract, map: DisagreementMap, judgeReport: JudgeReport, openQuestions: string[]): ActionPlanT {
  const risks = upheldRisks(map, judgeReport);
  const actions: ActionPlanT['actions'] = [];
  for (const r of risks) {
    actions.push({
      order: actions.length + 1,
      action: `Test whether "${clip(r.assumption, 120)}" is true with the smallest realistic sample.`,
      why: `The chair upheld this as a load-bearing ${r.severity} risk.`,
      validates: r.id,
      effort: 'S',
      kill_signal: 'The assumption fails in the sample or only works outside the intended use case.',
    });
  }
  for (const b of map.blind_spots) {
    actions.push({
      order: actions.length + 1,
      action: `Answer the ${b} gap with one concrete evidence source.`,
      why: 'No analyst examined this dimension enough to rely on it.',
      validates: blindAnchor(b),
      effort: 'S',
      kill_signal: 'The answer exposes a hard blocker or makes the target user/use case incoherent.',
    });
  }
  for (const q of openQuestions) {
    actions.push({
      order: actions.length + 1,
      action: `Resolve this question: ${clip(q, 140)}`,
      why: 'The analysts identified it as an answer that could change the verdict.',
      validates: questionAnchor(q),
      effort: 'S',
      kill_signal: 'The answer contradicts the value proposition or removes the target user.',
    });
  }
  if (actions.length === 0) {
    const q = `What evidence would change the verdict for ${clip(contract.task, 80)}?`;
    actions.push({
      order: 1,
      action: 'Run one cheap test of the core user need before investing more.',
      why: 'The council produced no unsettled anchored item, so validate the core demand directly.',
      validates: questionAnchor(q),
      effort: 'S',
      kill_signal: 'Target users do not recognize the problem or would not switch from existing alternatives.',
    });
  }
  return ActionPlan.parse({
    actions: actions.slice(0, 7).map((a, i) => ({ ...a, order: i + 1 })),
    sequencing_note: 'Start with upheld risks, then blind spots, then open questions; stop when a kill signal fires.',
  });
}

export async function s9bPlan(
  ctx: RunCtx,
  contract: IntentContract,
  seats: SeatOutput[],
  map: DisagreementMap,
  judgeReport: JudgeReport,
): Promise<ActionPlanT> {
  const openQuestions = mergeOpenQuestions(seats);
  const risks = upheldRisks(map, judgeReport);
  const anchors: PlanAnchors = {
    disputeIds: risks.map((r) => r.id),
    blindSpots: map.blind_spots,
    openQuestions,
  };
  const fallback = async (flag: 'plan_skipped' | 'plan_fallback'): Promise<ActionPlanT> => {
    ctx.addFlag(flag);
    const plan = fallbackActionPlan(contract, map, judgeReport, openQuestions);
    await ctx.writer.writeJson('action-plan', plan);
    return plan;
  };

  if (ctx.budget.limit - ctx.budget.used < 2) return fallback('plan_skipped');

  const prompt = buildActionPlannerPrompt({
    task: contract.task,
    recommendation: judgeReport.recommendation,
    conditions: judgeReport.conditions,
    upheld_risks: risks,
    blind_spots: map.blind_spots,
    open_questions: openQuestions,
  }, loadSkill('idea-refinement', 'planner'));

  try {
    const first = await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-plan', prompt, ActionPlan);
    const anchored = anchoredActionPlan(first, anchors);
    if (anchored) {
      await ctx.writer.writeJson('action-plan', anchored);
      return anchored;
    }
    if (ctx.budget.limit - ctx.budget.used < 1) return fallback('plan_fallback');
    const repair =
      `${prompt}\n\n---\nYour previous plan had no actions with valid anchors.\n` +
      `Valid dispute ids: ${anchors.disputeIds.join(', ') || '(none)'}\n` +
      `Valid blind spots: ${anchors.blindSpots.join(' | ') || '(none)'}\n` +
      `Valid open questions: ${anchors.openQuestions.join(' | ') || '(none)'}\n` +
      `Output ONLY corrected JSON with every action anchored to one of those values.`;
    const repaired = await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S9b-anchor-repair', repair, ActionPlan);
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
