import { describe, expect, it } from 'vitest';

import { compileDecisionGraph, type AnalystSubmission, type Stance } from '../src/orchestration/decision-graph.js';
import {
  buildDecisionReport,
  computeConfidence,
  renderReport,
  renderTerminalSummary,
  statusFrom,
} from '../src/orchestration/stages/s10-render.js';
import { renderCouncilHtml, type CouncilView } from '../src/council/view.js';
import { renderDecisionDossierMarkdown } from '../src/orchestration/decision-dossier.js';
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
    recommendation_claim_ids: ['G1'],
    strongest_counter_case: { claim_ids: ['G1'], reasoning: 'Churn could erase the apparent demand advantage.' },
    decision_snapshot: {
      decisive_numbers: [{ label: 'Paid demand', value: 'Corroborated', meaning: 'The focused segment clears the first demand gate.', claim_ids: ['G1'] }],
      payback: { status: 'NOT_COMPUTABLE', result: 'No payback period available', basis: 'No investment and cash-flow horizon were supplied.', claim_ids: ['G1'] },
      options: [
        { label: 'Proceed', commitment: 'Under $10k', commitment_kind: 'TARGET_CAP', tradeoff: 'Tests demand without authorizing a full build.', claim_ids: ['G1'] },
        { label: 'Wait', commitment: 'Unknown', commitment_kind: 'UNKNOWN', tradeoff: 'Preserves cash but delays learning.', claim_ids: [] },
      ],
      tripwire: { metric: 'Qualified-user conversion', threshold: 'At least 5%', decision_rule: 'Stop or reshape the idea below this threshold.', claim_ids: ['G1'] },
    },
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
    verifications: { verifications: [{ claim_id: 'G1', status: 'VERIFIED' as const, reasoning: 'Survey data supports it.', evidence_ids: ['agy/E-P1'], calculation_check: 'NOT_APPLICABLE' as const, missing_evidence: [] }] },
    judgeReport,
    actionPlan: {
      actions: [{ order: 1, action: 'Run a paid-demand test.', why: 'Test willingness to pay.', validates: 'G1', effort: 'S' as const, kill_signal: 'Fewer than 5% of qualified users pay.' }],
      sequencing_note: 'Test the decisive demand claim before building.',
    },
    rebuttals: stanceB === 'OPPOSE' ? {
      round: 1 as const,
      selected_claim_ids: ['G1'],
      events: [{
        id: 'RB1', round: 1 as const, responder: 'agy' as ProviderId, claim_id: 'G1',
        target_position_ids: ['agy/P1'], response: 'NARROW' as const,
        reasoning: 'Demand is credible only for the focused segment.', evidence_ids: ['agy/E-P1'],
        narrowed_proposition: 'Focused-segment users will pay for this.',
      }],
      stop_reason: 'ROUND_COMPLETE' as const,
    } : { round: 1 as const, selected_claim_ids: [], events: [], stop_reason: 'NO_ESCALATIONS' as const },
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
    expect(report.keyFindings).toEqual(['Willingness to pay is corroborated.']);
    expect(report.criticalUnknowns).toEqual(['What is the actual churn rate?']);
    expect(report.decisionSnapshot?.payback?.status).toBe('NOT_COMPUTABLE');
    expect(report.decisionSnapshot?.options[0]).toMatchObject({ commitment: 'Under $10k', commitmentKind: 'TARGET_CAP' });
  });

  it('preserves the minority report and dissent', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const report = buildDecisionReport(ctx, args);
    expect(report.minority.dissent).toContain('Churn could erode the economics.');
  });

  // Regression (run 20260714-2321): an affirmatively-phrased decisive-but-unproven claim was rendered
  // as the bare proposition, so the warning read as reassurance — the opposite of the verdict.
  it('frames the critical warning as an unverified assumption, not an echoed affirmative claim', () => {
    const { ctx, args, graph } = fixtures();
    const affirmative = 'A six-week cutover can preserve continuous compliance.';
    const conflicted = {
      ...graph,
      claims: graph.claims.map((claim) => ({
        ...claim,
        load_bearing: true,
        if_false: 'STOP' as const,
        evidence_state: 'CONFLICTED' as const,
        proposition: affirmative,
      })),
    };
    const report = buildDecisionReport(ctx, { ...args, graph: conflicted });

    expect(report.verdict.criticalWarning).not.toBe(affirmative); // the inversion bug
    expect(report.verdict.criticalWarning).toContain('Unverified decisive assumption');
    expect(report.verdict.criticalWarning).toContain('CONFLICTED');
    expect(report.verdict.criticalWarning).toContain(affirmative); // still surfaces the claim
  });
});

