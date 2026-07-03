// S6 — claim extraction (§9, §12.1). Deterministic. Each analyst's assumptions are already
// claim-shaped ({statement, type: VERIFIABLE|JUDGMENT}); this stage normalizes them into stable
// `Claim`s and fuzzy-dedupes across analysts (token-set overlap ≥ CLAIM_DEDUPE_THRESHOLD → one
// merged claim carrying multi-provider attribution). It also carries each analyst's attacks
// forward, re-anchored from per-seat assumption ids onto the merged claim ids, so S7 can build the
// disagreement map from a single structure. No model call.

import type { ProviderId } from '../../providers/types.js';
import type { Claim } from '../../schemas/index.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';

/** Two assumption statements with Jaccard token overlap ≥ this are the same claim (§9 "≥0.85").
 *  Strict by design (near-duplicate merge only); genuine paraphrases rarely reach it, so most claims
 *  stay per-provider. Tunable (same footnote class as the S2 clustering threshold). */
export const CLAIM_DEDUPE_THRESHOLD = 0.85;

/** An attack re-anchored from its author's per-seat assumption id onto the merged claim id (S6→S7). */
export interface ClaimAttack {
  provider: ProviderId;
  claim_id: string; // the merged claim this attack targets
  argument: string;
  severity: 'HIGH' | 'MED' | 'LOW';
}

/** S6 composite artifact (06-claims.json, §15). No T4 core schema — written as-is (like the 02
 *  guard); shaped here. `claims` are the merged assumptions; `attacks` are the disagreement signal. */
export interface ClaimSet {
  claims: Claim[];
  attacks: ClaimAttack[];
}

/** Pure dedupe/merge core (no ctx, no I/O) — the fixture-testable heart of S6 (§24 T6). */
export function mergeClaims(seats: SeatOutput[]): ClaimSet {
  // Working claims carry a token set for dedupe comparison; stripped before persisting.
  const working: Array<Claim & { tokens: Set<string> }> = [];
  // Per seat: that seat's own assumption id → the merged claim id it landed in (to re-anchor attacks).
  const seatMaps: Array<Map<string, string>> = [];

  for (const seat of seats) {
    const map = new Map<string, string>();
    for (const a of seat.output.assumptions) {
      const tokens = tokenize(a.statement);
      const hit = working.find((c) => overlap(c.tokens, tokens) >= CLAIM_DEDUPE_THRESHOLD);
      if (hit) {
        // Merge: add attribution (dedupe — a self-consistency resample repeats the same provider).
        if (!hit.providers.includes(seat.provider)) hit.providers.push(seat.provider);
        map.set(a.id, hit.id);
      } else {
        const id = `C${working.length + 1}`;
        working.push({ id, statement: a.statement, type: a.type, providers: [seat.provider], tokens });
        map.set(a.id, id);
      }
    }
    seatMaps.push(map);
  }

  // Re-anchor attacks onto merged claim ids. An attack's `target_assumption` is a per-seat id;
  // resolve it via that seat's map. Attacks whose target didn't resolve (analyst referenced a
  // phantom id) are dropped — the same discipline the S4 template warns of ("unanchored discarded").
  const attacks: ClaimAttack[] = [];
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i]!;
    const map = seatMaps[i]!;
    for (const atk of seat.output.attacks) {
      const claim_id = map.get(atk.target_assumption);
      if (claim_id) attacks.push({ provider: seat.provider, claim_id, argument: atk.argument, severity: atk.severity });
    }
  }

  return { claims: working.map(({ tokens, ...c }) => c), attacks };
}

export async function s6Claims(ctx: RunCtx, seats: SeatOutput[]): Promise<ClaimSet> {
  const claimSet = mergeClaims(seats);
  await ctx.writer.writeJson('claims', claimSet);
  return claimSet;
}
