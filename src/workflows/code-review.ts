// code-review workflow (§12.2, T10). Stage COMPOSITION only. A bespoke lean pipeline — NOT the idea
// S1–S10 stages (findings have no assumption/attack structure): deterministic S1/S3 (no model calls) →
// S4 reviewers + file:line validator → S8 mutual cross-exam → deterministic ReviewMap → S9 judge → S10
// report. ~5 model calls. `input` is the unified diff (the CLI computed it via git; §12.2).
//
// Artifact order note: the ReviewMap (07) is written BEFORE the cross-exam verifications (08) even though
// it's derived from them — the artifact writer requires ascending stage ordinals, so S8 returns its data
// and the workflow orders the two writes.

import { resolve } from 'node:path';
import type { RunCtx, StageInfo } from '../orchestration/context.js';
import { runStage } from '../orchestration/context.js';
import type { IntentContract } from '../schemas/index.js';
import { parseDiffFiles } from '../orchestration/git.js';
import { s4Review } from '../orchestration/stages/cr-s4-review.js';
import { s8CrossExam } from '../orchestration/stages/cr-s8-crossexam.js';
import { buildReviewMap } from '../orchestration/stages/cr-map.js';
import { s9ReviewJudge } from '../orchestration/stages/cr-s9-judge.js';
import { s10ReviewRender } from '../orchestration/stages/cr-report.js';

/** §12.2 reviewer prompt (per reviewer). S3 fills {{DIFF_PATH}} deterministically (no model call). */
export const CR_REVIEWER_TEMPLATE = `ROLE: Independent senior code reviewer. You work ALONE. You have READ-ONLY
access to the repository at your working directory.

Review ONLY the changes in the diff at {{DIFF_PATH}} (context: repo root = your cwd). Investigate
surrounding code as needed before reporting.

Produce ONLY JSON:
- task_echo (≤2 sentences),
- findings: ≤12, each {id "F1"..., file, line_start, line_end, severity P0|P1|P2|P3,
  category CORRECTNESS|SECURITY|CONCURRENCY|ERROR_HANDLING|PERF|MAINTAINABILITY,
  claim, evidence "<the code/behavior that proves it>", suggested_fix, self_confidence 0-1}.
Rules: severity P0 = correctness/security/data-loss. No style nits below P2.
Every finding MUST cite a file and line range you verified exists (paths relative to the repo root). JSON only.`;

/** Timeline manifest (T8) for the code-review pipeline. S7 (map) is pure/deterministic (role null). */
export const CR_STAGES: StageInfo[] = [
  { id: 'S4', label: 'Parallel review', role: 's4' },
  { id: 'S8', label: 'Cross-exam', role: 's4' },
  { id: 'S7', label: 'Disagreement map', role: null },
  { id: 'S9', label: 'Judge adjudication', role: 'judge' },
  { id: 'S10', label: 'Report', role: null },
];

export async function runCodeReview(ctx: RunCtx, input: string): Promise<void> {
  // `input` is the unified diff. Persist it where the reviewer prompt points; parse the touched files.
  await ctx.writer.writeInput('diff.patch', input);
  const diffPath = resolve(ctx.writer.dir, 'inputs', 'diff.patch');
  const files = parseDiffFiles(input);

  // S1 (deterministic, NO call): a trivial contract, for artifact consistency + forensics.
  const contract: IntentContract = {
    task: 'Review the changes in the supplied diff.',
    task_type: 'code-review',
    constraints: [],
    unknowns: [],
    success_criteria: ['adjudicated findings on the diff, with derived confidence'],
  };
  await ctx.writer.writeJson('intent-contract', contract);

  // S3 (deterministic, NO call): fill the reviewer template's DIFF_PATH slot; persist for forensics.
  const prompt = CR_REVIEWER_TEMPLATE.replace('{{DIFF_PATH}}', diffPath);
  await ctx.writer.writePrompt('reviewer.md', prompt);

  const reviewers = await runStage(ctx, 'S4', () => s4Review(ctx, prompt, files));
  const cross = await runStage(ctx, 'S8', () => s8CrossExam(ctx, reviewers));

  // S7 — build + persist the ReviewMap (07), then the cross-exam verifications (08). Order: 07 < 08.
  const map = await runStage(ctx, 'S7', async () => {
    const m = buildReviewMap(reviewers, cross.byKey);
    await ctx.writer.writeJson('review-map', m);
    await ctx.writer.writeJson('verifications', { verifications: cross.verifications });
    return m;
  });

  const judge = await runStage(ctx, 'S9', () => s9ReviewJudge(ctx, map));
  await runStage(ctx, 'S10', () => s10ReviewRender(ctx, map, judge));
}
