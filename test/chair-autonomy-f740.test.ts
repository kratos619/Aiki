import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { adjudicationEvidenceViolations } from '../src/orchestration/stages/s9-judge.js';
import { extractJson } from '../src/providers/adapter-core.js';

// T6 (plan/AIKI-v6-council-integrity-plan.md): run f740's chair ruled HOLDS on G4/G6/G7/G8/G12
// with nuanced caveats in its reasoning, and honestly UNRESOLVED on the UNVERIFIABLE claims.
// The hard rule "PARTIAL/UNVERIFIABLE ⇒ must be UNRESOLVED" rejected those 5 rulings and spent a
// 125s Opus repair flattening them. The chair may rule on judgment; only ruling HOLDS against
// positively CONTRADICTED evidence stays a violation.
const verifications = JSON.parse(readFileSync('test/fixtures/f740-verifications.json', 'utf8')) as {
  verifications: Array<{ claim_id: string; status: string; evidence_ids: string[] }>;
};
const raw = extractJson(readFileSync('test/fixtures/f740-s9-first.out.txt', 'utf8')) as {
  adjudications: Array<{ claim_id: string; ruling: string }>;
};
const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));

// The real chair rulings; evidence ids normalized to each claim's own verification set (the live
// path translates chair aliases to the same ids before this check runs — f740's repair prompt
// listed ONLY the 5 PARTIAL-rule violations, no evidence-reference errors).
const adjudications = raw.adjudications.map((item) => ({
  id: item.claim_id,
  ruling: item.ruling,
  evidence_ids: verificationById.get(item.claim_id)!.evidence_ids,
}));

describe('chair autonomy', () => {
  it('REPLAY: the f740 chair first output is accepted — no repair, nuanced rulings preserved', () => {
    expect(adjudicationEvidenceViolations({ adjudications }, verifications)).toEqual([]);
    // Proves the exact live loss: 5 HOLDS rulings on PARTIAL verification survive.
    const preserved = adjudications.filter((item) =>
      verificationById.get(item.id)!.status === 'PARTIAL' && item.ruling === 'HOLDS');
    expect(preserved.map((item) => item.id).sort()).toEqual(['G12', 'G4', 'G6', 'G7', 'G8']);
  });

  it('ruling HOLDS against CONTRADICTED evidence is still a violation', () => {
    const contradicted = {
      verifications: [{ claim_id: 'G4', status: 'CONTRADICTED', evidence_ids: ['codex/E1'], reasoning: 'refuted', missing_evidence: [] }],
    };
    const issues = adjudicationEvidenceViolations(
      { adjudications: [{ id: 'G4', ruling: 'HOLDS', evidence_ids: ['codex/E1'] }] },
      contradicted as never,
    );
    expect(issues).toEqual(['G4: CONTRADICTED verification cannot rule HOLDS']);
  });

  it('a missing claim verification is still flagged', () => {
    const issues = adjudicationEvidenceViolations(
      { adjudications: [{ id: 'G999', ruling: 'HOLDS', evidence_ids: ['x'] }] },
      verifications,
    );
    expect(issues).toContain('G999: missing claim verification');
  });
});
