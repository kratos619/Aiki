// V7 — S2 misunderstanding-guard clarify UX: pick one reading / combine all / type your own.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, resolveRoles, type ClarifyChoice, type ProviderHandle, type RunEvents } from '../src/orchestration/context.js';
import { RunWriter } from '../src/storage/runs.js';
import { s2Misread } from '../src/orchestration/stages/s2-misread.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import type { IntentContract } from '../src/schemas/index.js';

// Each provider answers S2 with a fixed interpretation. agy+codex agree (one cluster), claude diverges
// (a second cluster) → the clarify seam fires with two options.
const INTERPS: Record<ProviderId, string> = {
  agy: 'build a local orchestration cli for developers',
  codex: 'build a local orchestration cli for developers',
  claude: 'write a cloud hosted chat product for consumers',
};

function s2Handle(id: ProviderId): ProviderHandle {
  const adapter: Adapter = {
    id,
    run: async (): Promise<RunResultAdapter> => {
      const obj = { my_interpretation: INTERPS[id], plausible_misreadings: ['a different scope'] };
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return { id, adapter, flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
}

const CONTRACT: IntentContract = { task: 'build a local orchestration cli', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: ['a verdict'] };

let root: string;
async function runS2(choice: ClarifyChoice) {
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles = ids.map(s2Handle);
  const runId = makeRunId('idea-refinement');
  const writer = new RunWriter(runId, root);
  await writer.init();
  const events: RunEvents = { clarify: async () => choice };
  const ctx = new RunCtx({ runId, workflow: 'idea-refinement', handles, roles: resolveRoles('idea-refinement', ids), writer, cwd: writer.dir, events });
  return s2Misread(ctx, CONTRACT, 'build a local orchestration cli');
}

describe('S2 clarify choices (V7)', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-s2-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('two divergent readings → clarify fires with two clusters', async () => {
    const guard = await runS2({ kind: 'pick', index: 0 });
    expect(guard.clusters).toHaveLength(2);
  });

  it('pick: uses the chosen cluster representative', async () => {
    const guard = await runS2({ kind: 'pick', index: 1 });
    expect(guard.chosen).toMatchObject({ how: 'user-selected', cluster_index: 1 });
    expect(guard.chosen.my_interpretation).toBe('write a cloud hosted chat product for consumers');
  });

  it('both: combines every reading', async () => {
    const guard = await runS2({ kind: 'both' });
    expect(guard.chosen.how).toBe('user-combined');
    expect(guard.chosen.my_interpretation).toContain('build a local orchestration cli for developers');
    expect(guard.chosen.my_interpretation).toContain('write a cloud hosted chat product for consumers');
    expect(guard.chosen.cluster_index).toBe(-1);
  });

  it('text: uses the user-typed interpretation verbatim', async () => {
    const guard = await runS2({ kind: 'text', text: '  drive my installed AI CLIs, no API keys  ' });
    expect(guard.chosen).toMatchObject({ how: 'user-typed', cluster_index: -1 });
    expect(guard.chosen.my_interpretation).toBe('drive my installed AI CLIs, no API keys'); // trimmed
  });
});
