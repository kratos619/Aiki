import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, resolveRoles, type ProviderHandle, type RunEvents } from '../src/orchestration/context.js';
import { preflight } from '../src/orchestration/preflight.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

const INPUT = 'Decide whether to build a local model council.';
const RUBRIC = ['target user', 'competition', 'feasibility'];

const reading = {
  subject: 'local model council',
  interpretation: 'decide whether to build a local model council',
  normalized_decision: 'decide whether to build a local model council',
  alternatives: ['build', 'stop'],
  target_user: 'developers',
  constraints: [],
  success_bar: 'a clear go or no-go recommendation',
  success_criteria: ['clear recommendation'],
  claims_to_test: ['developers need it'],
  evidence_supplied: [],
  missing_evidence: ['user interviews'],
  domain_dimensions: [
    { id: 'D1', label: 'provider interoperability', rationale: 'The tools must work together.' },
    { id: 'D2', label: 'workflow adoption', rationale: 'Developers must use it.' },
    { id: 'D3', label: 'output comparability', rationale: 'Outputs must be comparable.' },
  ],
  questions: [
    { id: 'Q1', axis: 'decision_frame', question: 'Is this go/no-go?', why_it_matters: 'It fixes scope.', suggested_answers: ['Yes', 'No'] },
    { id: 'Q2', axis: 'target_user', question: 'Who is first?', why_it_matters: 'It changes demand.', suggested_answers: ['Solo', 'Teams'] },
    { id: 'Q3', axis: 'success_bar', question: 'What proves value?', why_it_matters: 'It sets the bar.', suggested_answers: ['Recall', 'Cost'] },
  ],
};

function handle(id: ProviderId, calls: string[]): ProviderHandle {
  const adapter: Adapter = {
    id,
    run: async (request): Promise<RunResultAdapter> => {
      calls.push(request.prompt);
      return { ok: true, text: JSON.stringify(reading), json: reading, durationMs: 1 };
    },
  };
  return {
    id,
    adapter,
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-preflight-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(events?: RunEvents) {
  const calls: string[] = [];
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles = ids.map((id) => handle(id, calls));
  const writer = new RunWriter('20260713-2000-idea-refinement-pf00', root);
  await writer.init();
  const ctx = new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles,
    roles: resolveRoles('idea-refinement', ids),
    writer,
    cwd: writer.dir,
    events,
  });
  return { ctx, calls, result: await preflight(ctx, INPUT, RUBRIC) };
}

describe('R6 two-view preflight', () => {
  it('runs two readings in parallel and persists one user-confirmed contract', async () => {
    const { calls, result, ctx } = await run({
      grill: async (draft) => draft.questions.map((question) => ({ question_id: question.id, answer: `answer ${question.id}`, source: 'user' })),
    });

    expect(calls).toHaveLength(2);
    expect(result.contract).toMatchObject({ user_confirmed: true, confirmation: 'user-confirmed', core_rubric: RUBRIC });
    expect(ctx.flags.has('headless_intent')).toBe(false);
    const artifact = JSON.parse(await readFile(join(ctx.writer.dir, '02-preflight-readings.json'), 'utf8'));
    expect(artifact.readings).toHaveLength(2);
    expect(artifact.chosen.how).toBe('single-cluster');
  });

  it('marks a headless/defaulted contract explicitly', async () => {
    const { result, ctx } = await run();
    expect(result.contract).toMatchObject({ user_confirmed: false, confirmation: 'headless-defaulted' });
    expect(ctx.flags.has('headless_intent')).toBe(true);
  });
});
