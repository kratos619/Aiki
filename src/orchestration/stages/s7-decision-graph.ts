// S7 — deterministic conservative grouping plus pure decision-graph compilation. R6 removes the
// model-authored grouping call so graph audit spends no provider call on an obvious run.

import type { DecisionGraph } from '../decision-graph.js';
import { compileDecisionGraph, coverageHoleQueue, positionId, type CoverageHole } from '../decision-graph.js';
import { IdeaRoleOutputModel, type IdeaRoleOutput } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { detectWeakSeat, type PositionSet } from './s6-positions.js';
import { overlapCoefficient, tokenize } from '../cluster.js';

export interface RubricItem {
  id: string;
  label: string;
  keywords: string[];
}

const GROUP_SIMILARITY = 0.8;

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
  if (holes.length === 0 || ctx.optionalCallsRemaining() === 0) return submissions;
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

/** Conservative exact/high-overlap grouping. False negatives stay separate; false merges are worse. */
export function deterministicClaimGroups(submissions: PositionSet): string[][] {
  const positions = submissions.flatMap(({ provider, source_id = provider, submission }) =>
    submission.positions.map((position) => ({
      id: positionId(provider, position.local_id, source_id),
      provider,
      dimension: position.dimension_id,
      proposition: position.proposition.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '),
      tokens: tokenize(position.proposition),
    })));
  const used = new Set<string>();
  const groups: string[][] = [];
  for (const first of positions) {
    if (used.has(first.id)) continue;
    const group = [first];
    for (const candidate of positions) {
      if (used.has(candidate.id) || candidate.id === first.id) continue;
      if (candidate.provider === first.provider || candidate.dimension !== first.dimension) continue;
      const same = candidate.proposition === first.proposition
        || overlapCoefficient(candidate.tokens, first.tokens) >= GROUP_SIMILARITY;
      if (same && !group.some((item) => item.provider === candidate.provider)) group.push(candidate);
    }
    if (group.length >= 2) {
      group.forEach((item) => used.add(item.id));
      groups.push(group.map((item) => item.id));
    }
  }
  return groups;
}

export async function s7DecisionGraph(
  ctx: RunCtx,
  submissions: PositionSet,
  rubric: RubricItem[],
  task = '',
): Promise<DecisionGraph> {
  const completed = await fillCoverage(ctx, submissions, rubric, task);
  const groups = deterministicClaimGroups(completed);
  const graph = compileDecisionGraph(completed, rubric, groups);
  if (detectWeakSeat(graph.positions, ctx.mode ?? 'council').length) ctx.addFlag('weak_seat');
  await ctx.writer.writeJson('decision-graph', graph);
  return graph;
}
