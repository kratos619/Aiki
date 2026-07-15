import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

const INPUT = 'Decide whether to build a read-only local model council for developers.';

const preflightReading = {
  subject: 'local model council',
  interpretation: 'decide whether to build a read only local model council for developers',
  normalized_decision: 'decide whether to build a read only local model council for developers',
  alternatives: ['build it', 'do not build it'],
  target_user: 'developers',
  constraints: ['read-only'],
  success_bar: 'a defensible go or no-go decision',
  success_criteria: ['clear recommendation'],
  claims_to_test: ['developers need cross-model review'],
  evidence_supplied: [],
  missing_evidence: ['user interviews'],
  domain_dimensions: [
    { id: 'D1', label: 'provider interoperability', rationale: 'Installed CLIs must interoperate.' },
    { id: 'D2', label: 'workflow adoption', rationale: 'Developers must adopt the workflow.' },
    { id: 'D3', label: 'output comparability', rationale: 'Outputs must be comparable.' },
  ],
  questions: [
    { id: 'Q1', axis: 'decision_frame', question: 'Is this a build decision?', why_it_matters: 'It fixes scope.', suggested_answers: ['Yes', 'No'] },
    { id: 'Q2', axis: 'target_user', question: 'Who is first?', why_it_matters: 'It changes adoption risk.', suggested_answers: ['Solo developers', 'Teams'] },
    { id: 'Q3', axis: 'success_bar', question: 'What proves value?', why_it_matters: 'It sets the bar.', suggested_answers: ['Higher recall', 'Lower cost'] },
  ],
};

const quickDecision = {
  analysis: {
    task_echo: 'decide whether to build a read only local model council for developers',
    strongest_version: 'A focused local tool compares existing subscriptions without handling credentials.',
    positions: [{
      local_id: 'P1', proposition: 'Developers need cross-model review.', dimension_id: 'R1',
      stance: 'MIXED', basis: 'ASSUMPTION', load_bearing: true, if_false: 'STOP',
      reasoning: 'The prompt states the need but supplies no user evidence.', evidence_ids: [], depends_on: [],
    }],
    evidence: [],
    calculations: [],
    coverage: [{ dimension_id: 'R1', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 addresses the target user need.' }],
    decision_questions: [{ id: 'Q1', question: 'Will developers use a separate council CLI?', claim_ids: ['P1'] }],
  },
  verdict: 'Proceed only to a small demand test; the core user need is not yet evidenced.',
  recommendation: 'PROCEED_WITH_CONDITIONS',
  conditions: ['Validate demand before implementation.'],
  key_points: ['The workflow is technically plausible.', 'Demand remains an assumption.'],
  dissent: ['A single strong model may already be sufficient.'],
  confidence_notes: 'Low-to-medium because this is one analyst without independent verification.',
  action_plan: {
    actions: [{
      order: 1,
      action: 'Interview five target developers.',
      why: 'Test the load-bearing demand claim.',
      validates: 'P1',
      effort: 'S',
      kill_signal: 'Fewer than two describe the pain unprompted.',
    }],
    sequencing_note: 'Test demand before building.',
  },
};

function adapter(prompts: string[]): Adapter {
  return {
    id: 'claude',
    run: async (request): Promise<RunResultAdapter> => {
      prompts.push(request.prompt);
      const value = request.prompt.includes('TWO-VIEW PREFLIGHT') ? preflightReading : quickDecision;
      return { ok: true, text: JSON.stringify(value), json: value, durationMs: 1 };
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-r6-quick-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R6 quick mode', () => {
  it('runs with one provider, spends three calls, and never presents itself as a council', async () => {
    const prompts: string[] = [];
    const id: ProviderId = 'claude';
    const handle: ProviderHandle = {
      id,
      adapter: adapter(prompts),
      flags: { id, jsonOutput: true, readOnlyFlag: 'plan' },
      readOnly: 'plan',
      version: 'test',
    };
    const runId = '20260713-1900-idea-refinement-r6qq';
    const writer = new RunWriter(runId, root);
    const ctx = new RunCtx({
      runId,
      workflow: 'idea-refinement',
      mode: 'quick',
      handles: [handle],
      roles: resolveRoles('idea-refinement', [id]),
      writer,
      cwd: writer.dir,
    });

    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(3);
    expect(prompts.filter((prompt) => prompt.includes('TWO-VIEW PREFLIGHT'))).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.includes('ROLE: Single decision analyst'))).toHaveLength(1);
    expect(prompts.join('\n')).not.toContain('ROLE: Judge');

    const report = await readFile(join(outcome.dir, 'final-report.md'), 'utf8');
    expect(report).toContain('# Single-Model Decision Report');
    expect(report).toContain('no council, consensus, or independent-verification claim');
    expect(report).not.toContain('# Multi-Model Decision Report');

    const meta = JSON.parse(await readFile(join(outcome.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      mode: 'quick',
      call_count: 3,
      budget: { limit: 4, used: 3 },
      receipt: { discovery: 3, verification: 0, repair: 0, planning: 0 },
    });
    expect(meta.flags).toEqual(expect.arrayContaining(['single_model', 'low_diversity', 'headless_intent']));
  });
});
