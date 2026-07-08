// §24 T7 acceptance: pure cores of the synthesis stages — S7 semantic-group merge, the S9
// anti-blending validator (the "rejects consensus edits" guard), and the S10 code-derived audit.

import { describe, it, expect } from 'vitest';
import { applyGroups } from '../src/orchestration/stages/s7-disagreement.js';
import { adjudicationScopeViolations, demoteSelfAuthored, recommendationIssues } from '../src/orchestration/stages/s9-judge.js';
import { deriveAudit, deriveScorecard } from '../src/orchestration/stages/s10-render.js';
import type { ClaimSet } from '../src/orchestration/stages/s6-claims.js';
import type { DisagreementMap, JudgeReport } from '../src/schemas/index.js';

describe('S7 applyGroups (semantic merge by validated id groups)', () => {
  const cs = (): ClaimSet => ({
    claims: [
      { id: 'C1', statement: 'developers want local orchestration', type: 'JUDGMENT', providers: ['agy'] },
      { id: 'C2', statement: 'devs want a local orchestration tool', type: 'JUDGMENT', providers: ['codex'] },
      { id: 'C3', statement: 'clis expose stable output', type: 'VERIFIABLE', providers: ['agy'] },
    ],
    attacks: [{ provider: 'codex', claim_id: 'C2', argument: 'unproven', severity: 'MED' }],
  });

  it('merges a group into its lowest-id member, unions providers, re-anchors attacks', () => {
    const out = applyGroups(cs(), [['C2', 'C1']]); // canonical = C1 (lowest), even if listed second
    expect(out.claims.map((c) => c.id)).toEqual(['C1', 'C3']);
    expect(out.claims[0]!.providers).toEqual(['agy', 'codex']); // C1 → consensus
    expect(out.claims[0]!.statement).toBe('developers want local orchestration'); // canonical kept verbatim
    expect(out.attacks[0]!.claim_id).toBe('C1'); // C2's attack re-anchored onto C1
  });

  it('ignores groups with unknown or <2 valid ids (defensive, by-reference)', () => {
    const out = applyGroups(cs(), [['C1', 'C9']]); // C9 doesn't exist → group drops below 2 → no-op
    expect(out.claims.map((c) => c.id)).toEqual(['C1', 'C2', 'C3']);
  });

  it('does not mutate its input', () => {
    const input = cs();
    applyGroups(input, [['C1', 'C2']]);
    expect(input.claims[0]!.providers).toEqual(['agy']); // original untouched
  });
});

describe('S9 adjudicationScopeViolations (anti-blending — §602 acceptance)', () => {
  it('REJECTS a judge output that adjudicates a consensus id (not a dispute)', () => {
    const report = { adjudications: [{ id: 'D1' }, { id: 'C5' }] }; // C5 is a consensus claim, off-limits
    expect(adjudicationScopeViolations(report, ['D1', 'D2'])).toEqual(['C5']);
  });

  it('accepts a judge output that references only disputed ids', () => {
    const report = { adjudications: [{ id: 'D1' }, { id: 'D2' }] };
    expect(adjudicationScopeViolations(report, ['D1', 'D2'])).toEqual([]);
  });
});

describe('S9 demoteSelfAuthored (§272 2-provider judge-as-author guard)', () => {
  const map: DisagreementMap = {
    consensus: [],
    unique: [
      { id: 'C1', statement: 'authored by the judge only', type: 'JUDGMENT', providers: ['agy'] },
      { id: 'C2', statement: 'authored by the other provider', type: 'JUDGMENT', providers: ['codex'] },
    ],
    contradictions: [
      { id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'codex', argument: 'x', severity: 'HIGH' }] },
      { id: 'D2', claim_ids: ['C2'], attacks: [{ provider: 'agy', argument: 'y', severity: 'HIGH' }] },
    ],
    blind_spots: [],
  };
  const adjs = [
    { id: 'D1', ruling: 'REJECT' as const, reasoning: 'r', evidence_cited: 'e' },
    { id: 'D2', ruling: 'UPHOLD' as const, reasoning: 'r', evidence_cited: 'e' },
  ];

  it('forces UNRESOLVED on a dispute over the judge’s own claim; leaves others alone (judge=agy)', () => {
    const out = demoteSelfAuthored(adjs, map, 'agy');
    expect(out.find((a) => a.id === 'D1')!.ruling).toBe('UNRESOLVED'); // C1 is agy-only → judge can't confirm
    expect(out.find((a) => a.id === 'D2')!.ruling).toBe('UPHOLD'); // C2 is codex's → untouched
  });

  it('is a no-op when the judge authored nothing (3-provider, judge=claude)', () => {
    expect(demoteSelfAuthored(adjs, map, 'claude')).toEqual(adjs);
  });
});

