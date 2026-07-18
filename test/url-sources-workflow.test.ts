import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { recordIdeaOutcomeFlags, runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import type { DecisionContract, IdeaRoleOutput } from '../src/schemas/index.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-url-workflow-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function makeContext(mode: 'council' | 'research' = 'council'): RunCtx {
  const handles = (['agy', 'codex'] as ProviderId[]).map((id): ProviderHandle => ({
    id,
    adapter: { id, run: async () => ({ ok: true, text: '{}', json: {}, durationMs: 1 }) },
    flags: { id, jsonOutput: false, readOnlyFlag: 'sandbox' },
    readOnly: 'sandbox',
    version: 'test',
  }));
  const writer = new RunWriter(makeRunId('idea-refinement'), root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    mode,
    handles,
    roles: { analyst: 'agy', judge: 'codex', verifier: 'codex', s4: ['agy', 'codex'] },
    writer,
    cwd: writer.dir,
  });
}

const contract = {
  task: 'choose standout features', task_type: 'idea-refinement', constraints: [], unknowns: [],
  success_criteria: ['feature backlog'], alternatives: ['build'], success_bar: 'standout demo',
  evidence_supplied: [], missing_evidence: [], core_rubric: ['value'], user_confirmed: true,
  confirmation: 'user-confirmed', requested_outputs: ['DECISION', 'FEATURE_BACKLOG'],
} satisfies DecisionContract;

const preflightReading = {
  subject: 'hackathon rules', interpretation: 'research the current hackathon rules before deciding',
  normalized_decision: 'research the current hackathon rules before deciding', alternatives: ['proceed', 'stop'],
  target_user: 'developer', constraints: [], success_bar: 'a sourced decision', success_criteria: ['clear decision'],
  claims_to_test: ['the rules permit the plan'], evidence_supplied: [], missing_evidence: ['current rules'],
  domain_dimensions: [
    { id: 'D1', label: 'eligibility', rationale: 'Eligibility can stop the plan.' },
    { id: 'D2', label: 'submission', rationale: 'Submission rules shape delivery.' },
    { id: 'D3', label: 'judging', rationale: 'Judging shapes priorities.' },
  ],
  questions: [], requested_outputs: [],
};

function roleOutput(overrides: Partial<IdeaRoleOutput> = {}): IdeaRoleOutput {
  return {
    workflow: 'idea-refinement', task_echo: contract.task, strongest_version: 'focused product',
    positions: [], evidence: [], calculations: [], coverage: [], decision_questions: [],
    deliverable_proposals: [], ...overrides,
  };
}

