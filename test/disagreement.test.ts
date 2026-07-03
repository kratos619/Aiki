// §24 T6 acceptance: fixture-driven tests for S6 claim dedupe and the S7 disagreement map. These
// exercise the pure cores (`mergeClaims`, `buildDisagreementMap`) directly — no engine, no I/O.

import { describe, it, expect } from 'vitest';
import { mergeClaims } from '../src/orchestration/stages/s6-claims.js';
import { buildDisagreementMap, type RubricItem } from '../src/orchestration/stages/s7-disagreement.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';
import type { ProviderId } from '../src/providers/types.js';
import type { IdeaRoleOutput } from '../src/schemas/index.js';

function seat(provider: ProviderId, o: Partial<IdeaRoleOutput>): SeatOutput {
  return {
    provider,
    output: {
      workflow: 'idea-refinement',
      task_echo: o.task_echo ?? 'echo',
      strongest_version: o.strongest_version ?? 'strong',
      assumptions: o.assumptions ?? [],
      attacks: o.attacks ?? [],
      open_questions: o.open_questions ?? [],
    },
  };
}

describe('S6 mergeClaims (fuzzy dedupe ≥0.85)', () => {
  it('merges identical assumptions across providers, keeps distinct ones separate', () => {
    const same = { statement: 'the target user is a solo developer working locally', type: 'JUDGMENT' as const, load_bearing: true };
    const set = mergeClaims([
      seat('agy', {
        assumptions: [
          { id: 'A1', ...same },
          { id: 'A2', statement: 'the target user is an enterprise team', type: 'JUDGMENT', load_bearing: false },
        ],
      }),
      seat('codex', { assumptions: [{ id: 'A1', ...same }] }), // identical → merges with agy's C1
    ]);

    expect(set.claims).toHaveLength(2);
    expect(set.claims[0]!.providers).toEqual(['agy', 'codex']); // merged attribution
    expect(set.claims[1]!.providers).toEqual(['agy']); // 0.33 overlap < 0.85 → stays separate
  });

  it('does not double-count a provider that repeats a claim (self-consistency resample)', () => {
    const same = { statement: 'installed clis expose stable machine readable output', type: 'VERIFIABLE' as const, load_bearing: true };
    const set = mergeClaims([
      seat('agy', { assumptions: [{ id: 'A1', ...same }] }),
      seat('agy', { assumptions: [{ id: 'A1', ...same }] }), // same provider twice
    ]);
    expect(set.claims).toHaveLength(1);
    expect(set.claims[0]!.providers).toEqual(['agy']); // deduped, not ['agy','agy']
  });

  it('re-anchors attacks from per-seat assumption ids onto merged claim ids; drops unanchored', () => {
    const set = mergeClaims([
      seat('agy', {
        assumptions: [{ id: 'A1', statement: 'clis expose stable machine readable output', type: 'VERIFIABLE', load_bearing: true }],
        attacks: [
          { id: 'X1', target_assumption: 'A1', argument: 'formats drift between versions', severity: 'MED' },
          { id: 'X2', target_assumption: 'A9', argument: 'targets a phantom assumption', severity: 'LOW' }, // unanchored → dropped
        ],
      }),
    ]);
    expect(set.attacks).toHaveLength(1);
    expect(set.attacks[0]).toMatchObject({ provider: 'agy', claim_id: 'C1', severity: 'MED' });
  });
});

describe('S7 buildDisagreementMap', () => {
  const rubric: RubricItem[] = [
    { id: 'R1', label: 'monetization', keywords: ['pay', 'revenue'] },
    { id: 'R2', label: 'kill criteria', keywords: ['kill criteria', 'abandon'] },
  ];

  it('splits consensus/unique, records contradictions from attacks, and finds blind spots', () => {
    const set = mergeClaims([
      seat('agy', {
        assumptions: [
          { id: 'A1', statement: 'developers want local multi model orchestration', type: 'JUDGMENT', load_bearing: true },
          { id: 'A2', statement: 'clis expose stable machine readable output', type: 'VERIFIABLE', load_bearing: true },
        ],
        attacks: [{ id: 'X1', target_assumption: 'A2', argument: 'output formats drift between versions', severity: 'MED' }],
      }),
      seat('codex', {
        assumptions: [
          { id: 'A1', statement: 'developers want local multi model orchestration', type: 'JUDGMENT', load_bearing: true }, // → merges to C1
          { id: 'B1', statement: 'users will pay for this tool', type: 'JUDGMENT', load_bearing: false }, // unique
        ],
      }),
    ]);
    const map = buildDisagreementMap(set, [], rubric);

    expect(map.consensus.map((c) => c.id)).toEqual(['C1']); // asserted by both
    expect(map.unique.map((c) => c.id)).toEqual(['C2', 'C3']); // C2 (agy A2), C3 (codex B1)
    expect(map.contradictions).toHaveLength(1);
    expect(map.contradictions[0]).toMatchObject({ id: 'D1', claim_ids: ['C2'] });
    expect(map.contradictions[0]!.attacks).toHaveLength(1);
  });

  it('finds blind spots from a corpus over the analysts’ text', () => {
    const seats = [seat('agy', { strongest_version: 'users will pay a subscription', assumptions: [] })];
    const map = buildDisagreementMap({ claims: [], attacks: [] }, seats, rubric);
    // 'pay' present → R1 covered; 'kill criteria'/'abandon' absent → R2 is a blind spot.
    expect(map.blind_spots).toEqual(['kill criteria']);
  });

  it('empty contradictions is legal (an empty attack set yields none)', () => {
    const set = mergeClaims([seat('agy', { assumptions: [{ id: 'A1', statement: 's one two three', type: 'JUDGMENT', load_bearing: true }] })]);
    const map = buildDisagreementMap(set, [], []);
    expect(map.contradictions).toEqual([]);
  });
});
