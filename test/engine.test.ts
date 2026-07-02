import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

// A scripted adapter that answers each stage by inspecting the prompt. Records call count.
function fakeAdapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      let obj: unknown;
      if (p.includes('intake analyst')) {
        obj = { task: 'build a local multi-model orchestration CLI', task_type: 'idea-refinement', constraints: [], unknowns: ['target user'], success_criteria: ['a verdict'] };
      } else if (p.includes('how you read it')) {
        obj = { my_interpretation: 'build a local multi model orchestration cli', plausible_misreadings: ['a cloud chat product'] };
      } else if (p.includes('Fill the role prompt templates')) {
        obj = { prompts: { analyst: 'ROLE: analyst. Task fully specified, no slots remain.' } };
      } else {
        obj = {};
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function handle(id: ProviderId): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return {
    id,
    adapter: fakeAdapter(id),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly },
    readOnly,
    version: '9.9.9',
  };
}

const INPUT = '# my idea\nbuild a local orchestration CLI that binds installed AI CLIs';

let root: string;

function makeCtx(budget?: number): RunCtx {
  const handles = [handle('agy'), handle('codex'), handle('claude')];
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', handles.map((h) => h.id));
  const writer = new RunWriter(runId, root);
  return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, budget });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-engine-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('role assignment (§10, decided T5)', () => {
  it('idea-refinement default: analyst=agy, judge=claude, verifier=codex, judge not an S4 author', () => {
    const roles = resolveRoles('idea-refinement', ['agy', 'codex', 'claude']);
    expect(roles).toMatchObject({ analyst: 'agy', judge: 'claude', verifier: 'codex' });
    expect(roles.s4).not.toContain('claude'); // judge must not author what it adjudicates
  });
});

describe('executeRun happy path (§24 T5: artifacts 00–03)', () => {
  it('produces the S1–S3 artifacts on sample input', async () => {
    const ctx = makeCtx();
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(5); // S1(1) + S2(3 providers) + S3(1)

    const dir = ctx.writer.dir;
    expect(await readFile(join(dir, '00-original.md'), 'utf8')).toBe(INPUT);

    const contract = JSON.parse(await readFile(join(dir, '01-intent-contract.json'), 'utf8'));
    expect(contract.task_type).toBe('idea-refinement');

    const guard = JSON.parse(await readFile(join(dir, '02-misunderstanding-guard.json'), 'utf8'));
    expect(guard.interpretations).toHaveLength(3);
    expect(guard.chosen.how).toBe('single-cluster'); // identical restatements → one cluster

    await expect(stat(join(dir, '03-prompts', 'analyst.md'))).resolves.toBeDefined();

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('ok');
    expect(meta.call_count).toBe(5);
    expect(meta.roles).toMatchObject({ analyst: 'agy', judge: 'claude' });
  });
});

describe('executeRun budget breach (§24 T5: aborts gracefully)', () => {
  it('fails gracefully with partial, valid artifacts + finalized meta', async () => {
    const ctx = makeCtx(1); // S1 uses the only call; S2 fan-out breaches
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('BUDGET');

    const dir = ctx.writer.dir;
    const entries = await readdir(dir);
    expect(entries).toContain('01-intent-contract.json'); // S1 landed before the breach
    expect(entries).not.toContain('02-misunderstanding-guard.json'); // S2 never completed
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false); // no half-written files

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('failed');
    expect(meta.call_count).toBe(1); // only S1's call was accounted (breach throws pre-increment)
    expect(meta.budget).toEqual({ limit: 1, used: 1 });
  });
});
