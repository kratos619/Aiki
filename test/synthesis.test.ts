import { describe, expect, it } from 'vitest';

import { compileDecisionGraph } from '../src/orchestration/decision-graph.js';
import { adjudicationScopeViolations, buildJudgePrompt, demoteSelfAuthored, recommendationIssues } from '../src/orchestration/stages/s9-judge.js';
import { deriveAudit, deriveScorecard, renderReport } from '../src/orchestration/stages/s10-render.js';
import { buildVerifierPrompt } from '../src/orchestration/stages/s8-verify.js';
import type { ProviderId } from '../src/providers/types.js';
import type { AnalystSubmission, Stance } from '../src/orchestration/decision-graph.js';
import type { JudgeReport } from '../src/schemas/index.js';
import type { RunCtx } from '../src/orchestration/context.js';

function submission(items: Array<{ id: string; proposition: string; stance: Stance; dimension?: string }>): AnalystSubmission {
  const positions = items.map((item) => ({
    local_id: item.id,
    proposition: item.proposition,
    dimension_id: item.dimension ?? 'R1',
    stance: item.stance,
    basis: 'EVIDENCE' as const,
    load_bearing: true,
    if_false: 'STOP' as const,
    reasoning: `${item.stance.toLowerCase()} reasoning`,
    evidence_ids: [`E-${item.id}`],
    depends_on: [],
  }));
  return {
    task_echo: 'evaluate the idea',
    strongest_version: 'A focused version may work.',
    positions,
    evidence: items.map((item) => ({
      id: `E-${item.id}`,
      claim_supported: item.proposition,
      source_kind: 'USER',
      support: item.stance === 'OPPOSE' ? 'CONTRADICTS' : 'SUPPORTS',
      freshness: 'CURRENT',
    })),
    coverage: [...new Set(positions.map((position) => position.dimension_id))].map((dimension_id) => ({
      dimension_id,
      status: 'COVERED',
      position_ids: positions.filter((position) => position.dimension_id === dimension_id).map((position) => position.local_id),
      rationale: `${dimension_id} is covered by explicit positions.`,
    })),
    decision_questions: [],
  };
}

function graphFor(
  seats: Array<{ provider: ProviderId; items: Parameters<typeof submission>[0] }>,
  groups: string[][],
  rubric = [{ id: 'R1', label: 'business model' }],
) {
  return compileDecisionGraph(seats.map(({ provider, items }) => ({ provider, submission: submission(items) })), rubric, groups);
}

describe('S9 adjudication boundary', () => {
  it('rejects adjudications outside the escalation ids', () => {
    expect(adjudicationScopeViolations({ adjudications: [{ id: 'G1' }, { id: 'G5' }] }, ['G1'])).toEqual(['G5']);
  });

  it('demotes a ruling on a claim authored solely by the judge', () => {
    const graph = graphFor([
      { provider: 'agy', items: [{ id: 'P1', proposition: 'judge claim', stance: 'SUPPORT' }] },
      { provider: 'codex', items: [{ id: 'P1', proposition: 'other claim', stance: 'SUPPORT' }] },
    ], []);
    const adjudications = [
      { id: 'G1', ruling: 'REJECT' as const, reasoning: 'r', evidence_cited: 'e' },
      { id: 'G2', ruling: 'UPHOLD' as const, reasoning: 'r', evidence_cited: 'e' },
    ];

    expect(demoteSelfAuthored(adjudications, graph, 'agy').map((item) => item.ruling)).toEqual(['UNRESOLVED', 'UPHOLD']);
    expect(demoteSelfAuthored(adjudications, graph, 'claude')).toEqual(adjudications);
  });

  it('requires recommendation/conditions in the valid combination', () => {
    expect(recommendationIssues({})).toContain('recommendation is required');
    expect(recommendationIssues({ recommendation: 'PROCEED_WITH_CONDITIONS' })).toContain('conditions are required for PROCEED_WITH_CONDITIONS');
    expect(recommendationIssues({ recommendation: 'STOP', conditions: ['check'] })).toContain('conditions are only valid with PROCEED_WITH_CONDITIONS');
    expect(recommendationIssues({ recommendation: 'PROCEED_WITH_CONDITIONS', conditions: ['check'] })).toEqual([]);
  });
});

