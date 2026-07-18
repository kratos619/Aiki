import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { evidenceOrigin } from '../src/orchestration/evidence-origin.js';
import { computeConfidence } from '../src/orchestration/stages/s10-render.js';
import type { DecisionGraph } from '../src/orchestration/decision-graph.js';

// T7 (plan/AIKI-v6-council-integrity-plan.md): run f740 reported "50% evidence coverage" while
// 8 of its 12 cards restated the user's own brief (some marked VERIFIED). Origin is now explicit:
// only independent EXTERNAL evidence counts as quality; user material is honestly labeled.
// (Render-cell and Sources-line assertions live in the T11 f740 acceptance test.)
const graph = JSON.parse(readFileSync('test/fixtures/f740-graph.json', 'utf8')) as DecisionGraph;

describe('evidenceOrigin', () => {
  it('classifies the real f740 cards: 2 external, 8 user material, 2 model knowledge', () => {
    const counts = { EXTERNAL: 0, USER_MATERIAL: 0, MODEL_KNOWLEDGE: 0 };
    for (const card of graph.evidence) counts[evidenceOrigin(card)]++;
    expect(counts).toEqual({ EXTERNAL: 2, USER_MATERIAL: 8, MODEL_KNOWLEDGE: 2 });
  });

  it('a PRIMARY-labeled card with a LOCAL path is user material, not external', () => {
    expect(evidenceOrigin({ source_kind: 'PRIMARY', locator: '/Users/user/repo/inputs/idea-brief.md' })).toBe('USER_MATERIAL');
    expect(evidenceOrigin({ source_kind: 'SECONDARY', locator: 'https://example.com/report' })).toBe('EXTERNAL');
  });

  it('accepts dossier-row shape (sourceKind/source) as well as graph-card shape', () => {
    expect(evidenceOrigin({ sourceKind: 'PRIMARY', source: 'https://www.npmjs.com/package/aiki-cli' })).toBe('EXTERNAL');
    expect(evidenceOrigin({ sourceKind: 'USER', source: 'Task Contract' })).toBe('USER_MATERIAL');
    expect(evidenceOrigin({ sourceKind: 'MODEL_KNOWLEDGE', source: 'Model knowledge: sandboxes' })).toBe('MODEL_KNOWLEDGE');
  });
});

describe('confidence evidence quality', () => {
  it('counts only independent external evidence — f740 is 2/12, not 10/12', () => {
    const breakdown = computeConfidence(graph, new Set());
    expect(breakdown.evidenceQuality).toBeCloseTo(2 / 12, 5);
  });
});
