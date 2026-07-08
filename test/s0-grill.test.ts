import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, resolveRoles, type ProviderHandle, type RunEvents } from '../src/orchestration/context.js';
import { renderGrilledInput, s0Grill } from '../src/orchestration/stages/s0-grill.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import { RunWriter } from '../src/storage/runs.js';

const INPUT = 'aiki: local CLI that turns installed AI CLIs into a structured council';

const draft = {
  subject: 'local AI CLI council',
  decision_frame: 'decide whether to build the tool as specified',
  evaluation_lens: 'developer-tool viability and risk',
  target_user: 'developers already paying for multiple AI subscriptions',
  constraints: ['no API keys', 'read-only'],
  claims_to_test: ['1.3x bug-catch rate'],
  evidence_supplied: ['benchmark claim in prompt'],
  missing_axes: ['pricing'],
  questions: [
    {
      id: 'Q1',
      axis: 'decision_frame' as const,
      question: 'What decision should the council help you make?',
      why_it_matters: 'The answer changes whether the judge optimizes for build/no-build or positioning.',
      suggested_answers: ['Decide build/no-build', 'Find risks first'],
    },
    {
      id: 'Q2',
      axis: 'target_user' as const,
      question: 'Which user segment should be treated as primary?',
      why_it_matters: 'The risks differ by buyer and workflow.',
      suggested_answers: ['Solo senior developers', 'Engineering teams'],
    },
    {
      id: 'Q3',
      axis: 'success_bar' as const,
      question: 'What would count as a useful result?',
      why_it_matters: 'The judge needs a concrete success bar.',
      suggested_answers: ['Clear go/no-go recommendation', 'Validation plan only'],
    },
  ],
};

function adapter(counter: { n: number }): Adapter {
  return {
    id: 'agy',
    run: async (): Promise<RunResultAdapter> => {
      counter.n++;
      return { ok: true, text: JSON.stringify(draft), json: draft, durationMs: 1 };
    },
  };
}

let root: string;

function makeCtx(counter: { n: number }, events?: RunEvents): RunCtx {
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles: ProviderHandle[] = ids.map((id) => ({
    id,
    adapter: id === 'agy' ? adapter(counter) : adapter({ n: 0 }),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: '9.9.9',
  }));
  const runId = makeRunId('idea-refinement');
  const writer = new RunWriter(runId, root);
  return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles: resolveRoles('idea-refinement', ids), writer, cwd: writer.dir, events });
}

describe('S0 contextual grill', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-grill-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('uses the analyst once, asks the TUI seam for answers, and persists a run brief', async () => {
    const calls = { n: 0 };
    const ctx = makeCtx(calls, {
      grill: async (brief) => brief.questions.map((q) => ({ question_id: q.id, answer: `answer for ${q.id}`, source: 'user' })),
    });
    await ctx.writer.init();
    await ctx.writer.writeText('original', INPUT);

    const brief = await s0Grill(ctx, INPUT);

    expect(calls.n).toBe(1);
    expect(brief.questions).toHaveLength(3);
    expect(brief.answers.map((a) => a.answer)).toEqual(['answer for Q1', 'answer for Q2', 'answer for Q3']);

    const persisted = JSON.parse(await readFile(join(ctx.writer.dir, '00b-run-brief.json'), 'utf8'));
    expect(persisted.answers).toHaveLength(3);
  });

  it('fills default answers in headless mode and renders them into the downstream input', async () => {
    const ctx = makeCtx({ n: 0 });
    await ctx.writer.init();
    await ctx.writer.writeText('original', INPUT);

    const brief = await s0Grill(ctx, INPUT);
    const enriched = renderGrilledInput(INPUT, brief);

    expect(brief.answers.every((a) => a.source === 'default')).toBe(true);
    expect(enriched).toContain('Aiki intent preflight');
    expect(enriched).toContain('What decision should the council help you make?');
    expect(enriched).toContain('Use best judgment from the supplied prompt.');
  });
});
