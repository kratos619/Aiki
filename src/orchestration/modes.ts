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

/** Nominal calls exclude schema repairs; the adaptive default leaves a small repair cushion.
 *  `deadlineMs` is the wall-clock outer bound — research gets more headroom because it does 2-3× the
 *  work (repairs + coverage-fill + verify + rebuttal + chair + planner). The per-call timeout (900s)
 *  stays the real runaway guard; this only bounds the SUM. 45 min matches the bench's proven ceiling
 *  for a hard research case (run 20260715-1404 died at S9 on the flat 20-min cap after valid work). */
export const IDEA_MODE_PLANS: Record<IdeaMode, IdeaModePlan> = {
  quick: { baseCalls: 3, optionalCalls: 0, maxCalls: 3, reservedCalls: 0, defaultBudget: 4, deadlineMs: 20 * MINUTE },
  council: { baseCalls: 6, optionalCalls: 2, maxCalls: 8, reservedCalls: 2, defaultBudget: 10, deadlineMs: 20 * MINUTE },
  research: { baseCalls: 6, optionalCalls: 4, maxCalls: 10, reservedCalls: 2, defaultBudget: 12, deadlineMs: 45 * MINUTE },
};

export const LEGACY_DEFAULT_BUDGET = 18;
export const LEGACY_DEADLINE_MS = 20 * MINUTE;

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
