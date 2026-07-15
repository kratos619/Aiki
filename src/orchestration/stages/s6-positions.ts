// S6 — preserve validated analyst submissions for graph compilation. No lexical merging: positions
// keep their original text and are grouped only by stable references in S7.

import type { ProviderSubmission } from '../decision-graph.js';
import type { RunCtx } from '../context.js';
import type { SeatOutput } from './s4-analyze.js';

export type PositionSet = ProviderSubmission[];

export function collectPositions(seats: SeatOutput[]): PositionSet {
  return seats.map((seat) => ({ provider: seat.provider, source_id: seat.sample ?? seat.provider, submission: seat.output }));
}

export async function s6Positions(ctx: RunCtx, seats: SeatOutput[]): Promise<PositionSet> {
  const positions = collectPositions(seats);
  await ctx.writer.writeJson('positions', positions);
  return positions;
}
