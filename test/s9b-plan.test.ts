import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { s9bPlan } from '../src/orchestration/stages/s9b-plan.js';
import { extractJson } from '../src/providers/adapter-core.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, RunResultAdapter } from '../src/providers/types.js';
import type { DisagreementMap, IntentContract, JudgeReport } from '../src/schemas/index.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';
import { renderReport } from '../src/orchestration/stages/s10-render.js';
import { adaptLegacyDecisionGraph } from '../src/orchestration/legacy-idea-adapter.js';

const contract: IntentContract = {
  task: 'stress-test a local AI orchestration CLI',
  task_type: 'idea-refinement',
  constraints: [],
  unknowns: [],
  success_criteria: ['clear verdict'],
};

const seats: SeatOutput[] = [{
  provider: 'agy',
  output: {
    workflow: 'idea-refinement',
    task_echo: 'stress-test a local AI orchestration CLI',
    strongest_version: 'A local council for high-stakes judgment calls.',
    positions: [],
    evidence: [],
    coverage: [],
    decision_questions: [{ id: 'Q1', question: 'Which target user has this pain?', claim_ids: [] }],
  },
}];

const map: DisagreementMap = {
  consensus: [],
  unique: [{ id: 'C1', statement: 'developers will pay for local orchestration', type: 'JUDGMENT', providers: ['agy'] }],
  contradictions: [{ id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'codex', argument: 'payment willingness is unproven', severity: 'HIGH' }] }],
  blind_spots: ['business model / monetization'],
};
const graph = adaptLegacyDecisionGraph(map);