describe('R7 decision dossier', () => {
  it('renders the reader-first dossier in the required order', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const built = buildDecisionReport(ctx, args);
    const md = renderReport(ctx, args);
    const headers = [
      '## 1. Decision',
      '## 2. Action plan',
      '## 3. Why this decision',
      '## 4. What could change the decision',
      '## 5. Evidence and verification',
      '## 6. Risks, gaps, and open questions',
      '## 7. Disagreement and dissent',
      '## 8. What the council added',
      '## 9. Run details',
      '## 10. Technical audit',
    ];
    let previous = -1;
    for (const header of headers) {
      const index = md.indexOf(header);
      expect(index, `missing ${header}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(md).toContain('**Recommendation:** Proceed with the focused version.');
    expect(md).toContain('### Decisive numbers');
    expect(md.indexOf('### Decisive numbers')).toBeLessThan(md.indexOf('**Recommendation:**'));
    expect(md).toContain('Payback — NOT COMPUTABLE');
    expect(md).toContain('### Options at a glance');
    expect(md).toContain('TARGET CAP');
    expect(md).toContain('### Go/no-go tripwire');
    expect(md).toContain('### What could overturn this');
    expect(md).toContain('### Critical unknowns');
    expect(md).toContain('Evidence coverage');
    expect(md).toContain('not a probability that the recommendation is correct');
    expect(md).toContain('### Do this first');
    expect(md).toContain('Run a paid-demand test.');
    expect(md).toContain('**Critical warning:**');
    expect(md).toContain('G1');
    expect(md).toContain('agy/E-P1');
    expect(md).toContain('VERIFIED');
    expect(md).toContain('Run a paid-demand test.');
    expect(md).toContain('NARROW');
  });

  it.each([['obvious', 'SUPPORT'], ['contestable', 'OPPOSE']] as const)(
    'keeps Markdown, HTML, and copied Markdown aligned for an %s fixture',
    (_name, stance) => {
      const { ctx, args } = fixtures(stance);
      const report = buildDecisionReport(ctx, args);
      const md = renderDecisionDossierMarkdown(report);
      const html = renderCouncilHtml({
        runId: report.reportId,
        workflow: 'idea-refinement',
        mode: report.mode,
        verdict: report.verdict.summary,
        keyPoints: [], confidence: '', dissent: [], columns: [], rows: [], stats: [], calls: '', flags: report.flags,
        decisionReport: report,
      } as CouncilView);

      for (const token of ['G1', 'agy/E-P1', 'VERIFIED', 'Run a paid-demand test.', 'discovery']) {
        expect(md, `Markdown missing ${token}`).toContain(token);
        expect(html, `HTML missing ${token}`).toContain(token);
      }
      const embedded = JSON.stringify(md).replace(/</g, '\\u003c');
      expect(html).toContain(`const REPORT_MD = ${embedded};`);
      expect(html.indexOf('Decision')).toBeLessThan(html.indexOf('Action plan'));
      expect(html).toContain('Council recommendation');
      expect(html).toContain('Decisive numbers');
      expect(html).toContain('Payback · NOT COMPUTABLE');
      expect(html).toContain('Options at a glance');
      expect(html).toContain('TARGET CAP');
      expect(html).toContain('Go/no-go tripwire');
      const decisionBody = html.slice(html.indexOf('Council recommendation'));
      expect(decisionBody.indexOf('Decisive numbers')).toBeLessThan(decisionBody.indexOf('verdict-text'));
      expect(html).toContain('Do this first');
      expect(html).toContain('What could overturn this');
      expect(html).toContain('Critical unknowns');
      const hero = html.slice(html.indexOf('<section class="verdict'), html.indexOf('</section>', html.indexOf('<section class="verdict')));
      expect(hero).not.toContain(`${report.confidenceBreakdown.score}/100`);
    },
  );

  it('credits only independently verified unique claims to a provider', () => {
    const agy = submission([{ id: 'P1', proposition: 'A niche cohort will pay.', stance: 'SUPPORT' }]);
    const graph = compileDecisionGraph([{ provider: 'agy', submission: agy }], rubric);
    const { ctx, args } = fixtures();
    const report = buildDecisionReport(ctx, {
      ...args,
      seats: [{ provider: 'agy', output: { workflow: 'idea-refinement', ...agy } }],
      graph,
      verifications: { verifications: [{ claim_id: 'G1', status: 'VERIFIED', reasoning: 'Independent receipt review confirms payment.', evidence_ids: ['agy/E-P1'], missing_evidence: [] }] },
      judgeReport: { ...args.judgeReport, recommendation_claim_ids: ['G1'], strongest_counter_case: { claim_ids: ['G1'], reasoning: 'The cohort may be too small.' } },
    });

    expect(report.dossier.contributions.find((item) => item.provider === 'agy')?.verifiedUniqueClaimIds).toEqual(['G1']);
    expect(report.dossier.contributions.find((item) => item.provider === 'codex')?.verifiedUniqueClaimIds).toEqual([]);
  });

  it('resolves every decisive dossier reference to a stored graph claim', () => {
    const { ctx, args } = fixtures('OPPOSE');
    const report = buildDecisionReport(ctx, args);
    const claimIds = new Set(report.claims.map((claim) => claim.id));
    const referenced = [
      ...report.dossier.recommendation.claimIds,
      ...report.dossier.recommendation.conditions.flatMap((condition) => condition.claimIds),
      ...report.dossier.claimChain.flatMap((claim) => [claim.claimId, ...claim.dependsOn]),
      ...report.dossier.evidence.flatMap((evidence) => evidence.claimIds),
      ...report.disagreements.map((item) => item.id),
      ...report.dossier.positionChanges.map((event) => event.claimId),
      ...report.dossier.sensitivity.flatMap((item) => [item.claimId, ...item.linkedClaimIds]),
      ...report.dossier.counterCase.claimIds,
      ...report.dossier.contributions.flatMap((item) => item.verifiedUniqueClaimIds),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.every((id) => claimIds.has(id))).toBe(true);
  });

  it('labels degraded verification and planning in Markdown and HTML', () => {
    const { ctx, args } = fixtures();
    ctx.flags.add('verification_skipped');
    ctx.flags.add('plan_fallback');
    const degradedArgs = {
      ...args,
      verifications: { verifications: [] },
      actionPlan: { kind: 'PlannerUnavailable' as const, reason: 'planner_failed' as const, unresolved_questions: ['Which cohort pays?'] },
    };
    const report = buildDecisionReport(ctx, degradedArgs);
    const md = renderReport(ctx, degradedArgs);
    const html = renderCouncilHtml({
      runId: report.reportId, workflow: 'idea-refinement', mode: report.mode,
      verdict: report.verdict.summary, keyPoints: [], confidence: '', dissent: [], columns: [], rows: [], stats: [], calls: '', flags: report.flags,
      decisionReport: report,
    } as CouncilView);

    for (const output of [md, html]) {
      expect(output).toContain('DEGRADED');
      expect(output).toContain('verification_skipped');
      expect(output).toContain('planner_failed');
    }
  });

  it('distinguishes not-applicable coverage from missing evidence', () => {
    const { ctx, args } = fixtures();
    const seats = args.seats.map((seat) => ({
      ...seat,
      output: {
        ...seat.output,
        coverage: [...seat.output.coverage, { dimension_id: 'R2', status: 'NOT_APPLICABLE' as const, position_ids: [], rationale: 'No regulated activity.' }],
      },
    }));
    const graph = { ...args.graph, holes: { ...args.graph.holes, evidence: [{ claim_id: 'G1', reason: 'independent demand evidence missing' }] } };
    const report = buildDecisionReport(ctx, { ...args, seats, graph, rubric: [...rubric, { id: 'R2', label: 'regulatory exposure' }] });

    expect(report.dossier.coverage.find((item) => item.dimensionId === 'R1')?.status).toBe('MISSING_EVIDENCE');
    expect(report.dossier.coverage.find((item) => item.dimensionId === 'R2')?.status).toBe('NOT_APPLICABLE');
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
    expect(text).toContain('Decision state: ACCEPTED');
    expect(text).toContain('Evidence coverage:');
    expect(text).toContain('not a probability of correctness');
    expect(text).toContain('Decision numbers:');
    expect(text).toContain('Payback (not computable): No payback period available');
    expect(text).toContain('Options: Proceed — Under $10k (target cap)');
    expect(text).toContain('Go/no-go tripwire:');
    expect(text).toContain('./r.md');
    expect(text).toContain('./r.json');
  });
});
