import { describe, expect, it } from 'vitest';

import { compileDecisionGraph, type AnalystSubmission, type Stance } from '../src/orchestration/decision-graph.js';
import {
  buildDecisionReport,
  computeConfidence,
  renderReport,
  renderTerminalSummary,
  statusFrom,
} from '../src/orchestration/stages/s10-render.js';
import type { JudgeReport } from '../src/schemas/index.js';
import type { ProviderId } from '../src/providers/types.js';
import type { RunCtx } from '../src/orchestration/context.js';

function submission(items: Array<{ id: string; proposition: string; stance: Stance; basis?: 'EVIDENCE' | 'ASSUMPTION' }>): AnalystSubmission {
  const positions = items.map((item) => ({
    local_id: item.id,
    proposition: item.proposition,
    dimension_id: 'R1',
    stance: item.stance,
    basis: item.basis ?? ('EVIDENCE' as const),
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
      source_kind: 'PRIMARY' as const,
      support: item.stance === 'OPPOSE' ? ('CONTRADICTS' as const) : ('SUPPORTS' as const),
      freshness: 'CURRENT' as const,
    })),
    coverage: [{ dimension_id: 'R1', status: 'COVERED' as const, position_ids: positions.map((p) => p.local_id), rationale: 'covered' }],
    decision_questions: [{ id: 'Q1', question: 'What is the actual churn rate?', claim_ids: [positions[0]!.local_id] }],
  };
}

const rubric = [{ id: 'R1', label: 'business model' }];

function fixtures(stanceB: Stance = 'SUPPORT') {
  const agy = submission([{ id: 'P1', proposition: 'Users will pay for this.', stance: 'SUPPORT' }]);
  const codex = submission([{ id: 'P1', proposition: 'Users will pay for this.', stance: stanceB }]);
  const graph = compileDecisionGraph(
    [{ provider: 'agy' as ProviderId, submission: agy }, { provider: 'codex' as ProviderId, submission: codex }],
    rubric,
    [['agy/P1', 'codex/P1']],
  );
  const judgeReport: JudgeReport = {
    adjudications: stanceB === 'OPPOSE' ? [{ id: 'G1', ruling: 'REJECT', reasoning: 'evidence favors support', evidence_cited: 'E-P1' }] : [],
    verdict: 'Proceed with the focused version.',
    recommendation: 'PROCEED',
    key_points: ['Willingness to pay is corroborated.'],
    dissent: ['Churn could erode the economics.'],
    confidence_notes: 'HIGH on demand, MEDIUM on economics.',
  };
  const ctx = {
    runId: 'test-run', flags: new Set<string>(), calls: [], budget: { limit: 18, used: 0 },
    available: () => ['agy', 'codex'] as ProviderId[],
    roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
  } as unknown as RunCtx;
  const args = {
    contract: { task: 'Evaluate the subscription idea', task_type: 'idea-refinement' as const, constraints: ['budget under $10k'], unknowns: [], success_criteria: ['a go/no-go verdict'] },
    seats: [{ provider: 'agy' as ProviderId, output: { workflow: 'idea-refinement' as const, ...agy } }, { provider: 'codex' as ProviderId, output: { workflow: 'idea-refinement' as const, ...codex } }],
    graph,
    verifications: { verifications: [{ target_id: 'G1', verdict: 'CONFIRM' as const, evidence: 'Survey data supports it.', note: '' }] },
    judgeReport,
    rubric,
  };
  return { ctx, args, graph, judgeReport };
}

