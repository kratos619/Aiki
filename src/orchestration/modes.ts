import type { IdeaMode } from '../schemas/index.js';

export interface IdeaModePlan {
  baseCalls: number;
  optionalCalls: number;
  maxCalls: number;
  reservedCalls: number;
  defaultBudget: number;
}

/** Nominal calls exclude schema repairs; the adaptive default leaves a small repair cushion. */
export const IDEA_MODE_PLANS: Record<IdeaMode, IdeaModePlan> = {
  quick: { baseCalls: 3, optionalCalls: 0, maxCalls: 3, reservedCalls: 0, defaultBudget: 4 },
  council: { baseCalls: 6, optionalCalls: 2, maxCalls: 8, reservedCalls: 2, defaultBudget: 10 },
  research: { baseCalls: 6, optionalCalls: 4, maxCalls: 10, reservedCalls: 2, defaultBudget: 12 },
};

export const LEGACY_DEFAULT_BUDGET = 18;

export function defaultBudgetFor(
  workflow: 'idea-refinement' | 'code-review',
  mode: IdeaMode = 'council',
): number {
  return workflow === 'idea-refinement' ? IDEA_MODE_PLANS[mode].defaultBudget : LEGACY_DEFAULT_BUDGET;
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
