import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { sanitizeClaimGroups, overlayClaimGroups } from '../src/orchestration/claim-groups.js';
import { buildVerifierPrompt } from '../src/orchestration/stages/s8-verify.js';
import { ClaimVerificationSet } from '../src/schemas/index.js';
import type { DecisionGraph } from '../src/orchestration/decision-graph.js';

// T5 (plan/AIKI-v6-council-integrity-plan.md): run f740's codex G3 ("select `aiki serve`") and
// agy G13 (serve feasibility) said the same thing and rendered as two orphan UNIQUE claims —
// "0 consensus · 0 disputes" was structural. S8's claim_groups + this overlay join them.
const graph = JSON.parse(readFileSync('test/fixtures/f740-graph.json', 'utf8')) as DecisionGraph;

describe('sanitizeClaimGroups', () => {
  it('keeps a cross-provider SAME group', () => {
    expect(sanitizeClaimGroups(graph, [{ ids: ['G3', 'G13'], relation: 'SAME' }]))
      .toEqual([{ ids: ['G3', 'G13'], relation: 'SAME' }]);
  });

  it('drops unknown ids, then under-2 groups, and single-provider groups', () => {
    expect(sanitizeClaimGroups(graph, [
      { ids: ['G3', 'G999'], relation: 'SAME' },  // unknown id → 1 left → dropped
      { ids: ['G3', 'G4'], relation: 'SAME' },    // both codex → dropped
      { ids: ['G3', 'G3', 'G13'], relation: 'SAME' }, // duplicate id deduped, still valid
    ])).toEqual([{ ids: ['G3', 'G13'], relation: 'SAME' }]);
  });

  it('handles undefined groups (old artifacts)', () => {
    expect(sanitizeClaimGroups(graph, undefined)).toEqual([]);
  });
});

describe('overlayClaimGroups', () => {
  it('joins the real f740 paraphrase pair into CONSENSUS without touching the source graph', () => {
    const joined = overlayClaimGroups(graph, [{ ids: ['G3', 'G13'], relation: 'SAME' }]);
    const state = (id: string, g: DecisionGraph) => g.claims.find((claim) => claim.id === id)!.state;
    expect(state('G3', joined)).toBe('CONSENSUS'); // codex SUPPORT + agy SUPPORT, 2 providers
    expect(state('G13', joined)).toBe('CONSENSUS');
    expect(state('G3', graph)).toBe('UNIQUE'); // original untouched
    expect(joined.claims.find((claim) => claim.id === 'G4')!.state).toBe('UNIQUE'); // non-members untouched
  });

  it('OPPOSES marks both claims DISAGREEMENT and wins over SAME', () => {
    const joined = overlayClaimGroups(graph, [
      { ids: ['G14', 'G18'], relation: 'SAME' },
      { ids: ['G14', 'G18'], relation: 'OPPOSES' },
    ]);
    expect(joined.claims.find((claim) => claim.id === 'G14')!.state).toBe('DISAGREEMENT');
    expect(joined.claims.find((claim) => claim.id === 'G18')!.state).toBe('DISAGREEMENT');
  });

  it('no groups → the exact same graph object (old runs render identically)', () => {
    expect(overlayClaimGroups(graph, undefined)).toBe(graph);
    expect(overlayClaimGroups(graph, [{ ids: ['G3', 'G4'], relation: 'SAME' }])).toBe(graph); // all dropped
  });
});

describe('S8 grouping boundary', () => {
  it('the verifier prompt asks for claim_groups over an anonymous all-claims index', () => {
    const prompt = buildVerifierPrompt(graph);
    expect(prompt).toContain('claim_groups');
    expect(prompt).toContain('ALL CLAIMS');
    expect(prompt).toContain('"seats"');
    // Seat identity stays hidden: alias tokens only — no provider keys, no provider-prefixed
    // position ids. (Propositions may name Codex/Gemini as PRODUCT terms; that is not a leak.)
    expect(prompt).toMatch(/"S1"|"S2"/);
    expect(prompt).not.toContain('"provider"');
    expect(prompt).not.toMatch(/codex\/P|agy\/pos|codex-coverage-fill\/P/);
  });

  it('malformed claim_groups never cost the verification set', () => {
    const parsed = ClaimVerificationSet.safeParse({
      verifications: [],
      claim_groups: [{ ids: ['G1'], relation: 'NONSENSE' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.claim_groups).toBeUndefined();
  });
});
