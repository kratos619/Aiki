import { loadSkill } from './skills.js';

export const IDEA_LANES = ['market-adoption', 'economics-delivery'] as const;
export type IdeaLane = (typeof IDEA_LANES)[number];
export type LanePrompts = Record<IdeaLane, string>;

const CORE_OWNERSHIP: Record<IdeaLane, Set<string>> = {
  'market-adoption': new Set(['R1', 'R2', 'R3', 'R9', 'R10', 'R13']),
  'economics-delivery': new Set(['R4', 'R5', 'R6', 'R7', 'R8', 'R11', 'R12']),
};

export function buildLanePrompts(basePrompt: string, rubric: Array<{ id: string; label: string }>): LanePrompts {
  const domainIds = rubric.filter((item) => item.id.startsWith('D')).map((item) => item.id);
  const prompt = (lane: IdeaLane, domainParity: number): string => {
    const owned = rubric.filter((item) => {
      const domainIndex = domainIds.indexOf(item.id);
      return CORE_OWNERSHIP[lane].has(item.id) || (domainIndex >= 0 && domainIndex % 2 === domainParity);
    });
    return `${basePrompt}\n\nLANE: ${lane}\nOWNED DIMENSIONS — include one explicit coverage entry for every item:\n${owned.map((item) => `- ${item.id}: ${item.label}`).join('\n')}\n\n${loadSkill('idea-refinement', lane)}`;
  };
  return {
    'market-adoption': prompt('market-adoption', 0),
    'economics-delivery': prompt('economics-delivery', 1),
  };
}