const judge: JudgeReport = {
  adjudications: [{ id: 'D1', ruling: 'UPHOLD', reasoning: 'No evidence supports willingness to pay.', evidence_cited: 'D1' }],
  verdict: 'Proceed only after demand validation.',
  recommendation: 'PROCEED_WITH_CONDITIONS',
  conditions: ['Validate willingness to pay.'],
  dissent: ['Developers may pay if the workflow saves enough time.'],
  confidence_notes: 'HIGH on the demand risk.',
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-s9b-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ok(json: unknown): RunResultAdapter {
  return { ok: true, text: JSON.stringify(json), json, durationMs: 1 };
}

function makeCtx(responder: (prompt: string) => RunResultAdapter, budget = 12): RunCtx {
  const adapter: Adapter = {
    id: 'claude',
    run: async (req) => responder(req.prompt),
  };
  const handle: ProviderHandle = {
    id: 'claude',
    adapter,
    flags: { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' },
    readOnly: 'plan',
    version: '9.9.9',
  };
  const writer = new RunWriter(makeRunId('idea-refinement'), root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles: [handle],
    roles: { analyst: 'claude', judge: 'claude', verifier: 'claude', s4: ['claude'] },
    writer,
    cwd: writer.dir,
    budget,
  });
}

const goodPlan = {
  actions: [{
    order: 1,
    action: 'Run a pricing smoke test with 20 developers.',
    why: 'The chair upheld willingness to pay as a load-bearing risk.',
    validates: 'D1',
    effort: 'S',
    kill_signal: 'Fewer than 3 developers join a paid waitlist.',
  }],
  sequencing_note: 'Demand comes first because it can kill the idea cheapest.',
};

describe('s9bPlan', () => {
  it('salvages the captured nurse plan without a repair call', async () => {
    const fixtures = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build', '02-nurse-marketplace', 'regression');
    const raw = await readFile(join(fixtures, '09b-first.out'), 'utf8');
    const json = extractJson(raw);
    expect(json).toBeDefined();
    const nurseMap = JSON.parse(await readFile(join(fixtures, '07-disagreement-map.json'), 'utf8')) as DisagreementMap;
    const nurseGraph = adaptLegacyDecisionGraph(nurseMap);
    const nurseJudge = JSON.parse(await readFile(join(fixtures, '09-judge-report.json'), 'utf8')) as JudgeReport;
    const ctx = makeCtx(() => ({ ok: true, text: raw, json, durationMs: 1 }));

    const plan = await s9bPlan(ctx, { ...contract, task: 'evaluate a nurse shift marketplace' }, [], nurseGraph, nurseJudge);

    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]?.stage).toBe('S9b-plan');
    expect(ctx.flags.has('plan_fallback')).toBe(false);
    expect(plan.actions).toHaveLength(7);
    expect(plan.actions.map((a) => a.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.actions[0]?.action).toContain('per-worked-hour P&L spreadsheet');
    expect(plan.actions[6]?.validates).toBe('blind:kill criteria');
  });

  it('normalizes captured planner timeboxes into S, M, and L effort', async () => {
    const fixtures = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build', '02-nurse-marketplace', 'regression');
    const raw = await readFile(join(fixtures, '09b-repair.out'), 'utf8');
    const json = extractJson(raw);
    const nurseMap = JSON.parse(await readFile(join(fixtures, '07-disagreement-map.json'), 'utf8')) as DisagreementMap;
    const nurseGraph = adaptLegacyDecisionGraph(nurseMap);
    const nurseJudge = JSON.parse(await readFile(join(fixtures, '09-judge-report.json'), 'utf8')) as JudgeReport;
    const ctx = makeCtx(() => ({ ok: true, text: raw, json, durationMs: 1 }));

    const plan = await s9bPlan(ctx, { ...contract, task: 'evaluate a nurse shift marketplace' }, [], nurseGraph, nurseJudge);

    expect(ctx.calls).toHaveLength(1);
    expect(plan.actions.map((a) => a.effort)).toEqual(['S', 'M', 'M', 'M', 'L', 'S', 'S']);
  });

  it('writes a valid anchored planner result', async () => {
    const ctx = makeCtx(() => ok(goodPlan));
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(plan.actions[0]).toMatchObject({ validates: 'D1' });
    expect(ctx.calls).toHaveLength(1);
    await expect(readFile(join(ctx.writer.dir, '09b-action-plan.json'), 'utf8')).resolves.toContain('pricing smoke test');
  });

  it('drops unanchored actions and repairs once', async () => {
    const prompts: string[] = [];
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      if (prompt.includes('previous plan had no actions with valid anchors')) return ok(goodPlan);
      return ok({ ...goodPlan, actions: [{ ...goodPlan.actions[0], validates: 'D9' }] });
    });
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(plan.actions[0]!.validates).toBe('D1');
    expect(ctx.calls).toHaveLength(2);
    expect(prompts[1]).toContain('Valid graph claim ids: D1');
  });

  it('uses the one reserved planner call without requiring repair headroom', async () => {
    const ctx = makeCtx(() => ok(goodPlan), 1);
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.flags.has('plan_skipped')).toBe(false);
    expect(plan).toEqual(goodPlan);
  });

  it('records explicit unavailability when the planner call crashes', async () => {
    const ctx = makeCtx(() => ({ ok: false, error: 'CRASH', stderrTail: 'boom', durationMs: 1 }));
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.flags.has('plan_fallback')).toBe(true);
    expect(plan).toEqual({
      kind: 'PlannerUnavailable',
      reason: 'planner_failed',
      unresolved_questions: ['Which target user has this pain?'],
    });
  });

  it('renders planner unavailability and its flag inside the validation section', () => {
    const ctx = makeCtx(() => ok(goodPlan));
    ctx.addFlag('plan_fallback');
    const report = renderReport(ctx, {
      contract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: judge,
      actionPlan: {
        kind: 'PlannerUnavailable',
        reason: 'planner_failed',
        unresolved_questions: ['Which target user has this pain?'],
      },
    });
    const section = report.slice(report.indexOf('## 2. Action plan'), report.indexOf('## 3.'));

    expect(section).toContain('plan_fallback');
    expect(section).toContain('Planner unavailable: planner_failed');
    expect(section).toContain('Which target user has this pain?');
  });

  it('renders synthesis_suspect beside the chairman reasoning', () => {
    const ctx = makeCtx(() => ok(goodPlan));
    ctx.addFlag('synthesis_suspect');
    const report = renderReport(ctx, {
      contract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: { ...judge, key_points: ['Demand is the decisive uncertainty.'] },
      actionPlan: goodPlan,
    });
    const section = report.slice(report.indexOf('## 1. Decision'), report.indexOf('## 2.'));

    expect(section).toContain('synthesis_suspect');
  });
});
