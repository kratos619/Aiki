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
    reader_brief: {
      headline: 'Validate demand before building the local council',
      bottom_line: 'The architecture is plausible, but the user need is still an assumption.',
      sections: [
        { heading: 'Product direction', summary: 'Keep the first workflow narrow.', bullets: ['Focus on one high-value decision path.'] },
        { heading: 'Validation', summary: 'Test whether developers feel the pain.', bullets: ['Interview five target developers.'] },
      ],
      next_step: 'Interview five target developers before implementation.',
      caveats: ['This is a single-analyst recommendation.'],
      source_ids: [],
    },
  },
};

const cleanFastDecision = {
  ...quickDecision,
  analysis: {
    ...quickDecision.analysis,
    positions: [{ ...quickDecision.analysis.positions[0]!, if_false: 'CONDITION' as const }],
  },
};

const gatedDecision = {
  ...cleanFastDecision,
  analysis: {
    ...cleanFastDecision.analysis,
    positions: [{
      ...cleanFastDecision.analysis.positions[0]!,
      basis: 'EVIDENCE' as const,
      evidence_ids: ['E1'],
    }],
    evidence: [{
      id: 'E1',
      claim_supported: 'Developers need cross-model review.',
      source_kind: 'USER' as const,
      support: 'CONTRADICTS' as const,
      freshness: 'CURRENT' as const,
      locator: 'user-supplied demand notes',
    }],
  },
};

function adapter(prompts: string[], decision = quickDecision): Adapter {
  return {
    id: 'claude',
    run: async (request): Promise<RunResultAdapter> => {
      prompts.push(request.prompt);
      const value = request.prompt.includes('TWO-VIEW PREFLIGHT') ? preflightReading : decision;
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

async function runQuick(decision = quickDecision, fastPath = false) {
  const prompts: string[] = [];
  const id: ProviderId = 'claude';
  const handle: ProviderHandle = {
    id,
    adapter: adapter(prompts, decision),
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
    autoDecision: fastPath
      ? { resolved: 'quick', reasons: ['plain single-decision prompt'], fast_path: true }
      : undefined,
  });
  return { prompts, ctx, outcome: await executeRun(ctx, INPUT, runIdeaRefinement) };
}

async function runAutoAdaptive(mode: 'quick' | 'council', fastPath: boolean) {
  const prompts: string[] = [];
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles: ProviderHandle[] = ids.map((id) => ({
    id,
    adapter: {
      id,
      run: async (request): Promise<RunResultAdapter> => {
        prompts.push(request.prompt);
        const value = request.prompt.includes('TWO-VIEW PREFLIGHT')
          ? preflightReading
          : request.prompt.includes('Independent delta challenger')
            ? {
                deltas: [{
                  claimId: 'G1', response: 'COUNTER',
                  reasoning: 'The supplied demand note contradicts the proposition.',
                  newEvidenceIds: ['E1'], changedDecisionImpact: 'Keep demand unresolved.',
                }],
              }
            : gatedDecision;
        return { ok: true, text: JSON.stringify(value), json: value, durationMs: 1 };
      },
    },
    flags: { id, jsonOutput: true, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  }));
  const runId = `20260719-1200-idea-refinement-auto-${mode}`;
  const writer = new RunWriter(runId, root);
  const ctx = new RunCtx({
    runId,
    workflow: 'idea-refinement',
    mode,
    handles,
    roles: resolveRoles('idea-refinement', ids),
    writer,
    cwd: writer.dir,
    autoDecision: {
      resolved: mode,
      reasons: mode === 'quick' ? ['plain single-decision prompt'] : ['research wording detected'],
      ...(fastPath ? { fast_path: true } : {}),
    },
  });
  return { prompts, outcome: await executeRun(ctx, INPUT, runIdeaRefinement) };
}

describe('R6 quick mode', () => {
  it('runs with one provider, spends three calls, and never presents itself as a council', async () => {
    const { prompts, outcome } = await runQuick();

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(3);
    expect(prompts.filter((prompt) => prompt.includes('TWO-VIEW PREFLIGHT'))).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.includes('ROLE: Single decision analyst'))).toHaveLength(1);
    expect(prompts.join('\n')).not.toContain('ROLE: Judge');

    const report = await readFile(join(outcome.dir, 'final-report.md'), 'utf8');
    expect(report).toContain('# Validate demand before building the local council');
    expect(report).toContain('## Council audit');
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

  it('auto fast path spends one call and renders the honest single-pass label', async () => {
    const { prompts, outcome } = await runQuick(cleanFastDecision, true);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(1);
    expect(prompts.filter((prompt) => prompt.includes('TWO-VIEW PREFLIGHT'))).toHaveLength(0);
    expect(prompts.filter((prompt) => prompt.includes('ROLE: Single decision analyst'))).toHaveLength(1);

    const report = await readFile(join(outcome.dir, 'final-report.md'), 'utf8');
    expect(report).toContain('Single-pass analysis; council escalation was not required.');

    const meta = JSON.parse(await readFile(join(outcome.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      mode: 'quick',
      call_count: 1,
      receipt: { discovery: 1, verification: 0, repair: 0, planning: 0 },
      auto_decision: { resolved: 'quick', fast_path: true },
    });
  });

  it('gated auto fast path fails over to preflight and one targeted challenger', async () => {
    const { prompts, outcome } = await runAutoAdaptive('quick', true);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(4);
    expect(prompts.filter((prompt) => prompt.includes('TWO-VIEW PREFLIGHT'))).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.includes('ROLE: Single decision analyst'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('Independent delta challenger'))).toHaveLength(1);

    const report = await readFile(join(outcome.dir, 'final-report.md'), 'utf8');
    expect(report).not.toContain('Single-pass analysis; council escalation was not required.');
    expect(report).toContain('Adaptive escalation: user-supplied evidence contradicts a load-bearing claim');
    expect(report).toContain('No full council was convened.');

    const meta = JSON.parse(await readFile(join(outcome.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      mode: 'quick',
      call_count: 4,
      receipt: { discovery: 3, verification: 1, repair: 0, planning: 0 },
      auto_decision: {
        resolved: 'quick',
        fast_path: true,
        escalation_reasons: ['user-supplied evidence contradicts a load-bearing claim'],
      },
    });
  });

  it('auto standard path uses preflight, one primary analyst, and at most one challenger', async () => {
    const { prompts, outcome } = await runAutoAdaptive('council', false);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(4);
    expect(prompts.filter((prompt) => prompt.includes('TWO-VIEW PREFLIGHT'))).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt.includes('ROLE: Primary decision analyst'))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes('Independent delta challenger'))).toHaveLength(1);
    expect(prompts.join('\n')).not.toContain('ROLE: Judge');
  });

  it('keeps a valid quick answer when its only validation action is unanchored', async () => {
    const decision = {
      ...quickDecision,
      action_plan: {
        ...quickDecision.action_plan,
        actions: [{ ...quickDecision.action_plan.actions[0]!, validates: 'P404' }],
      },
    };

    const { outcome } = await runQuick(decision);

    expect(outcome.ok).toBe(true);
    const plan = JSON.parse(await readFile(join(outcome.dir, '09b-action-plan.json'), 'utf8'));
    expect(plan).toMatchObject({ actions: [], reader_brief: quickDecision.action_plan.reader_brief });
    const meta = JSON.parse(await readFile(join(outcome.dir, 'meta.json'), 'utf8'));
    expect(meta.flags ?? []).not.toContain('plan_fallback');
  });
});
