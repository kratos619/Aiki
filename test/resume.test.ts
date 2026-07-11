// V6.3 — resume via call-replay + the session registry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import { buildReplayCache } from '../src/storage/replay.js';
import { recordSession, readSessions, updateSessionStatus, findSession } from '../src/storage/sessions.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

// Scripted idea-refinement adapter (mirrors engine.test). Counts real calls; can fail the judge (S9).
function scriptAdapter(id: ProviderId, counter: { n: number }, opts: { judgeFails?: boolean } = {}): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      counter.n++;
      const p = req.prompt;
      if (opts.judgeFails && p.includes('ROLE: Judge')) {
        return { ok: false, error: 'TIMEOUT', stderrTail: 'judge timed out', durationMs: 1 };
      }
      let obj: unknown;
      if (p.includes('intent preflight analyst')) {
        obj = {
          subject: 'local multi-model orchestration CLI',
          decision_frame: 'decide whether to build the tool as specified',
          evaluation_lens: 'developer-tool viability and risk',
          target_user: 'developers already paying for multiple AI subscriptions',
          constraints: ['no API keys', 'read-only'],
          claims_to_test: ['1.3x bug-catch rate'],
          evidence_supplied: [],
          missing_axes: ['pricing'],
          domain_dimensions: [
            { id: 'D1', label: 'provider interoperability', rationale: 'The idea depends on installed provider CLIs.' },
            { id: 'D2', label: 'workflow adoption', rationale: 'Developers must change review habits.' },
            { id: 'D3', label: 'output comparability', rationale: 'The council compares unlike provider outputs.' },
          ],
          questions: [
            { id: 'Q1', axis: 'decision_frame', question: 'What decision should the council help you make?', why_it_matters: 'The verdict needs a decision frame.', suggested_answers: ['Build/no-build', 'Risk list'] },
            { id: 'Q2', axis: 'target_user', question: 'Who is the first target user?', why_it_matters: 'The audience changes the critique.', suggested_answers: ['Solo developers', 'Teams'] },
            { id: 'Q3', axis: 'success_bar', question: 'What success bar should be used?', why_it_matters: 'The judge needs a bar.', suggested_answers: ['Beat one strong model', 'Find fatal risks'] },
          ],
        };
      } else if (p.includes('intake analyst')) {
        obj = { task: 'build a local multi-model orchestration CLI', task_type: 'idea-refinement', constraints: [], unknowns: ['target user'], success_criteria: ['a verdict'] };
      } else if (p.includes('their request could be misread')) {
        obj = { my_interpretation: 'build a local multi model orchestration cli', plausible_misreadings: ['a cloud chat product'] };
      } else if (p.includes('Fill the role prompt templates')) {
        obj = { prompts: { analyst: 'ROLE: analyst. Task fully specified, no slots remain.' } };
      } else if (p.includes('Task fully specified')) {
        obj = {
          task_echo: 'build a local multi-model orchestration CLI',
          strongest_version: 'A local CLI that orchestrates installed AI CLIs for cross-model review.',
          positions: [
            { local_id: 'P1', proposition: 'developers want local multi model orchestration', dimension_id: 'R1', stance: 'SUPPORT', basis: 'EVIDENCE', load_bearing: true, if_false: 'STOP', reasoning: 'The supplied request demonstrates demand.', evidence_ids: ['E1'], depends_on: [] },
            { local_id: 'P2', proposition: 'installed CLIs expose stable machine readable output', dimension_id: 'R4', stance: id === 'agy' ? 'SUPPORT' : 'OPPOSE', basis: 'EVIDENCE', load_bearing: true, if_false: 'CONDITION', reasoning: id === 'agy' ? 'Probe-time formats can be pinned.' : 'CLI output formats drift between versions.', evidence_ids: ['E2'], depends_on: [] },
          ],
          evidence: [
            { id: 'E1', claim_supported: 'developers want local multi model orchestration', source_kind: 'USER', support: 'SUPPORTS', freshness: 'CURRENT' },
            { id: 'E2', claim_supported: 'installed CLIs expose stable machine readable output', source_kind: 'USER', support: id === 'agy' ? 'SUPPORTS' : 'CONTRADICTS', freshness: 'CURRENT' },
          ],
          coverage: [
            { dimension_id: 'R1', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 covers target users.' },
            { dimension_id: 'R4', status: 'COVERED', position_ids: ['P2'], rationale: 'P2 covers feasibility.' },
          ],
          decision_questions: [{ id: 'Q1', question: 'who is the target user?', claim_ids: ['P1'] }],
        };
      } else if (p.includes('TARGETED COVERAGE FILL')) {
        const missing = ['R2', 'R3', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'D1', 'D2', 'D3'];
        obj = {
          task_echo: 'build a local multi-model orchestration CLI',
          strongest_version: 'A focused local orchestration CLI may work.',
          positions: [],
          evidence: [],
          coverage: missing.map((dimension_id) => ({
            dimension_id,
            status: 'NOT_APPLICABLE',
            position_ids: [],
            rationale: `No additional claim is needed for ${dimension_id} in this scripted fixture.`,
          })),
          decision_questions: [],
        };
      } else if (p.includes('Group anonymous positions')) {
        obj = { groups: [['P1', 'P3'], ['P2', 'P4']] };
      } else if (p.includes('ROLE: Independent verifier')) {
        obj = { verifications: [{ target_id: 'G2', verdict: 'REFUTE', evidence: 'the format is pinned at probe time', note: '' }] };
      } else if (p.includes('ROLE: Judge')) {
        obj = {
          adjudications: [{ id: 'G2', ruling: 'REJECT', reasoning: 'the drift risk is mitigated by the flag probe', evidence_cited: 'S1 probe' }],
          verdict: 'Viable as a local orchestration layer; ship behind a provider-probe guard.',
          recommendation: 'PROCEED_WITH_CONDITIONS',
          conditions: ['Proceed only if provider output probing stays stable across versions.'],
          key_points: ['The provider-probe guard addresses the main dispute.'],
          dissent: ['May not beat a single strong model on subjective synthesis.'],
          confidence_notes: 'HIGH on the consensus claims; MEDIUM on the contested one.',
        };
      } else if (p.includes('ROLE: Validation planner')) {
        obj = {
          actions: [{
            order: 1,
            action: 'Interview five target developers about local CLI orchestration pain.',
            why: 'The target user is still an open question.',
            validates: 'Q:who is the target user?',
            effort: 'S',
            kill_signal: 'Fewer than two developers describe the pain unprompted.',
          }],
          sequencing_note: 'Resolve target-user demand before deeper implementation.',
        };
      } else {
        obj = {};
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

const INPUT = '# my idea\nbuild a local orchestration CLI that binds installed AI CLIs';

let root: string;
function makeCtx(counter: { n: number }, opts: { judgeFails?: boolean; replay?: Map<string, string> } = {}): RunCtx {
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles: ProviderHandle[] = ids.map((id) => ({
    id,
    adapter: scriptAdapter(id, counter, { judgeFails: opts.judgeFails }),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: '9.9.9',
  }));
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', ids);
  const writer = new RunWriter(runId, root);
  return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, replay: opts.replay });
}

