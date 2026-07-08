import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { s9bPlan } from '../src/orchestration/stages/s9b-plan.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, RunResultAdapter } from '../src/providers/types.js';
import type { DisagreementMap, IntentContract, JudgeReport } from '../src/schemas/index.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';

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
    assumptions: [],
    attacks: [],
    open_questions: ['Which target user has this pain?'],
  },
}];

const map: DisagreementMap = {
  consensus: [],
  unique: [{ id: 'C1', statement: 'developers will pay for local orchestration', type: 'JUDGMENT', providers: ['agy'] }],
  contradictions: [{ id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'codex', argument: 'payment willingness is unproven', severity: 'HIGH' }] }],
  blind_spots: ['business model / monetization'],
};

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
  it('writes a valid anchored planner result', async () => {
    const ctx = makeCtx(() => ok(goodPlan));
    const plan = await s9bPlan(ctx, contract, seats, map, judge);
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
    const plan = await s9bPlan(ctx, contract, seats, map, judge);
    expect(plan.actions[0]!.validates).toBe('D1');
    expect(ctx.calls).toHaveLength(2);
    expect(prompts[1]).toContain('Valid dispute ids: D1');
  });

  it('skips the planner when fewer than two calls remain', async () => {
    const ctx = makeCtx(() => ok(goodPlan), 1);
    const plan = await s9bPlan(ctx, contract, seats, map, judge);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.flags.has('plan_skipped')).toBe(true);
    expect(plan.actions[0]!.validates).toBe('D1');
  });

  it('falls back when the planner call crashes', async () => {
    const ctx = makeCtx(() => ({ ok: false, error: 'CRASH', stderrTail: 'boom', durationMs: 1 }));
    const plan = await s9bPlan(ctx, contract, seats, map, judge);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.flags.has('plan_fallback')).toBe(true);
    expect(plan.actions[0]!.validates).toBe('D1');
  });
});
