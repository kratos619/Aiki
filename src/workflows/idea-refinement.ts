// idea-refinement workflow (§12.1). Stage COMPOSITION only — no orchestration mechanics (those
// live in the engine) and, for now, prompts inline here rather than in skills/<workflow>/ (the
// full skill loader + registry, §11, is deferred; it must not register without bench/ + validate.ts).
//
// v1 T5 scope: S1 → S2 → S3. S4–S10 are added as later tasks extend this composition.

import { resolve } from 'node:path';
import type { RunCtx } from '../orchestration/context.js';
import { s1Intent } from '../orchestration/stages/s1-intent.js';
import { s2Misread } from '../orchestration/stages/s2-misread.js';
import { s3Prompts } from '../orchestration/stages/s3-prompts.js';
import { s4Analyze } from '../orchestration/stages/s4-analyze.js';
import { s5Drift } from '../orchestration/stages/s5-drift.js';
import { s6Claims } from '../orchestration/stages/s6-claims.js';
import { s7Disagreement, type RubricItem } from '../orchestration/stages/s7-disagreement.js';
import { s8Verify } from '../orchestration/stages/s8-verify.js';
import { s9Judge } from '../orchestration/stages/s9-judge.js';
import { s10Render } from '../orchestration/stages/s10-render.js';

/** §12.1 idea-vetting rubric: 12 mandatory coverage items. S7 flags any item no analyst addressed
 *  as a blind spot. Inlined here (like the S4 template) while the skill/`rubric.json` loader (§11)
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
];

/** §13 S4 analyst template (idea-refinement). S3 fills its slots; S4 will consume it (T6). */
export const IDEA_S4_ANALYST_TEMPLATE = `ROLE: Independent analyst on a decision panel. You work ALONE; you will not see
other analysts' output. Be adversarial toward the idea, not polite.

TASK CONTRACT: {{INTENT_CONTRACT_JSON}}
INPUT DOCUMENT: read the file at {{INPUT_PATH}}

Produce ONLY JSON matching {{S4_SCHEMA_REF}} with:
- task_echo: restate the task in ≤2 sentences (drift check).
- strongest_version: the best honest version of this idea in ≤150 words.
- assumptions: ≤8, each {id "A1"..., statement, type VERIFIABLE|JUDGMENT, load_bearing bool}.
- attacks: ≤6, each {id "X1"..., target_assumption, argument, severity HIGH|MED|LOW}.
  Every attack MUST target an assumption id. Unanchored attacks will be discarded.
- open_questions: ≤5 questions whose answers would change the verdict.
Rules: no motivation, no summaries of your own output, no markdown, JSON only.`;

/** Runs the full idea-refinement pipeline S1–S10. Throws on any fatal condition; the engine's
 *  `executeRun` wrapper turns that into a graceful failure + meta. */
export async function runIdeaRefinement(ctx: RunCtx, input: string): Promise<void> {
  const contract = await s1Intent(ctx, input);
  const guard = await s2Misread(ctx, contract, input);

  // Persist the input as a file so S4's "read the file at {{INPUT_PATH}}" resolves.
  await ctx.writer.writeInput('idea.md', input);
  const inputPath = resolve(ctx.writer.dir, 'inputs', 'idea.md');

  const stagePrompts = await s3Prompts(ctx, {
    contract,
    interpretation: guard.chosen.my_interpretation,
    templates: { analyst: IDEA_S4_ANALYST_TEMPLATE },
    slots: { INPUT_PATH: inputPath, S4_SCHEMA_REF: 'the idea-refinement S4 RoleOutput schema' },
  });

  // s3Prompts guarantees an entry for every template key (it iterates them), so `analyst` is present.
  const seats = await s4Analyze(ctx, stagePrompts.prompts.analyst!);
  const { kept } = await s5Drift(ctx, contract, seats);
  const claimSet = await s6Claims(ctx, kept);
  const map = await s7Disagreement(ctx, claimSet, kept, IDEA_RUBRIC);
  const verifications = await s8Verify(ctx, map);
  const judgeReport = await s9Judge(ctx, contract, map, verifications, IDEA_RUBRIC);
  await s10Render(ctx, { contract, seats: kept, map, verifications, judgeReport });
}
