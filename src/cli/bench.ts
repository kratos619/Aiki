// `aiki bench <workflow> [--arms A,B,C,D] [--set build]` (§5, §17) — run the benchmark arms on a task
// set, write bench/results/<suite>-<date>.json, print the per-arm summary table.

import { renderTable, runBench } from '../bench/harness.js';
import type { ArmId } from '../bench/arms.js';

const VALID_ARMS: ArmId[] = ['A', 'B', 'C', 'D'];

export async function benchCommand(workflow: string, opts: { arms?: string; set?: string } = {}): Promise<number> {
  if (workflow !== 'code-review') {
    process.stderr.write(`bench supports only "code-review" in v1 (got "${workflow}")\n`);
    return 1;
  }
  const arms = (opts.arms ?? 'A,B,C,D')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((a): a is ArmId => (VALID_ARMS as string[]).includes(a));
  if (arms.length === 0) {
    process.stderr.write(`no valid arms in "${opts.arms}". Valid: A,B,C,D\n`);
    return 1;
  }
  const set = opts.set ?? 'build';

  const result = await runBench({ suite: 'code-review', set, arms });
  if (result.cases.length === 0) {
    process.stderr.write(`no cases found in bench/sets/code-review/${set}/ — create <name>/{diff.patch,bugs.json} case dirs first\n`);
    return 1;
  }
  process.stdout.write(`\n${renderTable(result)}\n\n  results: bench/results/code-review-${result.at.slice(0, 10)}.json\n\n`);
  return 0;
}
