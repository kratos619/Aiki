// `aiki bench <workflow> [--arms A,B,C,D] [--set build] [--resume] [--yes]` (§5, §17, §19) — run the
// benchmark arms on a task set, write bench/results/<suite>-<date>.json, print the per-arm summary table.
// Without --yes it prints a pre-run Opus-call estimate and exits (so a big sweep never silently drains the
// quota). --resume continues the latest results file, keeping already-scored case×arm pairs.

import { planBench, renderTable, runBench, type BenchPlan } from '../bench/harness.js';
import type { ArmId } from '../bench/arms.js';
import { setupProviders } from '../orchestration/context.js';
import { chooseLaneDefault, planIdeaLaneBench, runIdeaLaneBench } from '../bench/idea-lane-rotation.js';

const VALID_ARMS: ArmId[] = ['A', 'B', 'C', 'D', 'E', 'L'];

/** One-block pre-run summary: what will run + the ≈Opus cost, so the user commits knowingly (§19). */
function renderPlan(plan: BenchPlan): string {
  const L: string[] = [`bench ${plan.suite} — set ${plan.set} — ${plan.cases.length} case(s) × arms ${plan.arms.join(',')}`];
  if (plan.resumedFrom) L.push(`resume: continuing ${plan.resumedFrom} — ${plan.skipCompleted} case×arm already scored (kept)`);
  const unavail = plan.skipUnavailable ? ` · ${plan.skipUnavailable} skipped (provider unavailable)` : '';
  L.push(`to run: ${plan.toRun.length} case×arm pair(s) → ≈${plan.estClaudeCalls} claude/Opus call(s)${unavail}`);
  return L.join('\n');
}

export async function benchCommand(
  workflow: string,
  opts: { arms?: string; set?: string; resume?: boolean; yes?: boolean } = {},
): Promise<number> {
  if (workflow === 'idea-refinement') {
    if (opts.set && opts.set !== 'build') {
      process.stderr.write('idea lane rotation is build-set-only; holdout remains sealed\n');
      return 1;
    }
    const handles = await setupProviders();
    const plan = await planIdeaLaneBench({ handles });
    if (plan.cases.length === 0) {
      process.stderr.write('no cases found in bench/sets/idea-refinement/build/\n');
      return 1;
    }
    process.stdout.write(`\nidea lane rotation — ${plan.cases.length} case(s) × 2 assignments\n`);
    process.stdout.write(`to run: ${plan.runs.length} council run(s) → ≈${plan.estimatedCalls} provider call(s)\n`);
    if (!opts.yes) {
      process.stdout.write('\nRe-run with --yes to execute. Paid calls are never started by this dry-run.\n\n');
      return 0;
    }
    const result = await runIdeaLaneBench({ handles });
    const selected = chooseLaneDefault(result.observations);
    process.stdout.write(`\nresults: ${result.path}\n`);
    process.stdout.write(selected
      ? `default lane assignment: ${selected}\n\n`
      : 'default remains provisional — blind-score recall/evidence precision before selection.\n\n');
    return 0;
  }
  if (workflow !== 'code-review') {
    process.stderr.write(`bench supports "code-review" or "idea-refinement" (got "${workflow}")\n`);
    return 1;
  }
  const arms = (opts.arms ?? 'A,B,C,D')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((a): a is ArmId => (VALID_ARMS as string[]).includes(a));
  if (arms.length === 0) {
    process.stderr.write(`no valid arms in "${opts.arms}". Valid: A,B,C,D,E,L\n`);
    return 1;
  }
  const set = opts.set ?? 'build';
  const handles = await setupProviders(); // detection only (no model calls); shared by plan + run

  const plan = await planBench({ suite: 'code-review', set, arms, resume: opts.resume, handles });
  if (plan.cases.length === 0) {
    process.stderr.write(`no cases found in bench/sets/code-review/${set}/ — create <name>/{diff.patch,bugs.json} case dirs first\n`);
    return 1;
  }

  process.stdout.write(`\n${renderPlan(plan)}\n`);
  if (plan.toRun.length === 0) {
    process.stdout.write(`\nnothing to run — every requested arm is already scored on every case.\n\n`);
    return 0;
  }
  if (!opts.yes) {
    const resumeHint = opts.resume ? '' : ' (add --resume to continue a partial run across quota windows)';
    process.stdout.write(`\nThis makes ≈${plan.estClaudeCalls} claude/Opus call(s). Re-run with --yes to execute${resumeHint}.\n\n`);
    return 0;
  }

  const result = await runBench({ suite: 'code-review', set, arms, resume: opts.resume, handles });
  process.stdout.write(`\n${renderTable(result)}\n\n  results: ${plan.resultsPath}\n\n`);
  return 0;
}
