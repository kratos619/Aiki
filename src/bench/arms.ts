// Benchmark arms A–D for code-review (§17, BENCHMARK.md §1, T11). Each arm is an engine composition:
// the harness runs it via `executeRun` (→ a full .aiki/runs record) and it returns its final Finding[]
// for scoring. A/B are single claude calls (the baselines); C is claude sampled 3× + self-consistency
// synthesis; D is the full cross-provider pipeline. A/B/C use claude (the fixed "single best model").

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RunCtx } from '../orchestration/context.js';
import type { ProviderId } from '../providers/types.js';
import { CodeReviewRoleOutputModel, type Finding, type ReviewMap } from '../schemas/index.js';
import { jsonCall } from '../orchestration/jsonStage.js';
import { parseDiffFiles } from '../orchestration/git.js';
import { countLines, filterValidFindings } from '../orchestration/stages/cr-s4-review.js';
import { sameFinding } from '../orchestration/stages/cr-map.js';
import { s9ReviewJudge } from '../orchestration/stages/cr-s9-judge.js';
import { scoreFindings } from '../orchestration/stages/cr-report.js';
import { runCodeReview } from '../workflows/code-review.js';

export type ArmId = 'A' | 'B' | 'C' | 'D';
export const ARM_IDS: ArmId[] = ['A', 'B', 'C', 'D'];
export type ArmFn = (ctx: RunCtx, diff: string) => Promise<Finding[]>;

const SCHEMA_LINE =
  'findings: [{id "F1"..., file, line_start, line_end, severity P0|P1|P2|P3, category CORRECTNESS|SECURITY|CONCURRENCY|ERROR_HANDLING|PERF|MAINTAINABILITY, claim, evidence, suggested_fix, self_confidence 0-1}]';

const A_PROMPT = `Review this code diff and report the bugs you find. The diff is at {{DIFF_PATH}} (repo root = your cwd).
Output ONLY JSON: {task_echo (≤2 sentences), ${SCHEMA_LINE}}. JSON only.`;

// Arm B — the real opponent: a single strong structured-adversarial prompt (analyze → self-attack → re-answer).
const B_PROMPT = `You are a rigorous senior code reviewer. Review the diff at {{DIFF_PATH}} (repo root = your cwd) in three
internal passes, then output ONLY the final JSON — do not show your working:
1. ANALYZE: list every plausible defect (correctness, security, concurrency, error handling, performance).
2. SELF-ATTACK: for each candidate, argue the strongest case that it is a FALSE POSITIVE; discard the ones that don't survive.
3. RE-ANSWER: report only the surviving, defensible findings, each citing a file:line you verified exists.
Output ONLY JSON: {task_echo (≤2 sentences), ${SCHEMA_LINE}}. severity P0 = correctness/security/data-loss. JSON only.`;

/** Persist the diff + filled prompt, and return the reviewer-facing artifacts a single call needs. */
async function setup(ctx: RunCtx, diff: string, template: string): Promise<{ prompt: string; files: string[]; diffSet: Set<string>; lineCounts: Map<string, number> }> {
  await ctx.writer.writeInput('diff.patch', diff);
  const files = parseDiffFiles(diff);
  const prompt = template.replace('{{DIFF_PATH}}', resolve(ctx.writer.dir, 'inputs', 'diff.patch'));
  await ctx.writer.writePrompt('reviewer.md', prompt);
  return { prompt, files, diffSet: new Set(files), lineCounts: await countLines(ctx.cwd, files) };
}

/** A/B — one claude call, file:line-validated. `label` names the stage + role-output artifact. */
async function singleCallArm(ctx: RunCtx, diff: string, template: string, label: string): Promise<Finding[]> {
  const { prompt, diffSet, lineCounts } = await setup(ctx, diff, template);
  const model = await jsonCall(ctx, ctx.handle('claude'), label, prompt, CodeReviewRoleOutputModel);
  await ctx.writer.writeRoleOutput('claude', { workflow: 'code-review', ...model });
  return filterValidFindings(model.findings, diffSet, lineCounts).valid;
}

