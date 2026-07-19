import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTaskProfile, resolveAutoMode } from '../src/orchestration/auto-profile.js';
import { RunMeta, type RequestedOutput } from '../src/schemas/index.js';
import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { RunWriter } from '../src/storage/runs.js';
import { deterministicContract } from '../src/orchestration/preflight.js';
import type { ProviderId } from '../src/providers/types.js';

const base = { urlCount: 0, hasEvidencePack: false, requestedOutputs: ['DECISION'] as RequestedOutput[] };

describe('resolveAutoMode (deterministic v1 rules)', () => {
  it('plain single-decision prompt → quick, with a reason', () => {
    const p = buildTaskProfile('Should I use Postgres or MySQL for my side project?', base);
    const r = resolveAutoMode(p);
    expect(r.mode).toBe('quick');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('URLs supplied → council', () => {
    const r = resolveAutoMode(buildTaskProfile('Is this good? https://x.com/p', { ...base, urlCount: 1 }));
    expect(r.mode).toBe('council');
    expect(r.reasons).toContain('URLs supplied');
  });

  it('evidence pack → council', () => {
    expect(resolveAutoMode(buildTaskProfile('Should we ship?', { ...base, hasEvidencePack: true })).mode).toBe('council');
  });

  it('deliverables beyond DECISION → council', () => {
    const r = resolveAutoMode(buildTaskProfile('Should we build this?', { ...base, requestedOutputs: ['DECISION', 'FEATURE_BACKLOG'] }));
    expect(r.mode).toBe('council');
  });

  it('regulated/financial/security keyword → council', () => {
    expect(resolveAutoMode(buildTaskProfile('Should our fintech app store card data to stay PCI compliant?', base)).mode).toBe('council');
    expect(resolveAutoMode(buildTaskProfile('Is this design a security vulnerability?', base)).mode).toBe('council');
  });

  it('research wording → council', () => {
    expect(resolveAutoMode(buildTaskProfile('Research the market size before we decide.', base)).mode).toBe('council');
  });

  it('long input (>120 words) → council', () => {
    expect(resolveAutoMode(buildTaskProfile('word '.repeat(121), base)).mode).toBe('council');
  });

  it('accumulates multiple reasons', () => {
    const r = resolveAutoMode(buildTaskProfile('Research pricing https://x.com/p', { ...base, urlCount: 1, hasEvidencePack: true }));
    expect(r.mode).toBe('council');
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveAutoMode fast-path eligibility (Phase C)', () => {
  it('a clear decision question routed to quick is fast-path eligible', () => {
    const r = resolveAutoMode(buildTaskProfile('Should I use Postgres or MySQL for my side project?', base));
    expect(r.mode).toBe('quick');
    expect(r.fastPath).toBe(true);
  });

  it('a vague quick prompt with no decision verb is NOT fast-path eligible', () => {
    const r = resolveAutoMode(buildTaskProfile('My startup idea for a todo app.', base));
    expect(r.mode).toBe('quick');
    expect(r.fastPath).toBe(false);
  });

  it('a decision verb without a subject is NOT fast-path eligible', () => {
    expect(resolveAutoMode(buildTaskProfile('Should I?', base)).fastPath).toBe(false);
  });

  it('a council-routed prompt is never fast-path', () => {
    const r = resolveAutoMode(buildTaskProfile('Should we build this? https://x.com/p', { ...base, urlCount: 1 }));
    expect(r.mode).toBe('council');
    expect(r.fastPath).toBe(false);
  });
});

describe('deterministicContract (Phase C fast path)', () => {
  it('builds a valid DecisionContract with no model readings', () => {
    const c = deterministicContract('Should I use Postgres or MySQL for my side project?', ['product value', 'feasibility']);
    expect(c.task).toBe('Should I use Postgres or MySQL for my side project?');
    expect(c.constraints).toEqual([]);
    expect(c.alternatives).toEqual([]);
    expect(c.requested_outputs).toEqual(['DECISION']);
    expect(c.confirmation).toBe('headless-defaulted');
    expect(c.core_rubric).toEqual(['product value', 'feasibility']);
  });
});

describe('RunMeta.auto_decision persistence', () => {
  let tmpRoot: string | undefined;
  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it('RunMeta parses with and without auto_decision', () => {
    const legacy = { run_id: 'r', workflow: 'idea-refinement', provider_versions: {}, flag_profiles: {}, roles: {}, read_only: {}, calls: [], call_count: 0, budget: { limit: 6, used: 0 }, exit_status: 'ok', aborted: false };
    expect(RunMeta.parse(legacy).auto_decision).toBeUndefined();
    const withAuto = RunMeta.parse({ ...legacy, auto_decision: { resolved: 'council', reasons: ['URLs supplied'] } });
    expect(withAuto.auto_decision).toEqual({ resolved: 'council', reasons: ['URLs supplied'] });
  });

  it('buildMeta emits auto_decision when the run was routed by auto', async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'aiki-auto-'));
    const ids: ProviderId[] = ['agy', 'codex', 'claude'];
    const handles: ProviderHandle[] = ids.map((id) => ({
      id, adapter: { id, run: async () => ({ ok: true, text: '', durationMs: 0 }) },
      flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
      readOnly: id === 'claude' ? 'plan' : 'sandbox', version: '9.9.9',
    }));
    const runId = makeRunId('idea-refinement');
    const writer = new RunWriter(runId, tmpRoot);
    const ctx = new RunCtx({ runId, workflow: 'idea-refinement', mode: 'council', handles, roles: resolveRoles('idea-refinement', ids), writer, cwd: writer.dir, autoDecision: { resolved: 'council', reasons: ['URLs supplied'] } });
    expect(ctx.buildMeta('ok', false).auto_decision).toEqual({ resolved: 'council', reasons: ['URLs supplied'] });
  });
});
