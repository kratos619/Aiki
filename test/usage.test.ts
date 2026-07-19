import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallRecord } from '../src/schemas/index.js';
import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { RunWriter } from '../src/storage/runs.js';
import { replayKey } from '../src/storage/replay.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

let tmpRoot: string | undefined;
afterEach(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

// Mock adapter: returns provider-reported usage iff the prompt asks for it.
function usageAdapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      if (req.prompt.includes('WITH_USAGE')) {
        return { ok: true, text: 'ok', durationMs: 5, usage: { inputTokens: 100, outputTokens: 20, estimated: false, reportedCostUsd: 0.42 } };
      }
      return { ok: true, text: 'the output text', durationMs: 5 };
    },
  };
}

async function makeCtx(replay?: Map<string, string>): Promise<{ ctx: RunCtx; handle: ProviderHandle }> {
  tmpRoot = await mkdtemp(join(tmpdir(), 'aiki-usage-'));
  const ids: ProviderId[] = ['agy', 'codex', 'claude'];
  const handles: ProviderHandle[] = ids.map((id) => ({
    id,
    adapter: usageAdapter(id),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: '9.9.9',
  }));
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', ids);
  const writer = new RunWriter(runId, tmpRoot);
  const ctx = new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, replay });
  return { ctx, handle: handles.find((h) => h.id === 'claude')! };
}

test('CallRecord carries optional normalized usage', () => {
  const rec = CallRecord.parse({
    provider: 'claude', stage: 'S9', durationMs: 1200,
    usage: { inputTokens: 18420, outputTokens: 3180, estimated: false, reportedCostUsd: 0.42 },
  });
  expect(rec.usage?.inputTokens).toBe(18420);
  expect(rec.usage?.estimated).toBe(false);
});

test('old CallRecords without usage still parse', () => {
  const rec = CallRecord.parse({ provider: 'agy', stage: 'S4', durationMs: 10 });
  expect(rec.usage).toBeUndefined();
});

test('RunCtx.call records provider-reported usage verbatim (estimated:false)', async () => {
  const { ctx, handle } = await makeCtx();
  await ctx.call(handle, { prompt: 'WITH_USAGE please', expectJson: false }, 'S4');
  expect(ctx.calls[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 20, estimated: false, reportedCostUsd: 0.42 });
});

test('RunCtx.call estimates usage (chars/4) when the adapter reports none', async () => {
  const { ctx, handle } = await makeCtx();
  const prompt = 'no reported usage here';
  await ctx.call(handle, { prompt, expectJson: false }, 'S4');
  expect(ctx.calls[0]!.usage).toEqual({
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil('the output text'.length / 4),
    estimated: true,
  });
});

test('replayed calls add no ledger entry', async () => {
  const prompt = 'REPLAYED prompt';
  const replay = new Map([[replayKey('claude', prompt), 'cached output']]);
  const { ctx, handle } = await makeCtx(replay);
  await ctx.call(handle, { prompt, expectJson: false }, 'S4');
  expect(ctx.calls.length).toBe(0);
});

test('buildMeta sums usage_totals with reported/estimated counts', async () => {
  const { ctx, handle } = await makeCtx();
  await ctx.call(handle, { prompt: 'WITH_USAGE a', expectJson: false }, 'S4'); // reported: 100/20, $0.42
  await ctx.call(handle, { prompt: 'plain b', expectJson: false }, 'S4'); // estimated
  const meta = ctx.buildMeta('ok', false);
  const est = { in: Math.ceil('plain b'.length / 4), out: Math.ceil('the output text'.length / 4) };
  expect(meta.usage_totals).toEqual({
    inputTokens: 100 + est.in,
    outputTokens: 20 + est.out,
    reportedCalls: 1,
    estimatedCalls: 1,
    reportedCostUsd: 0.42,
  });
});
