import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { normalizePlannerOutput, anchoredActionPlan, missingDeliverables, type PlanAnchors } from '../src/orchestration/stages/s9b-plan.js';

// T2 (plan/AIKI-v6-council-integrity-plan.md): run f740's planner output contained the COMPLETE
// requested deliverables and was replaced by PlannerUnavailable over a 13-char headline overflow.
// A parseable plan must never be discarded.
const raw = readFileSync('test/fixtures/f740-s9b-first.out.txt', 'utf8');
const graph = JSON.parse(readFileSync('test/fixtures/f740-graph.json', 'utf8')) as {
  claims: Array<{ id: string }>;
  evidence: Array<{ id: string }>;
  holes: { coverage: Array<{ label: string }> };
};
const contract = JSON.parse(readFileSync('test/fixtures/f740-contract.json', 'utf8')) as {
  requested_outputs: Array<'DECISION' | 'FEATURE_BACKLOG' | 'IMPLEMENTATION_PLAN'>;
};
const parsed = JSON.parse(raw.match(/```json\s*([\s\S]*?)```/)![1]!) as Record<string, unknown>;

const anchors: PlanAnchors = {
  claimIds: graph.claims.map((c) => c.id),
  knownReaderIds: graph.claims.map((c) => c.id),
  blindSpots: graph.holes.coverage.map((h) => h.label),
  openQuestions: [
    'Can the existing Aiki engine stream structured stage events and cancel a provider process reliably within the first 48 hours?',
    'Does a prepared council demo visibly produce a better supported decision than the strongest single-provider result?',
  ],
  sourceIds: graph.evidence.map((e) => e.id),
};

describe('v6 planner totality (f740 replays)', () => {
  it('REPLAY: exact f740 planner output yields the full plan — never PlannerUnavailable', () => {
    const normalized = normalizePlannerOutput(structuredClone(parsed) as never, true);
    const plan = anchoredActionPlan(normalized, anchors, contract.requested_outputs, true);
    expect(plan).not.toBeNull();
    expect(plan!.feature_backlog!.must.length).toBe(4);
    expect(plan!.implementation_plan!.milestones.length).toBe(4);
    expect(plan!.reader_brief!.headline.length).toBeLessThanOrEqual(160);
    expect(missingDeliverables(plan!, contract.requested_outputs)).toEqual([]);
  });

  it('missing requested deliverable returns a partial plan, not null', () => {
    const noBacklog = structuredClone(parsed) as Record<string, unknown>;
    delete noBacklog.feature_backlog;
    const plan = anchoredActionPlan(normalizePlannerOutput(noBacklog as never, true), anchors, contract.requested_outputs, true);
    expect(plan).not.toBeNull();
    expect(plan!.feature_backlog).toBeUndefined();
    expect(plan!.reader_brief).toBeDefined();
    expect(missingDeliverables(plan!, contract.requested_outputs)).toEqual(['FEATURE_BACKLOG']);
  });

  it('a reader brief citing a known claim id is kept — the renderer substitutes labels', () => {
    const withId = structuredClone(parsed) as { reader_brief: { bottom_line: string } };
    withId.reader_brief.bottom_line = `Internal claim ${graph.claims[0]!.id} decides this.`;
    const plan = anchoredActionPlan(normalizePlannerOutput(withId as never, true), anchors, contract.requested_outputs, true);
    expect(plan).not.toBeNull();
    expect(plan!.reader_brief!.bottom_line).toContain(graph.claims[0]!.id);
  });
});
