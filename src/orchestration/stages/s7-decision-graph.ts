// S7 — semantic grouping plus pure decision-graph compilation. The grouping call sees anonymous
// aliases and may only return references; original analyst text is never rewritten.

import type { DecisionGraph } from '../decision-graph.js';
import { compileDecisionGraph, positionId } from '../decision-graph.js';
import { ClaimGroups } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { PositionSet } from './s6-positions.js';

export interface RubricItem {
  id: string;
  label: string;
  keywords: string[];
}

const S7_GROUP_PROMPT = `Group anonymous positions that address the SAME decision-critical proposition.
Wording may differ or express opposite claims; group positions when their stances can be directly compared.
Do not group items that are merely related or share a topic.

Output ONLY JSON: {"groups": [["<id>","<id>", ...], ...]}
- Each group contains 2+ IDs.
- Use ONLY the anonymous IDs shown below. Never rewrite text.
- If nothing matches, output {"groups": []}.

POSITIONS: {{POSITIONS_JSON}}`;

interface GroupingInput {
  prompt: string;
  refs: Map<string, string>;
}

/** Build the by-reference grouping prompt without provider names or provider-derived IDs. */
export function buildGroupingInput(submissions: PositionSet): GroupingInput {
  const refs = new Map<string, string>();
  const anonymous = submissions.flatMap(({ provider, source_id = provider, submission }) =>
    submission.positions.map((position) => {
      const alias = `P${refs.size + 1}`;
      refs.set(alias, positionId(provider, position.local_id, source_id));
      return { id: alias, proposition: position.proposition, stance: position.stance };
    }));
  return {
    prompt: S7_GROUP_PROMPT.replace('{{POSITIONS_JSON}}', JSON.stringify(anonymous, null, 2)),
    refs,
  };
}

async function semanticGroups(ctx: RunCtx, submissions: PositionSet): Promise<string[][]> {
  const { prompt, refs } = buildGroupingInput(submissions);
  if (refs.size < 2) return [];
  try {
    const result = await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S7-group', prompt, ClaimGroups);
    const used = new Set<string>();
    const groups: string[][] = [];
    for (const group of result.groups) {
      if (group.length >= 2 && group.every((alias) => refs.has(alias) && !used.has(alias))) {
        group.forEach((alias) => used.add(alias));
        groups.push(group.map((alias) => refs.get(alias)!));
      }
    }
    return groups;
  } catch (error) {
    if (isFatal(error)) throw error;
    return [];
  }
}

export async function s7DecisionGraph(
  ctx: RunCtx,
  submissions: PositionSet,
  rubric: RubricItem[],
): Promise<DecisionGraph> {
  const groups = await semanticGroups(ctx, submissions);
  const graph = compileDecisionGraph(submissions, rubric, groups);
  await ctx.writer.writeJson('decision-graph', graph);
  return graph;
}
