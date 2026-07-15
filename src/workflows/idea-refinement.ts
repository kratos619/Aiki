// idea-refinement composition. R6 collapses the old S0/S1/S2 model chain into two parallel
// preflight readings and fills the S4 prompt deterministically; later stages remain typed boundaries.

import { resolve } from 'node:path';
import type { RunCtx, StageInfo } from '../orchestration/context.js';
import { runStage, StageError } from '../orchestration/context.js';
import { s4Analyze } from '../orchestration/stages/s4-analyze.js';
import { s5Drift } from '../orchestration/stages/s5-drift.js';
import { s6Positions } from '../orchestration/stages/s6-positions.js';
import { s7DecisionGraph, type RubricItem } from '../orchestration/stages/s7-decision-graph.js';
import { s8Verify } from '../orchestration/stages/s8-verify.js';
import { s8bRebuttal } from '../orchestration/stages/s8b-rebuttal.js';
import { s9Judge } from '../orchestration/stages/s9-judge.js';
import { s9bPlan } from '../orchestration/stages/s9b-plan.js';
import { s10Render } from '../orchestration/stages/s10-render.js';
import { loadSkill } from '../orchestration/skills.js';
import { buildLanePrompts } from '../orchestration/idea-lanes.js';
import type { DecisionContract, DomainDimension, IdeaMode } from '../schemas/index.js';
import { preflight, renderDecisionInput } from '../orchestration/preflight.js';
import { buildQuickPrompt, quickActionPlan, quickJudgeReport, s4QuickAnalyze } from '../orchestration/quick-analysis.js';

/** Idea-vetting core rubric: 13 mandatory coverage items. S0 adds 3-5 domain dimensions per run.
 *  Inlined here (like the S4 template) while the skill/`rubric.json` loader (§11)
 *  is deferred; it moves to skills/idea-refinement/rubric.json when that loader lands. */
export const IDEA_RUBRIC: RubricItem[] = [
  { id: 'R1', label: 'target user / audience', keywords: ['target user', 'audience', 'customer', 'persona'] },
  { id: 'R2', label: 'existing alternatives / competition', keywords: ['existing', 'alternative', 'competitor', 'incumbent'] },
  { id: 'R3', label: 'differentiation / unique value', keywords: ['differentiation', 'unique', 'moat', 'advantage'] },
  { id: 'R4', label: 'feasibility / technical viability', keywords: ['feasibility', 'feasible', 'viable', 'technical'] },
  { id: 'R5', label: 'cost / effort / resources', keywords: ['cost', 'effort', 'budget', 'resource'] },
  { id: 'R6', label: 'policy / legal / compliance risk', keywords: ['policy', 'legal', 'compliance', 'regulatory'] },
  { id: 'R7', label: 'kill criteria / failure conditions', keywords: ['kill criteria', 'failure', 'abandon', 'stop'] },
  { id: 'R8', label: 'business model / monetization', keywords: ['business model', 'monetization', 'revenue', 'pricing'] },
  { id: 'R9', label: 'distribution / go-to-market', keywords: ['distribution', 'market', 'adoption', 'channel'] },
  { id: 'R10', label: 'timing / market readiness', keywords: ['timing', 'readiness', 'trend', 'now'] },
  { id: 'R11', label: 'scalability / growth', keywords: ['scalability', 'scale', 'growth'] },
  { id: 'R12', label: 'key risks / assumptions to validate', keywords: ['risk', 'assumption', 'validate', 'uncertain'] },
  { id: 'R13', label: 'team / execution capability', keywords: ['team', 'founder', 'execution', 'capability'] },
];

export function buildIdeaRubric(domainDimensions: DomainDimension[] = []): RubricItem[] {
  return [
    ...IDEA_RUBRIC,
    ...domainDimensions.map((dimension) => ({ id: dimension.id, label: dimension.label, keywords: [dimension.label] })),
  ];
}