describe('decision report statuses and confidence', () => {
  it('maps judge recommendations onto report statuses', () => {
    expect(statusFrom({ recommendation: 'PROCEED' } as JudgeReport)).toBe('ACCEPTED');
    expect(statusFrom({ recommendation: 'PROCEED_WITH_CONDITIONS' } as JudgeReport)).toBe('ACCEPTED_WITH_CONDITIONS');
    expect(statusFrom({ recommendation: 'PIVOT' } as JudgeReport)).toBe('REJECTED');
    expect(statusFrom({ recommendation: 'STOP' } as JudgeReport)).toBe('REJECTED');
    expect(statusFrom({} as JudgeReport)).toBe('INCONCLUSIVE');
  });

  it('scores structural confidence high when claims are verified and convergent', () => {
    const { graph } = fixtures();
    const confidence = computeConfidence(graph, new Set());
    expect(confidence.score).toBeGreaterThanOrEqual(80);
    expect(confidence.label).toBe('High');
  });

  it('never grants High confidence from consensus alone without verification coverage', () => {
    const { graph } = fixtures();
    const unverified = {
      ...graph,
      claims: graph.claims.map((claim) => ({ ...claim, evidence_state: 'UNVERIFIED' as const })),
    };
    const confidence = computeConfidence(unverified, new Set());
    expect(confidence.score).toBeLessThanOrEqual(79);
    expect(confidence.label).not.toBe('High');
  });

  it('penalizes degradation flags', () => {
    const { graph } = fixtures();
    const clean = computeConfidence(graph, new Set());
    const flagged = computeConfidence(graph, new Set(['low_diversity', 'synthesis_suspect']));
    expect(flagged.score).toBeLessThan(clean.score);
  });
});

describe('machine-readable decision report', () => {
  it('builds the consensus map with per-provider stances and rulings', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const report = buildDecisionReport(ctx, args);

    expect(report.reportId).toBe('test-run');
    expect(report.verdict.status).toBe('ACCEPTED');
    const claim = report.claims[0]!;
    expect(claim.stances.agy).toBe('AGREE');
    expect(claim.stances.codex).toBe('DISAGREE');
    expect(claim.ruling).toBe('ACCEPTED'); // chair REJECTed the objection → the claim holds
    expect(report.verdict.confidence).toBeGreaterThan(0);
    expect(report.verdict.confidence).toBeLessThanOrEqual(1);
  });

  it('preserves the minority report and dissent', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const report = buildDecisionReport(ctx, args);
    expect(report.minority.dissent).toContain('Churn could erode the economics.');
  });
});

describe('markdown decision report (12-section template)', () => {
  it('renders every numbered section', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const md = renderReport(ctx, args);
    for (const header of [
      '## 1. Report Metadata',
      '## 2. Executive Verdict',
      '## 3. Problem Interpretation',
      '## 4. Individual Model Positions',
      '## 5. Consensus Map',
      '## 6. Key Agreements',
      '## 7. Key Disagreements',
      '## 8. Minority Report',
      '## 9. Verification Results',
      '## 10. Final Synthesis',
      '## 11. Risks and Unresolved Questions',
      '## 12. Audit Information',
    ]) expect(md, `missing ${header}`).toContain(header);
    expect(md).toContain('AGREE');
    expect(md).toContain('DISAGREE');
    expect(md).toMatch(/Confidence.*\/100/);
  });

  it('keeps shared skepticism out of Key Disagreements', () => {
    const agy = submission([{ id: 'P1', proposition: 'The fee does not cover loaded costs.', stance: 'OPPOSE' }]);
    const codex = submission([{ id: 'P1', proposition: 'The fee does not cover loaded costs.', stance: 'OPPOSE' }]);
    const graph = compileDecisionGraph(
      [{ provider: 'agy', submission: agy }, { provider: 'codex', submission: codex }],
      rubric,
      [['agy/P1', 'codex/P1']],
    );
    const { ctx } = fixtures();
    const md = renderReport(ctx, {
      contract: { task: 'evaluate the fee', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: [] },
      seats: [{ provider: 'agy', output: { workflow: 'idea-refinement', ...agy } }, { provider: 'codex', output: { workflow: 'idea-refinement', ...codex } }],
      graph,
      verifications: { verifications: [] },
      judgeReport: { adjudications: [], verdict: 'Do not proceed.', dissent: ['Costs could fall.'], confidence_notes: 'High.' },
    });

    expect(md).not.toContain('### Disagreement 1');
    expect(md).toContain('The fee does not cover loaded costs.');
  });
});

describe('terminal summary (level 1)', () => {
  it('renders the one-screen verdict block with paths', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const report = buildDecisionReport(ctx, args);
    const text = renderTerminalSummary(report, { markdownPath: './r.md', jsonPath: './r.json' });

    expect(text).toContain('MULTI-MODEL DECISION REPORT');
    expect(text).toContain('Verdict:');
    expect(text).toContain('Status: ACCEPTED');
    expect(text).toMatch(/Confidence: \d+\/100/);
    expect(text).toContain('./r.md');
    expect(text).toContain('./r.json');
  });
});
