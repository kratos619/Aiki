// S5 — drift detection (§9, §12.1). Deterministic gate: does each S4 output still address the
// contract's task? Two code checks (no model call — the §601/§532 T6 "deterministic core"; the §9
// "verifier spot-check" is deferred): (1) the output produced ≥1 position (an analyst that
// produced none did not engage the task), and (2) its `task_echo` is similar enough to the contract
// task (overlap coefficient ≥ DRIFT_MIN_SIMILARITY). Drifted outputs are excluded from everything
// downstream and logged; if exclusion drops the survivor count below quorum (2), the run aborts.

import type { ProviderId } from '../../providers/types.js';
import type { IntentContract } from '../../schemas/index.js';
import { StageError, type RunCtx } from '../context.js';
import { overlapCoefficient, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';

/** `task_echo` must share ≥ this fraction of its tokens with the contract task to count as on-task.
 *  Overlap coefficient (not Jaccard) so a short echo is not penalized against a longer contract
 *  paragraph. Lenient by design — this catches an analyst that wandered off-task, not paraphrase
 *  distance. Tunable (same footnote class as the S2 clustering threshold). */
export const DRIFT_MIN_SIMILARITY = 0.3;

export interface DriftEntry {
  provider: ProviderId;
  on_task: boolean;
  similarity: number;
  evidence: string;
}

/** S5 composite artifact (05-drift-report.json, §15). No T4 core schema — written as-is (like the
 *  02 guard); shaped here. */
export interface DriftReport {
  entries: DriftEntry[];
  excluded: ProviderId[];
}

export async function s5Drift(
  ctx: RunCtx,
  contract: IntentContract,
  seats: SeatOutput[],
): Promise<{ report: DriftReport; kept: SeatOutput[] }> {
  const taskTokens = tokenize(contract.task);
  const entries: DriftEntry[] = [];
  const kept: SeatOutput[] = [];
  const excluded: ProviderId[] = [];

  for (const seat of seats) {
    const sim = overlapCoefficient(tokenize(seat.output.task_echo), taskTokens);
    const hasPositions = seat.output.positions.length > 0;
    const on_task = hasPositions && sim >= DRIFT_MIN_SIMILARITY;
    const evidence = !hasPositions
      ? 'no positions produced'
      : on_task
        ? `task_echo overlap ${sim.toFixed(2)} ≥ ${DRIFT_MIN_SIMILARITY}; ${seat.output.positions.length} position(s)`
        : `task_echo overlap ${sim.toFixed(2)} < ${DRIFT_MIN_SIMILARITY} (off-task)`;
    entries.push({ provider: seat.provider, on_task, similarity: Number(sim.toFixed(3)), evidence });
    if (on_task) kept.push(seat);
    else excluded.push(seat.provider);
  }

  const report: DriftReport = { entries, excluded };
  await ctx.writer.writeJson('drift-report', report);

  if (kept.length < 2) {
    throw new StageError('S5', 'QUORUM', `drift exclusion left ${kept.length} on-task output(s); need ≥2`);
  }
  return { report, kept };
}