describe('resume: call replay', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-resume-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('a fully-completed run resumes with ZERO real calls (every call replayed, run-id path normalized)', async () => {
    const c1 = { n: 0 };
    const first = await executeRun(makeCtx(c1), INPUT, runIdeaRefinement);
    expect(first.ok).toBe(true);
    expect(c1.n).toBe(13); // full run includes one targeted coverage fill

    const cache = await buildReplayCache(first.dir);
    expect(cache.size).toBe(13);

    // Resume: a NEW run (different id/dir) with the cache — nothing should reach a model.
    const c2 = { n: 0 };
    const resumed = await executeRun(makeCtx(c2, { replay: cache }), INPUT, runIdeaRefinement);
    expect(resumed.ok).toBe(true);
    expect(c2.n).toBe(0); // ZERO real calls — proves replay + run-dir path normalization across ids
    expect(resumed.callCount).toBe(0);
    await expect(readFile(join(resumed.dir, 'final-report.md'), 'utf8')).resolves.toContain('# Decision Brief');
  });

  it('a run that died at S9 resumes and re-calls ONLY the judge (S1–S8 replayed)', async () => {
    const c1 = { n: 0 };
    const first = await executeRun(makeCtx(c1, { judgeFails: true }), INPUT, runIdeaRefinement);
    expect(first.ok).toBe(false); // judge timed out

    const cache = await buildReplayCache(first.dir);
    expect(cache.size).toBe(11); // S0–S8 plus coverage fill cached; the failed judge output is skipped

    const c2 = { n: 0 };
    const resumed = await executeRun(makeCtx(c2, { replay: cache }), INPUT, runIdeaRefinement);
    expect(resumed.ok).toBe(true);
    expect(c2.n).toBe(2); // judge + action planner re-called; everything before them replayed
    await expect(readFile(join(resumed.dir, 'final-report.md'), 'utf8')).resolves.toContain('# Decision Brief');
  });
});