export const armA: ArmFn = (ctx, diff) => singleCallArm(ctx, diff, A_PROMPT, 'A');
export const armB: ArmFn = (ctx, diff) => singleCallArm(ctx, diff, B_PROMPT, 'B');

/** Cluster findings across samples by the §487 matcher. Support = how many samples raised it. */
function mergeSamples(samples: Finding[][]): ReviewMap {
  const clusters: { rep: Finding; support: number }[] = [];
  const rank: Record<Finding['severity'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  for (const sample of samples) {
    const claimed = new Set<{ rep: Finding; support: number }>();
    for (const f of sample) {
      const c = clusters.find((cl) => !claimed.has(cl) && sameFinding(cl.rep, f));
      if (c) {
        claimed.add(c);
        c.support += 1;
        if (rank[f.severity] < rank[c.rep.severity]) c.rep = f; // keep highest severity
      } else {
        const nc = { rep: f, support: 1 };
        clusters.push(nc);
        claimed.add(nc);
      }
    }
  }
  // ≥2 samples → self-consistent consensus; exactly 1 → disputed (the judge decides keep/drop).
  const claude: ProviderId[] = ['claude'];
  const consensus = clusters.filter((c) => c.support >= 2).map((c) => ({ finding: c.rep, reviewers: [...claude], cross_verdict: 'NONE' as const }));
  const disputed = clusters.filter((c) => c.support === 1).map((c) => ({ finding: c.rep, reviewers: [...claude], cross_verdict: 'REFUTE' as const, refutation: 'appeared in only 1 of 3 samples' }));
  let n = 0;
  const reindex = <T extends { finding: Finding }>(arr: T[]): T[] => arr.map((a) => ({ ...a, finding: { ...a.finding, id: `G${++n}` } }));
  return {
    consensus: reindex(consensus),
    disputed: reindex(disputed),
    single_reviewer: [],
    per_reviewer: [{ provider: 'claude', raised: samples.reduce((s, x) => s + x.length, 0), kept: clusters.length, dropped: 0 }],
  };
}

/** Arm C — claude sampled 3× (sample-keyed self-consistency) + the code-review judge on singletons. */
export const armC: ArmFn = async (ctx, diff) => {
  const { prompt, diffSet, lineCounts } = await setup(ctx, diff, B_PROMPT);
  const samples: Finding[][] = [];
  for (let i = 0; i < 3; i++) {
    const model = await jsonCall(ctx, ctx.handle('claude'), `C-s${i + 1}`, prompt, CodeReviewRoleOutputModel);
    await ctx.writer.writeRoleOutput(`sample-${i + 1}`, { workflow: 'code-review', ...model });
    samples.push(filterValidFindings(model.findings, diffSet, lineCounts).valid);
  }
  const map = mergeSamples(samples);
  await ctx.writer.writeJson('review-map', map);
  const judge = await s9ReviewJudge(ctx, map); // ctx.roles.judge = claude for arm C (harness sets it)
  return scoreFindings(map, judge).filter((s) => s.disposition === 'kept').map((s) => s.finding);
};

/** Arm D — the full product pipeline. Read back its kept findings for scoring. */
export const armD: ArmFn = async (ctx, diff) => {
  await runCodeReview(ctx, diff);
  const [map, judge] = await Promise.all([
    readFile(resolve(ctx.writer.dir, '07-review-map.json'), 'utf8').then(JSON.parse),
    readFile(resolve(ctx.writer.dir, '09-judge-report.json'), 'utf8').then(JSON.parse),
  ]);
  return scoreFindings(map, judge).filter((s) => s.disposition === 'kept').map((s) => s.finding);
};

export const ARMS: Record<ArmId, ArmFn> = { A: armA, B: armB, C: armC, D: armD };
