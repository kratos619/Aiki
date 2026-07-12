import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import { jsonCall } from '../src/orchestration/jsonStage.js';
import { RunWriter } from '../src/storage/runs.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('jsonCall repair policy', () => {
  it('can enforce one provider attempt for the bounded coverage fill', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-json-stage-'));
    let calls = 0;
    const handle: ProviderHandle = {
      id: 'agy',
      adapter: {
        id: 'agy',
        run: async () => {
          calls++;
          return { ok: true, text: '{}', json: {}, durationMs: 1 };
        },
      },
      flags: { id: 'agy', jsonOutput: true, readOnlyFlag: 'sandbox' },
      readOnly: 'sandbox',
      version: 'test',
    };
    const writer = new RunWriter('test-run', root);
    await writer.init();
    const ctx = new RunCtx({
      runId: 'test-run', workflow: 'idea-refinement', handles: [handle],
      roles: { analyst: 'agy', judge: 'agy', verifier: 'agy', s4: ['agy'] }, writer, cwd: writer.dir,
    });

    await expect(jsonCall(ctx, handle, 'coverage', 'prompt', z.object({ value: z.string() }), { repair: false }))
      .rejects.toThrow(/failed validation/);
    expect(calls).toBe(1);
  });

  const salvageHandle = (run: () => Promise<{ ok: boolean; text?: string; json?: unknown; error?: string; stderrTail?: string; durationMs: number }>): ProviderHandle => ({
    id: 'agy',
    adapter: { id: 'agy', run },
    flags: { id: 'agy', jsonOutput: true, readOnlyFlag: 'sandbox' },
    readOnly: 'sandbox',
    version: 'test',
  });

  const makeCtx = (handle: ProviderHandle, dir: string) => {
    const writer = new RunWriter('test-run', dir);
    return writer.init().then(() => new RunCtx({
      runId: 'test-run', workflow: 'idea-refinement', handles: [handle],
      roles: { analyst: 'agy', judge: 'agy', verifier: 'agy', s4: ['agy'] }, writer, cwd: writer.dir,
    }));
  };

  const schema = z.object({ value: z.string() }).strict();
  const stripExtra = (json: unknown) => {
    const { value } = (json ?? {}) as Record<string, unknown>;
    return { value };
  };

  it('salvages a deterministically fixable output after the repair retry also fails validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-json-stage-'));
    let calls = 0;
    const handle = salvageHandle(async () => {
      calls++;
      return { ok: true, text: '', json: { value: 'kept', extra: 'invalid' }, durationMs: 1 };
    });
    const ctx = await makeCtx(handle, root);

    const result = await jsonCall(ctx, handle, 'S4-analyst', 'prompt', schema, { salvage: stripExtra });

    expect(result).toEqual({ value: 'kept' });
    expect(calls).toBe(2); // first + one repair, salvage costs no extra call
  });

  it('salvages the first output when the repair call itself dies (e.g. quota)', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-json-stage-'));
    let calls = 0;
    const handle = salvageHandle(async () => {
      calls++;
      if (calls === 1) return { ok: true, text: '', json: { value: 'kept', extra: 'invalid' }, durationMs: 1 };
      return { ok: false, error: 'QUOTA', stderrTail: 'quota exhausted', durationMs: 1 };
    });
    const ctx = await makeCtx(handle, root);

    await expect(jsonCall(ctx, handle, 'S4-analyst', 'prompt', schema, { salvage: stripExtra }))
      .resolves.toEqual({ value: 'kept' });
  });

  it('still fails when salvage cannot produce a valid output', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-json-stage-'));
    const handle = salvageHandle(async () => ({ ok: true, text: '', json: { wrong: true }, durationMs: 1 }));
    const ctx = await makeCtx(handle, root);

    await expect(jsonCall(ctx, handle, 'S4-analyst', 'prompt', schema, { salvage: stripExtra }))
      .rejects.toThrow(/failed validation after repair/);
  });
});
