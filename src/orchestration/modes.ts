import type { IdeaMode } from '../schemas/index.js';

export interface IdeaModePlan {
  baseCalls: number;
  optionalCalls: number;
  maxCalls: number;
  reservedCalls: number;
  defaultBudget: number;
  deadlineMs: number;
}

const MINUTE = 60 * 1000;
const FULL_COUNCIL_PLAN: IdeaModePlan = {
  baseCalls: 6,
  optionalCalls: 4,
  maxCalls: 10,
  // v6: chair + planner + ONE tail repair. Run f740 proved 2 was not enough — upstream repairs
  // drained the cushion and the planner's complete deliverables died unrepairables at 12/12.
  reservedCalls: 3,
  defaultBudget: 12,
  deadlineMs: 45 * MINUTE,
};

/** Nominal calls exclude schema repairs; the adaptive default leaves a small repair cushion.
 *  `deadlineMs` is the wall-clock outer bound — the full council includes web investigation plus
 *  repairs, coverage-fill, verification, rebuttal, chair, and planner. The per-call timeout (900s)
 *  stays the real runaway guard; this only bounds the SUM. 45 min matches the bench's proven ceiling
 *  for a hard research case (run 20260715-1404 died at S9 on the flat 20-min cap after valid work). */
export const IDEA_MODE_PLANS: Record<IdeaMode, IdeaModePlan> = {
  quick: { baseCalls: 3, optionalCalls: 0, maxCalls: 3, reservedCalls: 0, defaultBudget: 4, deadlineMs: 20 * MINUTE },
  council: FULL_COUNCIL_PLAN,
  research: FULL_COUNCIL_PLAN,
};

export const LEGACY_DEFAULT_BUDGET = 18;
export const LEGACY_DEADLINE_MS = 20 * MINUTE;

/** Every non-quick idea run is the full source-investigating council. `research` remains a CLI alias. */
export function inferIdeaMode(_input: string): IdeaMode {
  return 'council';
}

export function defaultBudgetFor(
  workflow: 'idea-refinement' | 'code-review',
  mode: IdeaMode = 'council',
): number {
  return workflow === 'idea-refinement' ? IDEA_MODE_PLANS[mode].defaultBudget : LEGACY_DEFAULT_BUDGET;
}

/** Mode-aware wall-clock default, mirroring defaultBudgetFor. Code-review keeps the legacy 20-min cap. */
export function defaultDeadlineFor(
  workflow: 'idea-refinement' | 'code-review',
  mode: IdeaMode = 'council',
): number {
  return workflow === 'idea-refinement' ? IDEA_MODE_PLANS[mode].deadlineMs : LEGACY_DEADLINE_MS;
}

export type CallCategory = 'discovery' | 'verification' | 'repair' | 'planning';

export function callCategory(stage: string): CallCategory {
  if (stage.toLowerCase().includes('repair')) return 'repair';
  if (stage.startsWith('S9b')) return 'planning';
  if (stage.startsWith('S8') || stage === 'S9' || stage.startsWith('S9-')) return 'verification';
  return 'discovery';
}

/** Logical optional work. Replayed attempts still count so resume cannot widen the protocol. */
export function isOptionalStage(stage: string): boolean {
  return stage === 'S7-coverage-fill' || stage === 'S8' || stage.startsWith('S8b-');
}
