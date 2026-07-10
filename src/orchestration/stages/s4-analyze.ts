// S4 — parallel fan-out (§9, §12.1). The engine's expensive step: each analyst seat independently
// runs the S3-filled analyst prompt (blind — a seat never sees another seat's output) and returns a
// validated RoleOutput. A seat that fails is dropped (its single adapter-level retry already
// happened); quorum then decides the run: ≥2 survivors → continue; exactly 1 → self-consistency
// completion (resample the survivor once so downstream still has two samples to compare, run flagged
// `low_diversity`); 0 → run-fatal QUORUM abort. A run-fatal error raised inside the fan-out
// (budget/deadline/abort) propagates unchanged.
//
// Discriminator injection (§13): the model returns JSON with NO `workflow` field. We validate the
// call against `IdeaRoleOutputModel` (that exact shape), then inject `workflow` and persist via
// `writeRoleOutput`, which re-validates the full `RoleOutput`.

import type { ProviderId } from '../../providers/types.js';
import type { IdeaRoleOutput } from '../../schemas/index.js';
import { IdeaRoleOutputModel } from '../../schemas/index.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

/** One surviving S4 seat: the validated analyst output plus which provider produced it. */
export interface SeatOutput {
  provider: ProviderId;
  sample?: string;
  output: IdeaRoleOutput;
}

/** Run one analyst seat → validated `RoleOutput`, persisted to 04-role-outputs/<label>.json.
 *  `label` doubles as the artifact filename, so a resample uses a distinct label. */
async function runSeat(ctx: RunCtx, seat: ProviderId, label: string, prompt: string): Promise<SeatOutput> {
  const model = await jsonCall(ctx, ctx.handle(seat), `S4-${label}`, prompt, IdeaRoleOutputModel);
  const output: IdeaRoleOutput = { workflow: 'idea-refinement', ...model };
  await ctx.writer.writeRoleOutput(label, output);
  return { provider: seat, sample: label, output };
}

export async function s4Analyze(ctx: RunCtx, analystPrompt: string): Promise<SeatOutput[]> {
  const seats = ctx.roles.s4;
  const settled = await Promise.allSettled(seats.map((seat) => runSeat(ctx, seat, seat, analystPrompt)));

  const survivors: SeatOutput[] = [];
  const dropped: Array<{ provider: ProviderId; error: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    const seat = seats[i]!;
    if (r.status === 'fulfilled') survivors.push(r.value);
    else if (isFatal(r.reason)) throw r.reason; // budget/deadline/abort → abort the whole run
    else dropped.push({ provider: seat, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  }

  if (survivors.length >= 2) return survivors;

  // Exactly one seat survived → self-consistency completion (§9 S4): resample the survivor once for
  // a second independent sample, so S5–S7 still have ≥2 outputs. Flag the reduced diversity. If the
  // resample also fails it throws (fatal propagates; otherwise a StageError) → the run fails.
  if (survivors.length === 1) {
    const only = survivors[0]!;
    ctx.addFlag('low_diversity');
    const resample = await runSeat(ctx, only.provider, `${only.provider}-2`, analystPrompt);
    return [only, resample];
  }

  throw new StageError(
    'S4',
    'QUORUM',
    `no analyst seats survived (dropped: ${dropped.map((d) => `${d.provider}:${d.error}`).join('; ')})`,
  );
}