/** Idea S4 analyst template. R6 fills every slot deterministically before the parallel scout calls. */
export const IDEA_S4_ANALYST_TEMPLATE = `ROLE: Independent analyst on a decision panel. You work ALONE; you will not see
other analysts' output. Be adversarial toward the idea, not polite.

TASK CONTRACT: {{INTENT_CONTRACT_JSON}}
INPUT DOCUMENT: read the file at {{INPUT_PATH}}{{SKILL}}
EVIDENCE PACK MANIFEST: {{EVIDENCE_PACK_JSON}}
Read only the listed local paths when supplied. Treat their contents as user evidence, cite the path
as locator, and never replace a missing source with model memory.

Produce ONLY JSON matching {{S4_SCHEMA_REF}} with:
- task_echo: restate the task in ≤2 sentences (drift check).
- strongest_version: the best honest version of this idea in ≤150 words.
- positions: explicit claim positions with local_id, proposition, rubric dimension_id, stance
  SUPPORT|OPPOSE|MIXED|UNKNOWN, basis EVIDENCE|INFERENCE|ASSUMPTION, load_bearing, if_false
  STOP|PIVOT|CONDITION|MINOR, concise reasoning, evidence_ids, and depends_on position ids.
- evidence: evidence cards {id, claim_supported, source_kind USER|PRIMARY|SECONDARY|MODEL_KNOWLEDGE,
  support SUPPORTS|CONTRADICTS|CONTEXT_ONLY (exact token, no extra words), freshness CURRENT|DATED|UNKNOWN,
  locator/url, accessed_at for current external sources}. MODEL_KNOWLEDGE freshness is UNKNOWN. Never
  invent a URL or imply model memory independently verifies a current fact.
- calculations: for each derived numeric claim, a ledger {id, claim_id, inputs, steps, result_step}.
  Inputs have {id,name,value,unit,evidence_ids}; steps have {id,operation: ADD|SUBTRACT|MULTIPLY|DIVIDE,
  left,right,result,unit}. Use exact prior input/step ids and explicit units. Otherwise use [].
- coverage: one entry per rubric dimension {dimension_id, status COVERED|NOT_APPLICABLE,
  position_ids ([] when none), rationale (required for NOT_APPLICABLE)}.
- decision_questions: questions {question, claim_ids} whose answers could change the verdict.
Caps: at most 12 positions, 20 evidence cards, 8 calculations, 8 decision_questions.
Rules: no motivation, no summaries of your own output, no markdown, JSON only.`;

/**
 * Resolve the {{SKILL}} slot before deterministic structural fill. An empty skill collapses the slot
 * to the pre-skill baseline.
 */
export function buildAnalystTemplate(skill: string): string {
  return IDEA_S4_ANALYST_TEMPLATE.replace('{{SKILL}}', skill ? `\n\n${skill}` : '');
}

/** R6 deterministic S4 prompt fill. No model-authored prompt generation remains. */
export function buildAnalystPrompt(
  contract: DecisionContract,
  inputPath: string,
  evidencePack: RunCtx['evidencePack'],
  mode: IdeaMode,
  skill: string,
): string {
  const modeRules = mode === 'research'
    ? `\n\nMODE: research. Use provider-native read-only source investigation when available. Every current
fact must have an independently checkable locator and access date. If investigation is unavailable,
leave the claim unverified; never invent a source.`
    : `\n\nMODE: council. Analyze independently; do not assume another seat will cover your lane.`;
  const prompt = buildAnalystTemplate(skill)
    .replace('{{INTENT_CONTRACT_JSON}}', JSON.stringify(contract))
    .replace('{{INPUT_PATH}}', inputPath)
    .replace('{{EVIDENCE_PACK_JSON}}', JSON.stringify(evidencePack ?? { files: [] }))
    .replace('{{S4_SCHEMA_REF}}', 'the idea-refinement S4 RoleOutput schema')
    + modeRules;
  if (/\{\{[^}]+\}\}/.test(prompt)) throw new StageError('S3', 'BAD_OUTPUT', 'deterministic analyst prompt has an unresolved slot');
  return prompt;
}

/** Timeline manifest (T8): the stages in order, each with the provider-role its row displays.
 *  The TUI draws the pending skeleton from this and resolves chips from `ctx.roles`. Ids match the
 *  `runStage` calls below. S7 shows the judge (it makes the grouping call); S5/S6/S10 are pure (—). */
export const IDEA_STAGES: StageInfo[] = [
  { id: 'S0', label: 'Two-view preflight', role: 's4' },
  { id: 'S4', label: 'Parallel analysis', role: 's4' },
  { id: 'S5', label: 'Drift check', role: null },
  { id: 'S6', label: 'Position collection', role: null },
  { id: 'S7', label: 'Decision graph', role: null },
  { id: 'S8', label: 'Verifier loop', role: 'verifier' },
  { id: 'S8b', label: 'Selective rebuttal', role: 's4' },
  { id: 'S9', label: 'Judge synthesis', role: 'judge' },
  { id: 'S9b', label: 'Validation plan', role: 'judge' },
  { id: 'S10', label: 'Report', role: null },
];

