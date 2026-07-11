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
});
