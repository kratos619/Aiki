// S6 — preserve validated analyst submissions for graph compilation. No lexical merging: positions
// keep their original text and are grouped only by stable references in S7.

import type { ProviderSubmission } from '../decision-graph.js';
import type { RunCtx } from '../context.js';
import type { SeatOutput } from './s4-analyze.js';

export type PositionSet = ProviderSubmission[];

/** A surviving scout seat with little output or evidence is weak. ponytail: thresholds are blunt on
 * purpose; raise them only with benchmark evidence. */
export function detectWeakSeat(positions: Array<{ id: string; evidence_ids?: string[] }>, mode: string): string[] {
  if (mode === 'quick') return [];
  const seats = new Map<string, { positions: number; evidenced: number }>();
  for (const position of positions) {
    const provider = position.id.split('/')[0]!.replace(/-coverage-fill$/, '');
    const seat = seats.get(provider) ?? { positions: 0, evidenced: 0 };
    seat.positions += 1;
    if (position.evidence_ids?.length) seat.evidenced += 1;
    seats.set(provider, seat);
  }
  if (seats.size < 2) return [];
  return [...seats].filter(([, seat]) => seat.positions < 3 || seat.evidenced / seat.positions < 0.5).map(([provider]) => provider);
}

export function collectPositions(seats: SeatOutput[]): PositionSet {
  return seats.map((seat) => ({ provider: seat.provider, source_id: seat.sample ?? seat.provider, submission: seat.output }));
}

export async function s6Positions(ctx: RunCtx, seats: SeatOutput[]): Promise<PositionSet> {
  const positions = collectPositions(seats);
  await ctx.writer.writeJson('positions', positions);
  return positions;
}