describe('full-council source gate', () => {
  it('records missing requested proposals from surviving typed seats', () => {
    const ctx = makeContext('council');
    const output = roleOutput({ deliverable_proposals: [{ output: 'FEATURE_BACKLOG', title: 'Replay', detail: 'Replay runs', user_value: 'Trust', why_distinctive: 'Visible debate', evidence_ids: [] }] });
    const seats: SeatOutput[] = [
      { provider: 'agy', output },
      { provider: 'codex', output: { ...output, deliverable_proposals: [] } },
    ];

    recordIdeaOutcomeFlags(ctx, contract, seats);

    expect(ctx.flags).toContain('deliverable_gap');
  });

  it.each(['council', 'research'] as const)('%s marks source investigation ungrounded when current external evidence is uncited', (mode) => {
    const ctx = makeContext(mode);
    ctx.addFlag('source_fallback_search');
    const evidence = [{
      id: 'E1', claim_supported: 'Current rules require a live URL', source_kind: 'PRIMARY' as const,
      title: 'Current rules', url: 'https://example.com/rules', accessed_at: '2026-07-16',
      support: 'SUPPORTS' as const, freshness: 'CURRENT' as const,
    }];
    const seats: SeatOutput[] = [{ provider: 'codex', output: roleOutput({
      positions: [{ local_id: 'P1', proposition: 'A live URL is required', dimension_id: 'R1', stance: 'SUPPORT', basis: 'EVIDENCE', nature: 'FACTUAL', load_bearing: true, if_false: 'CONDITION', reasoning: 'Rules say so', evidence_ids: [], depends_on: [] }],
      evidence,
    }) }];

    recordIdeaOutcomeFlags(ctx, contract, seats);

    expect(ctx.flags).toContain('research_ungrounded');
    expect(ctx.flags).toContain('source_fallback_search');
  });

  it.each(['council', 'research'] as const)('%s stays grounded when a surviving position cites current external evidence', (mode) => {
    const ctx = makeContext(mode);
    ctx.addFlag('source_fallback_search');
    const evidence = [{
      id: 'E1', claim_supported: 'Current rules require a live URL', source_kind: 'PRIMARY' as const,
      title: 'Current rules', url: 'https://example.com/rules', accessed_at: '2026-07-16',
      support: 'SUPPORTS' as const, freshness: 'CURRENT' as const,
    }];
    const seats: SeatOutput[] = [{ provider: 'codex', output: roleOutput({
      positions: [{ local_id: 'P1', proposition: 'A live URL is required', dimension_id: 'R1', stance: 'SUPPORT', basis: 'EVIDENCE', nature: 'FACTUAL', load_bearing: true, if_false: 'CONDITION', reasoning: 'Rules say so', evidence_ids: ['E1'], depends_on: [] }],
      evidence,
    }) }];

    recordIdeaOutcomeFlags(ctx, contract, seats);

    expect(ctx.flags).not.toContain('research_ungrounded');
    expect(ctx.flags).toContain('source_fallback_search');
  });

  it('honors a CLI-provided snapshot without refetching (T10b: the user already approved it)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('must not fetch — snapshot was provided'); });
    let modelCalls = 0;
    const handles = (['agy', 'codex'] as ProviderId[]).map((id): ProviderHandle => ({
      id,
      adapter: { id, run: async () => (modelCalls++, { ok: true, text: '{}', json: {}, durationMs: 1 }) },
      flags: { id, jsonOutput: false, readOnlyFlag: 'sandbox' },
      readOnly: 'sandbox',
      version: 'test',
    }));
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode: 'council',
      handles,
      roles: { analyst: 'agy', judge: 'codex', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
      urlSources: { sources: [{ id: 'U1', url: 'https://example.com/hackathon', status: 'BLOCKED', accessed_at: '2026-07-17T00:00:00.000Z', error: 'HTTP 403' }] } as never,
    });

    const outcome = await executeRun(ctx, 'Research https://example.com/hackathon before deciding.', runIdeaRefinement);

    // The provided snapshot is authoritative: gate still stops (no override), zero fetches, zero model calls.
    expect(outcome.error?.code).toBe('SOURCE_UNREADABLE');
    expect(modelCalls).toBe(0);
    const artifact = JSON.parse(await readFile(join(writer.dir, '00a-url-sources.json'), 'utf8'));
    expect(artifact.sources[0]).toMatchObject({ url: 'https://example.com/hackathon', status: 'BLOCKED' });
  });

  it.each(['council', 'research'] as const)('%s stops by default when a supplied source is blocked — no model calls burned', async (mode) => {
    vi.stubGlobal('fetch', async () => new Response('Access denied', { status: 403, headers: { 'content-type': 'text/html' } }));
    let modelCalls = 0;
    const handles = (['agy', 'codex'] as ProviderId[]).map((id): ProviderHandle => ({
      id,
      adapter: { id, run: async () => (modelCalls++, { ok: true, text: '{}', json: {}, durationMs: 1 }) },
      flags: { id, jsonOutput: false, readOnlyFlag: 'sandbox' },
      readOnly: 'sandbox',
      version: 'test',
    }));
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode,
      handles,
      roles: { analyst: 'agy', judge: 'codex', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
    });

    const outcome = await executeRun(ctx, 'Research the rules at https://example.com/hackathon before deciding.', runIdeaRefinement);

    expect(outcome.error?.code).toBe('SOURCE_UNREADABLE');
    expect(outcome.error?.message).toContain('--allow-blocked-sources');
    expect(modelCalls).toBe(0); // v6 T10: the f740 failure mode — 12 calls around a 403 — is dead
  });

  it.each(['council', 'research'] as const)('%s preserves a blocked source and falls back to Codex search when the user proceeds explicitly', async (mode) => {
    vi.stubGlobal('fetch', async () => new Response(
      '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>',
      { status: 403, headers: { 'content-type': 'text/html' } },
    ));
    let modelCalls = 0;
    const requests: Array<{ provider: ProviderId; prompt: string; research?: boolean }> = [];
    const handles = (['agy', 'codex'] as ProviderId[]).map((id): ProviderHandle => {
      const adapter: Adapter = {
        id,
        run: async (request): Promise<RunResultAdapter> => {
          modelCalls++;
          requests.push({ provider: id, prompt: request.prompt, research: request.research });
          const json = request.prompt.includes('TWO-VIEW PREFLIGHT') ? preflightReading : {};
          return { ok: true, text: JSON.stringify(json), json, durationMs: 1 };
        },
      };
      return { id, adapter, flags: { id, jsonOutput: false, readOnlyFlag: 'sandbox' }, readOnly: 'sandbox', version: 'test' };
    });
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode,
      handles,
      roles: { analyst: 'agy', judge: 'codex', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
      allowBlockedSources: true, // v6 T10: the fallback path now requires the explicit override
    });

    const outcome = await executeRun(
      ctx,
      'Research the current rules at https://example.com/hackathon before deciding.',
      runIdeaRefinement,
    );

    expect(outcome.error?.code).not.toBe('SOURCE_UNREADABLE');
    expect(modelCalls).toBeGreaterThan(0);
    expect(ctx.flags).toContain('source_fallback_search');
    const codexS4 = requests.find((request) => request.provider === 'codex' && request.prompt.includes('ROLE: Independent analyst'));
    expect(codexS4?.research).toBe(true);
    expect(codexS4?.prompt).toContain('provider-native read-only source investigation');
    expect(codexS4?.prompt).toContain('inputs/idea-brief.md');
    expect(await readFile(join(writer.dir, 'inputs/idea-brief.md'), 'utf8')).toContain('https://example.com/hackathon');
    expect(ctx.calls.filter((call) => call.provider === 'codex' && call.stage === 'S4-codex')).toHaveLength(1);
    expect(ctx.calls.some((call) => call.stage.toLowerCase().includes('search'))).toBe(false);
    const artifact = JSON.parse(await readFile(join(writer.dir, '00a-url-sources.json'), 'utf8'));
    expect(artifact.sources[0]).toMatchObject({ status: 'BLOCKED' });
  });

  it.each(['council', 'research'] as const)('%s stops before model calls when Codex is not selected for source investigation', async (mode) => {
    vi.stubGlobal('fetch', async () => new Response('Access denied', { status: 403, headers: { 'content-type': 'text/html' } }));
    let modelCalls = 0;
    const handles = (['agy', 'claude', 'codex'] as ProviderId[]).map((id): ProviderHandle => ({
      id,
      adapter: { id, run: async () => (modelCalls++, { ok: true, text: '{}', json: {}, durationMs: 1 }) },
      flags: { id, jsonOutput: false, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
      readOnly: id === 'claude' ? 'plan' : 'sandbox',
      version: 'test',
    }));
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode,
      handles,
      roles: { analyst: 'agy', judge: 'claude', verifier: 'agy', s4: ['agy', 'claude'] },
      writer,
      cwd: writer.dir,
    });

    const outcome = await executeRun(ctx, 'Research https://example.com/hackathon before deciding.', runIdeaRefinement);

    expect(outcome.error?.code).toBe('SOURCE_UNREADABLE');
    expect(modelCalls).toBe(0);
  });
});
