import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-url-workflow-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('research source gate', () => {
  it('stops before paid model calls when a supplied source blocks automated reading', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>',
      { status: 403, headers: { 'content-type': 'text/html' } },
    ));
    let modelCalls = 0;
    const handles = (['agy', 'codex'] as ProviderId[]).map((id): ProviderHandle => {
      const adapter: Adapter = {
        id,
        run: async (): Promise<RunResultAdapter> => {
          modelCalls++;
          return { ok: true, text: '{}', json: {}, durationMs: 1 };
        },
      };
      return { id, adapter, flags: { id, jsonOutput: false, readOnlyFlag: 'sandbox' }, readOnly: 'sandbox', version: 'test' };
    });
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    const ctx = new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode: 'research',
      handles,
      roles: { analyst: 'agy', judge: 'codex', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
    });

    const outcome = await executeRun(
      ctx,
      'Research the current rules at https://example.com/hackathon before deciding.',
      runIdeaRefinement,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SOURCE_UNREADABLE');
    expect(outcome.error?.message).toContain('Paste the relevant text or provide a public export');
    expect(modelCalls).toBe(0);
    expect(ctx.calls).toHaveLength(0);
    const artifact = JSON.parse(await readFile(join(writer.dir, '00a-url-sources.json'), 'utf8'));
    expect(artifact.sources[0]).toMatchObject({ status: 'BLOCKED' });
  });
});
