// S7 — semantic grouping plus pure decision-graph compilation. The grouping call sees anonymous
// aliases and may only return references; original analyst text is never rewritten.

import type { DecisionGraph } from '../decision-graph.js';
import { compileDecisionGraph, coverageHoleQueue, positionId, type CoverageHole } from '../decision-graph.js';
import { ClaimGroups, IdeaRoleOutputModel, type IdeaRoleOutput } from '../../schemas/index.js';
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

export function buildCoverageFillPrompt(task: string, holes: CoverageHole[]): string {
  return `TARGETED COVERAGE FILL. Answer only the missing dimensions below; do not repeat the full analysis.
TASK: ${task}
MISSING DIMENSIONS:
${holes.map((hole) => `- ${hole.dimension_id}: ${hole.label}`).join('\n')}

Output ONLY the idea analyst JSON schema. Emit positions/evidence only when needed. Include one explicit
COVERED entry anchored to a position, or a reasoned NOT_APPLICABLE entry, for every listed dimension.
Required top-level keys: task_echo, strongest_version, positions, evidence, calculations, coverage, decision_questions.
Use calculations: [] unless a new position makes a derived numeric claim.
Use the same position and evidence-card shapes as the initial analysis; JSON only.`;
}

async function fillCoverage(
  ctx: RunCtx,
  submissions: PositionSet,
  rubric: RubricItem[],
  task: string,
): Promise<PositionSet> {
  const holes = coverageHoleQueue(submissions, rubric);
  if (holes.length === 0) return submissions;
  const provider = ctx.roles.s4[0] ?? ctx.roles.analyst;
  try {
    const model = await jsonCall(ctx, ctx.handle(provider), 'S7-coverage-fill', buildCoverageFillPrompt(task, holes), IdeaRoleOutputModel, { repair: false });
    const output: IdeaRoleOutput = { workflow: 'idea-refinement', ...model };
    await ctx.writer.writeJson('coverage-fill', output);
    return [...submissions, { provider, source_id: `${provider}-coverage-fill`, submission: output }];
  } catch (error) {
    if (isFatal(error)) throw error;
    return submissions;
  }
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
  task = '',
): Promise<DecisionGraph> {
  const completed = await fillCoverage(ctx, submissions, rubric, task);
  const groups = await semanticGroups(ctx, completed);
  const graph = compileDecisionGraph(completed, rubric, groups);
  await ctx.writer.writeJson('decision-graph', graph);
  return graph;
}
