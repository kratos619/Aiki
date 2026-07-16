import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import {
  IDEA_MODE_PLANS,
  callCategory,
  defaultBudgetFor,
  defaultDeadlineFor,
  inferIdeaMode,
} from '../src/orchestration/modes.js';
import {
  mergePreflightReadings,
  type ProviderPreflightReading,
} from '../src/orchestration/preflight.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

const reading = (provider: ProviderId, decision: string): ProviderPreflightReading => ({
  provider,
  reading: {
    subject: 'local model council',
    interpretation: decision,
    normalized_decision: decision,
    alternatives: ['build it', 'do not build it'],
    target_user: 'developers',
    constraints: ['read-only'],
    success_bar: 'a defensible go/no-go decision',
    success_criteria: ['clear recommendation'],
    claims_to_test: ['developers need the workflow'],
    evidence_supplied: [],
    missing_evidence: ['user interviews'],
    domain_dimensions: [
      { id: 'D1', label: 'provider interoperability', rationale: 'The CLIs must work together.' },
      { id: 'D2', label: 'workflow adoption', rationale: 'Developers must use it.' },
      { id: 'D3', label: 'output comparability', rationale: 'Outputs must be comparable.' },
    ],
    questions: [
      { id: 'Q1', axis: 'decision_frame', question: 'Is this a go/no-go decision?', why_it_matters: 'It fixes the decision.', suggested_answers: ['Yes', 'No'] },
      { id: 'Q2', axis: 'target_user', question: 'Who is first?', why_it_matters: 'It changes adoption risk.', suggested_answers: ['Solo developers', 'Teams'] },
      { id: 'Q3', axis: 'success_bar', question: 'What proves value?', why_it_matters: 'It sets the bar.', suggested_answers: ['Better recall', 'Lower cost'] },
    ],
    requested_outputs: [],
  },
});

function adapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (): Promise<RunResultAdapter> => ({ ok: true, text: '{}', json: {}, durationMs: 1 }),
  };
}

function handle(id: ProviderId): ProviderHandle {
  return {
    id,
    adapter: adapter(id),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-r6-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R6 mode call plans', () => {
  it('keeps quick cheap and makes council/research exact aliases', () => {
    const fullCouncil = {
      baseCalls: 6, optionalCalls: 4, maxCalls: 10, reservedCalls: 2,
      defaultBudget: 12, deadlineMs: 45 * 60 * 1000,
    };
    expect(IDEA_MODE_PLANS.quick).toMatchObject({ baseCalls: 3, optionalCalls: 0, maxCalls: 3, reservedCalls: 0 });
    expect(IDEA_MODE_PLANS.council).toEqual(fullCouncil);
    expect(IDEA_MODE_PLANS.research).toEqual(fullCouncil);
    expect(defaultBudgetFor('idea-refinement', 'quick')).toBe(4);
    expect(defaultBudgetFor('idea-refinement', 'council')).toBe(12);
    expect(defaultBudgetFor('idea-refinement', 'research')).toBe(12);
  });

  it('gives both full-council aliases the research wall-clock; quick/code-review stay at 20 minutes', () => {
    expect(defaultDeadlineFor('idea-refinement', 'quick')).toBe(20 * 60 * 1000);
    expect(defaultDeadlineFor('idea-refinement', 'council')).toBe(45 * 60 * 1000);
    expect(defaultDeadlineFor('idea-refinement', 'research')).toBe(45 * 60 * 1000);
    expect(defaultDeadlineFor('code-review')).toBe(20 * 60 * 1000);
    expect(defaultDeadlineFor('idea-refinement', 'research')).toBe(defaultDeadlineFor('idea-refinement', 'council'));
  });

  it('classifies the receipt into discovery, verification, repair, and planning', () => {
    expect(callCategory('P0-agy')).toBe('discovery');
    expect(callCategory('S4-codex')).toBe('discovery');
    expect(callCategory('S8')).toBe('verification');
    expect(callCategory('S9')).toBe('verification');
    expect(callCategory('S4-codex-repair')).toBe('repair');
    expect(callCategory('S9b-plan')).toBe('planning');
  });

  it('uses one full-council mode regardless of research wording', () => {
    expect(inferIdeaMode('Do some research and check the links before planning this.')).toBe('council');
    expect(inferIdeaMode('Look up the current hackathon rules.')).toBe('council');
    expect(inferIdeaMode('Improve this product plan and do some reserach before brainstorming.')).toBe('council');
    expect(inferIdeaMode('Here is our package: https://npmjs.com/package/aiki-cli')).toBe('council');
    expect(inferIdeaMode('Stress-test this product idea.')).toBe('council');
  });

  it.each(['council', 'research'] as const)('uses the 45-minute default inside a %s RunCtx', (mode) => {
    let now = 0;
    const writer = new RunWriter(`20260716-2200-idea-refinement-${mode}`, root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode,
      handles: ['agy', 'codex', 'claude'].map((id) => handle(id as ProviderId)),
      roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
      now: () => now,
    });

    now = 20 * 60 * 1000 + 1;
    expect(() => ctx.guard()).not.toThrow();
    now = 45 * 60 * 1000 + 1;
    expect(() => ctx.guard()).toThrow(/45|2700000/);
  });

  it('never enables source investigation for code-review S4 calls', async () => {
    let research: boolean | undefined;
    const codex = handle('codex');
    codex.adapter.run = async (request): Promise<RunResultAdapter> => {
      research = request.research;
      return { ok: true, text: '{}', json: {}, durationMs: 1 };
    };
    const writer = new RunWriter('20260716-2200-code-review-alias', root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'code-review',
      handles: [codex, handle('claude'), handle('agy')],
      roles: { analyst: 'codex', judge: 'agy', verifier: 'claude', s4: ['codex', 'claude'] },
      writer,
      cwd: writer.dir,
    });

    await ctx.call(codex, { prompt: 'review', expectJson: true }, 'S4-codex');

    expect(research).toBe(false);
  });

  it('reserves chair + planner before any optional council call', async () => {
    const writer = new RunWriter('20260713-1800-idea-refinement-r6aa', root);
    await writer.init();
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode: 'council',
      handles: ['agy', 'codex', 'claude'].map((id) => handle(id as ProviderId)),
      roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
      budget: 6,
    });

    for (const [index, id] of (['agy', 'codex', 'agy', 'codex'] as ProviderId[]).entries()) {
      await ctx.call(ctx.handle(id), { prompt: `discovery ${index}`, expectJson: true }, `S4-${id}-${index}`);
    }

    expect(ctx.optionalCallsRemaining()).toBe(0);
    expect(ctx.receipt()).toEqual({ discovery: 4, verification: 0, repair: 0, planning: 0 });
  });
});

describe('R6 preflight merge', () => {
  it('combines two readings deterministically without model-authored prompt generation', () => {
    const merged = mergePreflightReadings([
      reading('agy', 'Decide whether to build the local model council.'),
      reading('codex', 'Decide whether the local model council is worth building.'),
    ]);

    expect(merged.clusters).toHaveLength(1);
    expect(merged.draft.questions).toHaveLength(3);
    expect(merged.draft.domain_dimensions.map((item) => item.id)).toEqual(['D1', 'D2', 'D3']);
    expect(merged.alternatives).toEqual(['build it', 'do not build it']);
  });
});
