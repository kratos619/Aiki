import { describe, expect, it } from 'vitest';

import { compileDecisionGraph, selectEscalations } from '../src/orchestration/decision-graph.js';
import { adaptIdeaOutput } from '../src/orchestration/legacy-idea-adapter.js';
import { buildGroupingInput } from '../src/orchestration/stages/s7-decision-graph.js';

const position = (local_id: string, proposition: string, stance: 'SUPPORT' | 'OPPOSE') => ({
  local_id,
  proposition,
  dimension_id: 'business-model',
  stance,
  basis: 'EVIDENCE' as const,
  load_bearing: true,
  if_false: 'STOP' as const,
  reasoning: 'Unit economics determine whether the idea can work.',
  evidence_ids: ['E1'],
  depends_on: [],
});

const submission = (proposition: string, stance: 'SUPPORT' | 'OPPOSE') => ({
  task_echo: 'evaluate the business model',
  strongest_version: 'A focused version may work.',
  positions: [position('P1', proposition, stance)],
  evidence: [{
    id: 'E1',
    claim_supported: proposition,
    source_kind: 'USER' as const,
    support: stance === 'OPPOSE' ? 'CONTRADICTS' as const : 'SUPPORTS' as const,
    freshness: 'CURRENT' as const,
  }],
  coverage: [],
  decision_questions: [],
});

describe('compileDecisionGraph', () => {
  it('classifies two opposing positions as a shared concern, not a disagreement', () => {
    const proposition = 'A 15% fee covers fully loaded employment costs.';
    const graph = compileDecisionGraph(
      [
        { provider: 'agy', submission: submission(proposition, 'OPPOSE') },
        { provider: 'codex', submission: submission(proposition, 'OPPOSE') },
      ],
      [{ id: 'business-model', label: 'business model' }],
      [['agy/P1', 'codex/P1']],
    );

    expect(graph.claims).toHaveLength(1);
    expect(graph.claims[0]).toMatchObject({ state: 'SHARED_CONCERN', position_ids: ['agy/P1', 'codex/P1'] });
    expect(graph.claims.filter((claim) => claim.state === 'DISAGREEMENT')).toEqual([]);
    expect(graph.positions.map((item) => item.proposition)).toEqual([proposition, proposition]);
  });

  it('groups opposing positions by reference without rewriting either proposition', () => {
    const support = 'A 15% fee covers fully loaded employment costs.';
    const oppose = 'Payroll, benefits, and compliance costs exceed the proposed 15% fee.';
    const graph = compileDecisionGraph(
      [
        { provider: 'agy', submission: submission(support, 'SUPPORT') },
        { provider: 'codex', submission: submission(oppose, 'OPPOSE') },
      ],
      [{ id: 'business-model', label: 'business model' }],
      [['agy/P1', 'codex/P1']],
    );

    expect(graph.claims[0]).toMatchObject({ state: 'DISAGREEMENT', proposition: support });
    expect(graph.positions.map((item) => item.proposition)).toEqual([support, oppose]);
  });

  it('marks a current load-bearing fact backed only by model knowledge as an evidence hole', () => {
    const proposition = 'Current US nurse staffing rules permit this employment model.';
    const input = submission(proposition, 'SUPPORT');
    input.positions[0]!.dimension_id = 'policy';
    input.evidence[0] = {
      ...input.evidence[0]!,
      source_kind: 'MODEL_KNOWLEDGE',
      freshness: 'CURRENT',
    };

    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: input }],
      [{ id: 'policy', label: 'policy / legal / compliance risk' }],
    );

    expect(graph.claims[0]).toMatchObject({ state: 'UNCERTAIN', evidence_state: 'UNVERIFIED' });
    expect(graph.holes.evidence).toEqual([{ claim_id: 'G1', reason: 'claim requires independently checkable evidence' }]);
  });

  it('records coverage holes and dependency edges using graph claim ids', () => {
    const input = submission('Unit economics support the proposed fee.', 'SUPPORT');
    input.coverage = [{ dimension_id: 'business-model', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 covers the business model.' }];
    input.positions.push({
      ...position('P2', 'Demand is strong enough to reach break-even volume.', 'SUPPORT'),
      depends_on: ['P1'],
      evidence_ids: [],
    });

    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: input }],
      [
        { id: 'business-model', label: 'business model' },
        { id: 'policy', label: 'policy / legal / compliance risk' },
      ],
    );

    expect(graph.edges).toContainEqual({ from: 'G2', to: 'G1', type: 'DEPENDS_ON' });
    expect(graph.claims[0]).toMatchObject({ sensitivity: 'DECISIVE' });
    expect(graph.holes.coverage).toEqual([{ dimension_id: 'policy', label: 'policy / legal / compliance risk' }]);
  });

  it('does not manufacture cross-provider disagreement from one analyst contradicting itself', () => {
    const input = submission('The fee covers loaded costs.', 'SUPPORT');
    input.positions.push({ ...position('P2', 'Loaded costs exceed the fee.', 'OPPOSE'), evidence_ids: ['E2'] });
    input.evidence.push({ ...input.evidence[0]!, id: 'E2', claim_supported: 'Loaded costs exceed the fee.', support: 'CONTRADICTS' });
    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: input }],
      [{ id: 'business-model', label: 'business model' }],
      [['agy/P1', 'agy/P2']],
    );

    expect(graph.claims[0]?.state).toBe('UNCERTAIN');
    expect(graph.claims.some((claim) => claim.state === 'DISAGREEMENT')).toBe(false);
  });

  it('accepts a reasoned NOT_APPLICABLE entry as explicit coverage', () => {
    const input = submission('The fee covers loaded costs.', 'SUPPORT');
    input.coverage = [
      { dimension_id: 'business-model', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 addresses the fee.' },
      { dimension_id: 'policy', status: 'NOT_APPLICABLE', position_ids: [], rationale: 'No regulated activity is proposed.' },
    ];
    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: input }],
      [
        { id: 'business-model', label: 'business model' },
        { id: 'policy', label: 'policy / legal / compliance risk' },
      ],
    );

    expect(graph.holes.coverage).toEqual([]);
  });

  it('reports a structural hole when a position lacks an explicit coverage entry', () => {
    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: submission('The fee covers loaded costs.', 'SUPPORT') }],
      [{ id: 'business-model', label: 'business model' }],
    );

    expect(graph.holes.coverage).toEqual([{ dimension_id: 'business-model', label: 'business model' }]);
  });
});