describe('S9 recommendationIssues', () => {
  it('requires a recommendation and conditions only for proceed-with-conditions', () => {
    expect(recommendationIssues({})).toContain('recommendation is required');
    expect(recommendationIssues({ recommendation: 'PROCEED_WITH_CONDITIONS' })).toContain('conditions are required for PROCEED_WITH_CONDITIONS');
    expect(recommendationIssues({ recommendation: 'STOP', conditions: ['check'] })).toContain('conditions are only valid with PROCEED_WITH_CONDITIONS');
    expect(recommendationIssues({ recommendation: 'PROCEED_WITH_CONDITIONS', conditions: ['check'] })).toEqual([]);
  });
});

describe('S10 deriveAudit (code-derived held/failed/unverified + confidence)', () => {
  const map: DisagreementMap = {
    consensus: [{ id: 'C1', statement: 'consensus claim', type: 'JUDGMENT', providers: ['agy', 'codex'] }],
    unique: [
      { id: 'C2', statement: 'contested single-provider claim', type: 'VERIFIABLE', providers: ['agy'] },
      { id: 'C3', statement: 'quiet single-provider claim', type: 'JUDGMENT', providers: ['codex'] },
    ],
    contradictions: [{ id: 'D1', claim_ids: ['C2'], attacks: [{ provider: 'agy', argument: 'x', severity: 'HIGH' }] }],
    blind_spots: [],
  };
  const judge = (ruling: 'UPHOLD' | 'REJECT' | 'UNRESOLVED'): JudgeReport => ({
    adjudications: [{ id: 'D1', ruling, reasoning: 'r', evidence_cited: 'e' }],
    verdict: 'v',
    dissent: ['d'],
    confidence_notes: 'n',
  });

  it('consensus+undisputed → held/HIGH; single-provider+undisputed → held/MEDIUM', () => {
    const audit = deriveAudit(map, judge('UPHOLD'));
    expect(audit.find((r) => r.id === 'C1')).toMatchObject({ status: 'held', confidence: 'HIGH' });
    expect(audit.find((r) => r.id === 'C3')).toMatchObject({ status: 'held', confidence: 'MEDIUM' });
  });

  it('contested claim: UPHOLD→failed/LOW, REJECT→held/MEDIUM, UNRESOLVED→unverified/LOW', () => {
    expect(deriveAudit(map, judge('UPHOLD')).find((r) => r.id === 'C2')).toMatchObject({ status: 'failed', confidence: 'LOW' });
    expect(deriveAudit(map, judge('REJECT')).find((r) => r.id === 'C2')).toMatchObject({ status: 'held', confidence: 'MEDIUM' });
    expect(deriveAudit(map, judge('UNRESOLVED')).find((r) => r.id === 'C2')).toMatchObject({ status: 'unverified', confidence: 'LOW' });
  });
});

describe('S10 deriveScorecard (best-effort 3-state rubric coverage)', () => {
  const map: DisagreementMap = {
    consensus: [{ id: 'C1', statement: 'users will pay for the workflow', type: 'JUDGMENT', providers: ['agy', 'codex'] }],
    unique: [{ id: 'C2', statement: 'pricing risk may block adoption', type: 'JUDGMENT', providers: ['agy'] }],
    contradictions: [{ id: 'D1', claim_ids: ['C2'], attacks: [{ provider: 'codex', argument: 'unproven', severity: 'HIGH' }] }],
    blind_spots: ['legal risk'],
  };
  const rubric = [
    { id: 'R1', label: 'pricing', keywords: ['pricing'] },
    { id: 'R2', label: 'target user', keywords: ['target user'] },
    { id: 'R3', label: 'legal risk', keywords: ['legal'] },
  ];

  it('labels contested, examined, and unexamined without throwing', () => {
    expect(deriveScorecard(rubric, map)).toEqual([
      { id: 'R1', label: 'pricing', status: 'contested' },
      { id: 'R2', label: 'target user', status: 'examined' },
      { id: 'R3', label: 'legal risk', status: 'unexamined' },
    ]);
  });
});
