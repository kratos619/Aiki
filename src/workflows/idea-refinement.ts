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

/** Runs the idea-refinement pipeline to the currently-implemented depth (S1–S3). Throws on any
 *  fatal condition; the engine's `executeRun` wrapper turns that into a graceful failure + meta. */
export async function runIdeaRefinement(ctx: RunCtx, input: string): Promise<void> {
  const contract = await s1Intent(ctx, input);
  const guard = await s2Misread(ctx, contract, input);

  // Persist the input as a file so S4's "read the file at {{INPUT_PATH}}" resolves (T6).
  await ctx.writer.writeInput('idea.md', input);
  const inputPath = resolve(ctx.writer.dir, 'inputs', 'idea.md');

  await s3Prompts(ctx, {
    contract,
    interpretation: guard.chosen.my_interpretation,
    templates: { analyst: IDEA_S4_ANALYST_TEMPLATE },
    slots: { INPUT_PATH: inputPath, S4_SCHEMA_REF: 'the idea-refinement S4 RoleOutput schema' },
  });
}