describe('anonymous verification and adjudication prompts', () => {
  const graph = graphFor([
    { provider: 'agy', items: [{ id: 'P1', proposition: 'the fee covers loaded costs', stance: 'SUPPORT' }] },
    { provider: 'codex', items: [{ id: 'P1', proposition: 'loaded costs exceed the fee', stance: 'OPPOSE' }] },
  ], [['agy/P1', 'codex/P1']]);

  it('passes verifier reasoning and notes unchanged while hiding provider identity', () => {
    const prompt = buildJudgePrompt(
      { task: 'evaluate the fee', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: [] },
      graph,
      { verifications: [{ target_id: 'G1', verdict: 'CONFIRM', evidence: 'Payroll rule §12 supports the objection.', note: 'Fee base still needs definition.' }] },
      [{ id: 'R1', label: 'business model', keywords: ['fee'] }],
    );

    expect(prompt).toContain('"verifier_status": "CONFIRM"');
    expect(prompt).toContain('"verifier_evidence": "Payroll rule §12 supports the objection."');
    expect(prompt).toContain('"verifier_note": "Fee base still needs definition."');
    expect(prompt).not.toMatch(/agy|codex/);
  });

  it('defines verdicts without a forced opposition quota or provider identity', () => {
    const prompt = buildVerifierPrompt(graph);
    expect(prompt).toContain('CONFIRM = the challenged concern is supported');
    expect(prompt).toContain('REFUTE = it is not supported');
    expect(prompt).not.toMatch(/MUST issue|at least one REFUTE|agy|codex/i);
  });
});

describe('graph-backed audit and scorecard', () => {
  const graph = graphFor([
    { provider: 'agy', items: [
      { id: 'P1', proposition: 'users will pay', stance: 'SUPPORT', dimension: 'R2' },
      { id: 'P2', proposition: 'pricing is viable', stance: 'SUPPORT', dimension: 'R1' },
    ] },
    { provider: 'codex', items: [
      { id: 'P1', proposition: 'users will pay', stance: 'SUPPORT', dimension: 'R2' },
      { id: 'P2', proposition: 'pricing cannot support costs', stance: 'OPPOSE', dimension: 'R1' },
      { id: 'P3', proposition: 'a unique distribution path exists', stance: 'SUPPORT', dimension: 'R2' },
    ] },
  ], [['agy/P1', 'codex/P1'], ['agy/P2', 'codex/P2']], [
    { id: 'R1', label: 'pricing' },
    { id: 'R2', label: 'target user' },
    { id: 'R3', label: 'legal risk' },
  ]);
  const judge = (ruling: 'UPHOLD' | 'REJECT' | 'UNRESOLVED'): JudgeReport => ({
    adjudications: [{ id: 'G2', ruling, reasoning: 'r', evidence_cited: 'e' }],
    verdict: 'v', dissent: ['d'], confidence_notes: 'n',
  });

  it('derives claim audit status from graph state and chair ruling', () => {
    expect(deriveAudit(graph, judge('UPHOLD')).find((item) => item.id === 'G1')).toMatchObject({ status: 'held', confidence: 'HIGH' });
    expect(deriveAudit(graph, judge('UPHOLD')).find((item) => item.id === 'G2')).toMatchObject({ status: 'failed', confidence: 'MEDIUM' });
    expect(deriveAudit(graph, judge('REJECT')).find((item) => item.id === 'G2')).toMatchObject({ status: 'held', confidence: 'MEDIUM' });
    expect(deriveAudit(graph, judge('UNRESOLVED')).find((item) => item.id === 'G2')).toMatchObject({ status: 'unverified', confidence: 'LOW' });
  });

  it('uses dimension anchors and coverage holes for the scorecard', () => {
    expect(deriveScorecard([
      { id: 'R1', label: 'pricing', keywords: ['pricing'] },
      { id: 'R2', label: 'target user', keywords: ['target user'] },
      { id: 'R3', label: 'legal risk', keywords: ['legal'] },
    ], graph)).toEqual([
      { id: 'R1', label: 'pricing', status: 'contested' },
      { id: 'R2', label: 'target user', status: 'examined' },
      { id: 'R3', label: 'legal risk', status: 'unexamined' },
    ]);
  });
});

describe('graph-backed report semantics', () => {
  it('renders shared skepticism as a concern and never as a debate', () => {
    const agy = submission([{ id: 'P1', proposition: 'The fee does not cover loaded costs.', stance: 'OPPOSE' }]);
    const codex = submission([{ id: 'P1', proposition: 'The fee does not cover loaded costs.', stance: 'OPPOSE' }]);
    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: agy }, { provider: 'codex', submission: codex }],
      [{ id: 'R1', label: 'business model' }],
      [['agy/P1', 'codex/P1']],
    );
    const ctx = {
      runId: 'test-run', flags: new Set<string>(), calls: [], budget: { limit: 12, used: 0 },
      available: () => ['agy', 'codex'],
      roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
    } as unknown as RunCtx;
    const report = renderReport(ctx, {
      contract: { task: 'evaluate the fee', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: [] },
      seats: [{ provider: 'agy', output: agy }, { provider: 'codex', output: codex }],
      graph,
      verifications: { verifications: [] },
      judgeReport: { adjudications: [], verdict: 'Do not proceed.', dissent: ['Costs could fall.'], confidence_notes: 'High.' },
    });

    // Shared skepticism is an agreement (both models hold the concern), never a disagreement.
    expect(report).toContain('### Agreement 1: The fee does not cover loaded costs.');
    expect(report).not.toContain('### Disagreement 1');
  });
});
