import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileDecisionGraph,
  selectRebuttalEscalations,
  type AnalystSubmission,
  type DecisionGraph,
} from '../src/orchestration/decision-graph.js';
import { RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import { s8bRebuttal } from '../src/orchestration/stages/s8b-rebuttal.js';
import {
  adjudicableClaimIds,
  buildJudgePrompt,
  chairRecommendationIssues,
} from '../src/orchestration/stages/s9-judge.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import { IdeaChairReportModel, RebuttalResponseSet, type ClaimVerificationSet, type RebuttalEventSet } from '../src/schemas/index.js';

const proposition = 'A 15% fee covers fully loaded employment costs.';

function submission(stance: 'SUPPORT' | 'OPPOSE', ifFalse: 'STOP' | 'MINOR' = 'STOP'): AnalystSubmission {
  return {
    task_echo: 'evaluate the fee',
    strongest_version: 'A focused employment model may work.',
    positions: [{
      local_id: 'P1', proposition, dimension_id: 'R8', stance, basis: 'EVIDENCE',
      load_bearing: true, if_false: ifFalse,
      reasoning: stance === 'SUPPORT' ? 'The fee exceeds the supplied cost base.' : 'Benefits make the fee insufficient.',
      evidence_ids: ['E1'], depends_on: [],
    }],
    evidence: [{
      id: 'E1', claim_supported: proposition, source_kind: 'USER',
      support: stance === 'SUPPORT' ? 'SUPPORTS' : 'CONTRADICTS', freshness: 'CURRENT',
    }],
    coverage: [{
      dimension_id: 'R8', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 addresses unit economics.',
    }],
    decision_questions: [],
  };
}

function graph(stances: Array<{ provider: ProviderId; stance: 'SUPPORT' | 'OPPOSE' }>, ifFalse: 'STOP' | 'MINOR' = 'STOP'): DecisionGraph {
  return compileDecisionGraph(
    stances.map(({ provider, stance }) => ({ provider, submission: submission(stance, ifFalse) })),
    [{ id: 'R8', label: 'business model' }],
    stances.length > 1 ? [stances.map(({ provider }) => `${provider}/P1`)] : [],
  );
}

const verified = (claimId = 'G1'): ClaimVerificationSet => ({
  verifications: [{
    claim_id: claimId,
    status: 'PARTIAL',
    reasoning: 'The supplied cost definitions conflict.',
    evidence_ids: ['agy/E1', 'codex/E1'],
    calculation_check: 'NOT_APPLICABLE',
    missing_evidence: ['one normalized cost base'],
  }],
});

function adapter(id: ProviderId, prompts: string[]): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      prompts.push(req.prompt);
      const response = id === 'agy' ? 'CONCEDE' : 'COUNTER';
      const obj = {
        events: [{
          claim_id: 'G1', response,
          reasoning: response === 'CONCEDE'
            ? 'The opposing cost definition is better supported.'
            : 'The opposing conclusion mixes payroll cost with pass-through expenses.',
          evidence_ids: response === 'COUNTER' ? ['E1'] : [],
        }],
      };
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function handle(id: ProviderId, prompts: string[]): ProviderHandle {
  return {
    id,
    adapter: adapter(id, prompts),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-r5-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(prompts: string[], budget = 18): RunCtx {
  const writer = new RunWriter('20260713-1700-idea-refinement-r5aa', root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles: ['agy', 'codex', 'claude'].map((id) => handle(id as ProviderId, prompts)),
    roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
    writer,
    cwd: writer.dir,
    budget,
  });
}

describe('R5 escalation selection', () => {
  it('selects only decision-critical genuine conflict', () => {
    const concern = graph([
      { provider: 'agy', stance: 'OPPOSE' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const minor = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ], 'MINOR');

    expect(selectRebuttalEscalations(concern, { verifications: [] }, { maxNodes: 3 })).toEqual([]);
    expect(selectRebuttalEscalations(conflict, verified(), { maxNodes: 3 })).toEqual([
      { claim_id: 'G1', reason: 'opposing provider stances on a decision-critical claim', kind: 'DISAGREEMENT' },
    ]);
    expect(selectRebuttalEscalations(minor, verified(), { maxNodes: 3 })).toEqual([]);
  });
});

describe('R5 model boundaries', () => {
  it('requires the exact chair ruling shape and a concrete NARROW proposition', () => {
    const report = {
      verdict: 'Proceed.', recommendation: 'PROCEED', recommendation_claim_ids: ['G1'],
      strongest_counter_case: { claim_ids: ['G1'], reasoning: 'Costs may still be understated.' },
      dissent: ['Costs may still be understated.'], confidence_notes: 'Medium.',
    };
    expect(IdeaChairReportModel.safeParse({
      ...report,
      adjudications: [{ id: 'G1', ruling: 'REJECT', reasoning: 'Legacy shape.', evidence_ids: ['E1'], effect_on_decision: 'Proceed.' }],
    }).success).toBe(false);
    expect(IdeaChairReportModel.safeParse({
      ...report,
      adjudications: [{ claim_id: 'G1', ruling: 'HOLDS', reasoning: 'Evidence supports it.', evidence_ids: ['E1'], effect_on_decision: 'Proceed.' }],
    }).success).toBe(true);
    expect(RebuttalResponseSet.safeParse({
      events: [{ claim_id: 'G1', response: 'NARROW', reasoning: 'Only a smaller claim holds.', evidence_ids: [] }],
    }).success).toBe(false);
  });
});

describe('R5 bounded rebuttal stage', () => {
  it('spends zero calls when there is no genuine conflict', async () => {
    const prompts: string[] = [];
    const run = ctx(prompts);
    const concern = graph([
      { provider: 'agy', stance: 'OPPOSE' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);

    const result = await s8bRebuttal(run, concern, { verifications: [] });

    expect(result).toMatchObject({ events: [], stop_reason: 'NO_ESCALATIONS' });
    expect(prompts).toEqual([]);
    expect(run.budget.used).toBe(0);
  });

  it('uses one grouped call per relevant scout, keeps prompts anonymous, and preserves graph history', async () => {
    const prompts: string[] = [];
    const run = ctx(prompts);
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const before = structuredClone(conflict);

    const result = await s8bRebuttal(run, conflict, verified());

    expect(run.budget.used).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts.join('\n')).not.toMatch(/agy|codex|agy\/P1|codex\/P1/i);
    expect(result.events.map((event) => event.response)).toEqual(['CONCEDE', 'COUNTER']);
    expect(result.events.every((event) => event.round === 1 && event.claim_id === 'G1')).toBe(true);
    expect(conflict).toEqual(before);

    const stored = JSON.parse(await readFile(join(run.writer.dir, '08b-rebuttals.json'), 'utf8')) as RebuttalEventSet;
    expect(stored).toEqual(result);
  });

  it('reserves the final chair and planner calls', async () => {
    const prompts: string[] = [];
    const run = ctx(prompts, 2);
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);

    const result = await s8bRebuttal(run, conflict, verified());

    expect(result).toMatchObject({ events: [], stop_reason: 'BUDGET_RESERVED' });
    expect(run.budget.used).toBe(0);
    expect(prompts).toEqual([]);
  });

  it('keeps the full two-call rebuttal after coverage fill and keeps quick mode at zero', async () => {
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const councilPrompts: string[] = [];
    const council = ctx(councilPrompts);
    council.attemptedStages.push('S7-coverage-fill');

    const capped = await s8bRebuttal(council, conflict, verified());
    expect(council.budget.used).toBe(2);
    expect(capped).toMatchObject({ stop_reason: 'ROUND_COMPLETE' });
    expect(councilPrompts).toHaveLength(2);

    const quickPrompts: string[] = [];
    const quick = ctx(quickPrompts);
    const skipped = await s8bRebuttal(quick, conflict, verified(), 'quick');
    expect(skipped).toMatchObject({ events: [], stop_reason: 'NO_ESCALATIONS' });
    expect(quickPrompts).toEqual([]);
  });
});

describe('R5 chair guards', () => {
  it('excludes every node authored by the judge from adjudication', () => {
    const selfAuthored = graph([
      { provider: 'claude', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    expect(adjudicableClaimIds(selfAuthored, ['G1'], 'claude')).toEqual([]);
    const prompt = buildJudgePrompt(
      { task: 'evaluate the fee', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: [] },
      selfAuthored,
      { verifications: [{
        claim_id: 'G1', status: 'PARTIAL', reasoning: 'The cost evidence conflicts.',
        evidence_ids: ['claude/E1', 'codex/E1'], missing_evidence: ['normalized costs'],
      }] },
      [{ id: 'R8', label: 'business model', keywords: ['fee'] }],
      undefined,
      'claude',
    );
    expect(prompt).toContain('ESCALATED CLAIMS + VERIFICATION: []');
    expect(prompt).toContain('UNRESOLVED_SELF_AUTHORED');
  });

  it('requires graph-linked pivot and strongest counter-case fields', () => {
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const base = {
      adjudications: [],
      verdict: 'Pivot to a narrower employment model.',
      recommendation: 'PIVOT' as const,
      dissent: ['The original model may work if benefit costs are lower.'],
      confidence_notes: 'Medium.',
      recommendation_claim_ids: ['G1'],
    };

    expect(chairRecommendationIssues(base, conflict, verified()).join(' ')).toMatch(/pivot|counter/i);
    expect(chairRecommendationIssues({
      ...base,
      pivot: { changed_claim_id: 'G1', new_risk_claim_id: 'G999' },
      strongest_counter_case: { claim_ids: ['G999'], reasoning: 'The original fee may still cover costs.' },
    }, conflict, verified()).join(' ')).toMatch(/unknown/i);

    const withPivotRisk = structuredClone(conflict);
    withPivotRisk.claims.push({ ...withPivotRisk.claims[0]!, id: 'G2', proposition: 'A narrower model adds contractor-classification risk.' });
    expect(chairRecommendationIssues({
      ...base,
      pivot: { changed_claim_id: 'G1', new_risk_claim_id: 'G2' },
      strongest_counter_case: { claim_ids: ['G1'], reasoning: 'The original fee may still cover costs.' },
    }, withPivotRisk, verified())).toEqual([]);
  });

  it('rejects decision-summary numbers that are not anchored to a graph claim', () => {
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const report = {
      adjudications: [],
      recommendation: 'PROCEED' as const,
      recommendation_claim_ids: ['G1'],
      strongest_counter_case: { claim_ids: ['G1'], reasoning: 'The fee may still fail.' },
      decision_snapshot: {
        decisive_numbers: [{ label: 'Monthly margin', value: '$10k', meaning: 'Positive.', claim_ids: ['G999'] }],
        options: [
          { label: 'Proceed', commitment: '$10k', commitment_kind: 'KNOWN' as const, tradeoff: 'Spend now.', claim_ids: ['G999'] },
          { label: 'Wait', commitment: 'Unknown', commitment_kind: 'UNKNOWN' as const, tradeoff: 'Delay learning.', claim_ids: [] },
        ],
      },
    };

    expect(chairRecommendationIssues(report, conflict, verified()).join(' ')).toContain('unknown decision snapshot claim id: G999');
  });

  it('refuses STOP without a failed load-bearing graph node', () => {
    const conflict = graph([
      { provider: 'agy', stance: 'SUPPORT' },
      { provider: 'codex', stance: 'OPPOSE' },
    ]);
    const report = {
      adjudications: [],
      recommendation: 'STOP' as const,
      recommendation_claim_ids: ['G1'],
      strongest_counter_case: { claim_ids: ['G1'], reasoning: 'The fee may still work with a narrower cost base.' },
    };
    expect(chairRecommendationIssues(report, conflict, verified()).join(' ')).toContain('failed load-bearing');
    expect(chairRecommendationIssues(report, conflict, {
      verifications: [{ ...verified().verifications[0]!, status: 'CONTRADICTED' }],
    })).toEqual([]);
  });
});