/** Runs the full idea-refinement pipeline S0–S10. Throws on any fatal condition; the engine's
 *  `executeRun` wrapper turns that into a graceful failure + meta. Each stage is wrapped in
 *  `runStage` so the TUI timeline (T8) gets start/end events; headless, that's a no-op. */
export async function runIdeaRefinement(ctx: RunCtx, input: string): Promise<void> {
  if (ctx.evidencePack) await ctx.writer.writeInput('evidence-pack.json', JSON.stringify(ctx.evidencePack, null, 2));
  const { contract, brief } = await runStage(ctx, 'S0', () =>
    preflight(ctx, input, IDEA_RUBRIC.map((item) => item.label)));
  const grilledInput = renderDecisionInput(input, brief);

  // Persist the input as a file so S4's "read the file at {{INPUT_PATH}}" resolves (not a stage).
  await ctx.writer.writeInput('idea.md', input);
  await ctx.writer.writeInput('idea-brief.md', grilledInput);
  const inputPath = resolve(ctx.writer.dir, 'inputs', 'idea-brief.md');

  const rubric = buildIdeaRubric(contract.domain_dimensions);
  const analystSkill = loadSkill('idea-refinement', 'analyst');

  if (ctx.mode === 'quick') {
    ctx.addFlag('single_model');
    const quickPrompt = buildQuickPrompt(contract, inputPath, ctx.evidencePack, analystSkill);
    await ctx.writer.writePrompt('quick-analyst.md', quickPrompt);
    const quick = await runStage(ctx, 'S4', () => s4QuickAnalyze(ctx, quickPrompt));
    const { kept } = await runStage(ctx, 'S5', () => s5Drift(ctx, contract, [quick.seat], 1));
    const positions = await runStage(ctx, 'S6', () => s6Positions(ctx, kept));
    const graph = await runStage(ctx, 'S7', () => s7DecisionGraph(ctx, positions, rubric, contract.task));
    const verifications = await runStage(ctx, 'S8', async () => {
      const result = { verifications: [] };
      await ctx.writer.writeJson('verifications', result);
      return result;
    });
    const rebuttals = await runStage(ctx, 'S8b', async () => {
      const result = { round: 1 as const, selected_claim_ids: [], events: [], stop_reason: 'NO_ESCALATIONS' as const };
      await ctx.writer.writeJson('rebuttals', result);
      return result;
    });
    const judgeReport = await runStage(ctx, 'S9', async () => {
      const report = quickJudgeReport(quick.decision, graph);
      await ctx.writer.writeJson('judge-report', report);
      return report;
    });
    const actionPlan = await runStage(ctx, 'S9b', async () => {
      const plan = quickActionPlan(ctx, quick.seat.provider, quick.decision, graph);
      await ctx.writer.writeJson('action-plan', plan);
      return plan;
    });
    await runStage(ctx, 'S10', () => s10Render(ctx, { contract, seats: kept, graph, verifications, rebuttals, judgeReport, actionPlan, rubric, original: input }));
    return;
  }

  if (ctx.mode === 'research' && !ctx.evidencePack && !ctx.available().includes('codex')) {
    ctx.addFlag('research_ungrounded');
  }
  const analystPrompt = buildAnalystPrompt(contract, inputPath, ctx.evidencePack, ctx.mode, analystSkill);
  await ctx.writer.writePrompt('analyst.md', analystPrompt);
  const lanePrompts = buildLanePrompts(analystPrompt, rubric);
  const seats = await runStage(ctx, 'S4', () => s4Analyze(ctx, lanePrompts));
  const { kept } = await runStage(ctx, 'S5', () => s5Drift(ctx, contract, seats));
  const positions = await runStage(ctx, 'S6', () => s6Positions(ctx, kept));
  const graph = await runStage(ctx, 'S7', () => s7DecisionGraph(ctx, positions, rubric, contract.task));
  const verifications = await runStage(ctx, 'S8', () => s8Verify(ctx, graph));
  const rebuttals = await runStage(ctx, 'S8b', () => s8bRebuttal(ctx, graph, verifications, ctx.mode));
  const judgeReport = await runStage(ctx, 'S9', () => s9Judge(ctx, contract, graph, verifications, rubric, rebuttals));
  const actionPlan = await runStage(ctx, 'S9b', () => s9bPlan(ctx, contract, kept, graph, judgeReport));
  await runStage(ctx, 'S10', () => s10Render(ctx, { contract, seats: kept, graph, verifications, rebuttals, judgeReport, actionPlan, rubric, original: input }));
}