describe('replay cache: skips error dumps', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiki-raw-'));
    await mkdir(join(dir, 'raw'), { recursive: true });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('pairs prompt+out by (provider, prompt) and drops failed calls', async () => {
    await writeFile(join(dir, 'raw', 'S1-agy-1.prompt.txt'), 'good prompt');
    await writeFile(join(dir, 'raw', 'S1-agy-1.out'), '{"ok":true}');
    await writeFile(join(dir, 'raw', 'S9-claude-2.prompt.txt'), 'judge prompt');
    await writeFile(join(dir, 'raw', 'S9-claude-2.out'), '[TIMEOUT]\nchild killed'); // failed → skipped
    const cache = await buildReplayCache(dir);
    expect(cache.size).toBe(1);
  });
});

describe('session registry', () => {
  let home: string;
  const prev = process.env.AIKI_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aiki-home-'));
    process.env.AIKI_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  const entry = (id: string, over: Record<string, unknown> = {}) => ({
    id, workflow: 'idea-refinement', cwd: '/x', runsRoot: '/x/.aiki', startedAt: '2026-07-06T10:00:00.000Z', status: 'running' as const, ...over,
  });

  it('records, dedupes by id (last wins), sorts newest-first, and updates status', async () => {
    await recordSession(entry('20260706-1000-idea-refinement-aaaa'));
    await recordSession(entry('20260706-1100-idea-refinement-bbbb', { startedAt: '2026-07-06T11:00:00.000Z' }));
    await updateSessionStatus('20260706-1000-idea-refinement-aaaa', 'failed');

    const all = await readSessions();
    expect(all).toHaveLength(2); // deduped by id despite the extra status line
    expect(all[0]!.id).toBe('20260706-1100-idea-refinement-bbbb'); // newest first
    expect(all.find((s) => s.id.endsWith('aaaa'))!.status).toBe('failed'); // last line won
  });

  it('findSession: exact, unique-substring, ambiguous', async () => {
    await recordSession(entry('20260706-1000-idea-refinement-aaaa'));
    await recordSession(entry('20260706-1100-code-review-aaab', { workflow: 'code-review', startedAt: '2026-07-06T11:00:00.000Z' }));
    expect(await findSession('20260706-1000-idea-refinement-aaaa')).toMatchObject({ id: expect.stringContaining('aaaa') });
    expect(await findSession('aaab')).toMatchObject({ workflow: 'code-review' });
    expect(await findSession('aaa')).toEqual({ ambiguous: expect.arrayContaining([expect.stringContaining('aaaa'), expect.stringContaining('aaab')]) });
    expect(await findSession('zzzz')).toBeNull();
  });
});