describe('selectEscalations', () => {
  it('skips shared concerns but independently challenges load-bearing unique claims', () => {
    const concern = 'The proposed fee does not cover employment costs.';
    const graph = compileDecisionGraph(
      [
        { provider: 'agy', submission: submission(concern, 'OPPOSE') },
        { provider: 'codex', submission: submission(concern, 'OPPOSE') },
      ],
      [{ id: 'business-model', label: 'business model' }],
      [['agy/P1', 'codex/P1']],
    );
    const codexInput = submission(concern, 'OPPOSE');
    codexInput.positions.push({
      ...position('P2', 'A union contract blocks the proposed model.', 'OPPOSE'),
      evidence_ids: ['E2'],
    });
    codexInput.evidence.push({ ...codexInput.evidence[0]!, id: 'E2', claim_supported: 'A union contract blocks the proposed model.' });
    const withUnique = compileDecisionGraph(
      [
        { provider: 'agy', submission: submission(concern, 'OPPOSE') },
        { provider: 'codex', submission: codexInput },
      ],
      [{ id: 'business-model', label: 'business model' }],
      [['agy/P1', 'codex/P1']],
    );

    expect(selectEscalations(graph, { max: 4 })).toEqual([]);
    expect(selectEscalations(withUnique, { max: 4 })).toEqual([
      { claim_id: 'G2', reason: 'load-bearing unique claim', kind: 'INDEPENDENT_CHALLENGE' },
    ]);
  });
});

describe('adaptIdeaOutput', () => {
  it('preserves legacy assumptions and attacks without inventing evidence or opposition', () => {
    const output = adaptIdeaOutput({
      workflow: 'idea-refinement',
      task_echo: 'evaluate the business model',
      strongest_version: 'A focused version may work.',
      assumptions: [{ id: 'A1', statement: 'A 15% fee covers loaded costs.', type: 'VERIFIABLE', load_bearing: true }],
      attacks: [{ id: 'X1', target_assumption: 'A1', argument: 'Benefits may exceed the fee.', severity: 'HIGH' }],
      open_questions: ['What are the loaded costs?'],
    });

    expect(output.positions).toEqual([expect.objectContaining({ local_id: 'A1', proposition: 'A 15% fee covers loaded costs.', stance: 'UNKNOWN', evidence_ids: [] })]);
    expect(output.evidence).toEqual([]);
    expect(output.decision_questions.map((question) => question.question)).toEqual([
      'What are the loaded costs?',
      'Benefits may exceed the fee.',
    ]);
  });
});

describe('semantic grouping boundary', () => {
  it('sends anonymous aliases rather than provider identities', () => {
    const { prompt, refs } = buildGroupingInput([
      { provider: 'agy', submission: submission('The fee covers loaded costs.', 'SUPPORT') },
      { provider: 'codex', submission: submission('Loaded costs exceed the fee.', 'OPPOSE') },
    ]);

    expect(prompt).not.toContain('agy');
    expect(prompt).not.toContain('codex');
    expect(prompt).toContain('"id": "P1"');
    expect([...refs.values()]).toEqual(['agy/P1', 'codex/P1']);
  });
});
