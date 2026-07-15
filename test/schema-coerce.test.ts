import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { coerceToSchema, jsonCall } from '../src/orchestration/jsonStage.js';
import { RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import { RunWriter } from '../src/storage/runs.js';
import { IdeaChairReportModel } from '../src/schemas/index.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

const Sample = z.object({
  name: z.string(),
  tags: z.array(z.string()).max(3),
  nested: z.object({ ids: z.array(z.string()) }).optional(),
  notes: z.array(z.string()).optional(),
}).strict();

describe('coerceToSchema — generic §14 boundary floor', () => {
  it('losslessly wraps a lone value where an array is expected, through optional/effects wrappers', () => {
    const coerced = coerceToSchema(Sample.superRefine(() => {}), {
      name: 'x',
      tags: 'solo',
      nested: { ids: 'n1' },
      notes: 'one note',
    }, false);

    expect(coerced).toEqual({ name: 'x', tags: ['solo'], nested: { ids: ['n1'] }, notes: ['one note'] });
    expect(Sample.safeParse(coerced).success).toBe(true);
  });

  it('never truncates in lossless mode; truncates over-max arrays in lossy mode, order preserved', () => {
    const over = { name: 'x', tags: ['a', 'b', 'c', 'd', 'e'] };
    const lossless = coerceToSchema(Sample, over, false) as typeof over;
    expect(lossless.tags).toHaveLength(5); // untouched — lossless never drops content

    const lossy = coerceToSchema(Sample, over, true) as typeof over;
    expect(lossy.tags).toEqual(['a', 'b', 'c']);
  });

  it('leaves valid data and non-coercible shapes untouched', () => {
    const valid = { name: 'x', tags: ['a'] };
    expect(coerceToSchema(Sample, valid, true)).toEqual(valid);
    expect(coerceToSchema(Sample, 'not an object', true)).toBe('not an object');
    expect(coerceToSchema(Sample, null, true)).toBe(null);
  });

  // Real S9 first output from run 20260715-1516: its ONLY defect was `dissent` as a string.
  // The paid repair it triggered flipped the verdict PIVOT→PWC and died on a new cap violation.
  it('replays the 20260715-1516 S9 first output: dissent string wraps losslessly, verdict preserved', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s9-first-dissent-string.json', import.meta.url), 'utf8'));

    expect(IdeaChairReportModel.safeParse(raw).success).toBe(false);
    const parsed = IdeaChairReportModel.parse(coerceToSchema(IdeaChairReportModel, raw, false));
    expect(parsed.dissent).toEqual([raw.dissent]);
    expect(parsed.recommendation).toBe('PIVOT'); // the judge's true first answer survives
  });

  // Real S9 repair output from the same run: 7 conditions vs max 6 killed the whole run.
  it('replays the 20260715-1516 S9 repair output: lossless refuses, lossy truncates to the cap', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s9-repair-conditions-overflow.json', import.meta.url), 'utf8'));

    expect(IdeaChairReportModel.safeParse(raw).success).toBe(false);
    expect(IdeaChairReportModel.safeParse(coerceToSchema(IdeaChairReportModel, raw, false)).success).toBe(false);
    const parsed = IdeaChairReportModel.parse(coerceToSchema(IdeaChairReportModel, raw, true));
    expect(parsed.conditions).toHaveLength(6);
    expect(parsed.conditions).toEqual(raw.conditions.slice(0, 6));
  });
});

describe('jsonCall — coercion floor wiring', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aiki-coerce-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function handleFor(outputs: unknown[]): ProviderHandle {
    let call = 0;
    const adapter: Adapter = {
      id: 'claude' as ProviderId,
      run: async (): Promise<RunResultAdapter> => {
        const json = outputs[Math.min(call++, outputs.length - 1)];
        return { ok: true, text: JSON.stringify(json), json, durationMs: 1 };
      },
    };
    return { id: 'claude', adapter, flags: { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' }, readOnly: 'plan', version: 'test' };
  }

  function ctxFor(handle: ProviderHandle): RunCtx {
    const writer = new RunWriter('coerce-test', root);
    return new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      handles: [handle],
      roles: { analyst: 'claude', judge: 'claude', verifier: 'claude', s4: ['claude', 'claude'] },
      writer,
      cwd: writer.dir,
      budget: 4,
    });
  }

  it('accepts a losslessly coercible first output WITHOUT paying for a repair call', async () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s9-first-dissent-string.json', import.meta.url), 'utf8'));
    const handle = handleFor([raw]);
    const ctx = ctxFor(handle);

    const report = await jsonCall(ctx, handle, 'S9', 'judge prompt', IdeaChairReportModel);
    expect(report.dissent).toEqual([raw.dissent]);
    expect(ctx.calls).toHaveLength(1); // no repair call was made
  });

  it('salvages an over-cap repair output by truncation instead of failing the run', async () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s9-repair-conditions-overflow.json', import.meta.url), 'utf8'));
    const handle = handleFor([raw, raw]); // first AND repair both over the cap
    const ctx = ctxFor(handle);

    const report = await jsonCall(ctx, handle, 'S9', 'judge prompt', IdeaChairReportModel);
    expect(report.conditions).toHaveLength(6);
    expect(ctx.calls).toHaveLength(2); // repair was attempted, then the deterministic floor saved it
  });
});
