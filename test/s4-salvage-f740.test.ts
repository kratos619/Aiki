import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractJson } from '../src/providers/adapter-core.js';
import { coerceToSchema } from '../src/orchestration/jsonStage.js';
import { IdeaRoleOutputModel, salvageIdeaRoleOutputModel } from '../src/schemas/index.js';
import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { s4Analyze } from '../src/orchestration/stages/s4-analyze.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

// T3 (plan/AIKI-v6-council-integrity-plan.md): run f740 spent 2 repair calls (~5 min; codex 267s)
// on schema ceremony. Codex's only defects were EMPTY optional rationale strings — dropping an
// empty optional is information-preserving, so it must be LOSSLESS and fix the seat before any
// repair. Agy's defects (a calculation input citing no evidence, a proposal with an invalid enum)
// are genuinely lossy to fix — salvage must handle them so a budget-starved seat still survives.

function load(name: string): { raw: Record<string, unknown>; json: unknown } {
  const text = readFileSync(`test/fixtures/${name}`, 'utf8');
  const json = extractJson(text);
  expect(json).toBeDefined();
  return { raw: json as Record<string, unknown>, json };
}

describe('f740 S4 seats', () => {
  it('REPLAY codex: lossless coercion alone fixes the seat — zero repairs, zero content loss', () => {
    const { raw, json } = load('f740-s4-codex-first.out.txt');
    expect(IdeaRoleOutputModel.safeParse(json).success).toBe(false); // the live defect

    const eased = IdeaRoleOutputModel.safeParse(coerceToSchema(IdeaRoleOutputModel, json, false));
    expect(eased.success).toBe(true);
    expect(eased.data!.positions.length).toBe((raw.positions as unknown[]).length);
    expect(eased.data!.coverage.length).toBe((raw.coverage as unknown[]).length);
  });

  it('REPLAY agy: salvage survives the seat without a repair call', () => {
    const { raw, json } = load('f740-s4-agy-first.out.txt');
    expect(IdeaRoleOutputModel.safeParse(json).success).toBe(false); // the live defect

    const staged = salvageIdeaRoleOutputModel(json);
    const candidates = [staged, coerceToSchema(IdeaRoleOutputModel, staged, true)];
    const saved = candidates
      .map((candidate) => IdeaRoleOutputModel.safeParse(candidate))
      .find((result) => result.success);
    expect(saved).toBeDefined();
    expect(saved!.data!.positions.length).toBe((raw.positions as unknown[]).length); // no claim lost
    expect(saved!.data!.calculations!.length).toBe((raw.calculations as unknown[]).length - 1); // the un-evidenced calc dropped
    expect(saved!.data!.deliverable_proposals!.length).toBe((raw.deliverable_proposals as unknown[]).length - 1); // the DECISION proposal dropped
  });
});

describe('T4: S4 repairs yield to the reserved tail', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aiki-s4-tail-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const agyPayload = readFileSync('test/fixtures/f740-s4-agy-first.out.txt', 'utf8');

  function makeCtx(budget: number): RunCtx {
    const handles: ProviderHandle[] = (['agy', 'codex', 'claude'] as ProviderId[]).map((id) => {
      const adapter: Adapter = {
        id,
        run: async (): Promise<RunResultAdapter> => ({ ok: true, text: agyPayload, json: extractJson(agyPayload), durationMs: 1 }),
      };
      return { id, adapter, flags: { id, jsonOutput: true, readOnlyFlag: 'sandbox' }, readOnly: 'sandbox', version: '9.9.9' };
    });
    const writer = new RunWriter(makeRunId('idea-refinement'), root);
    return new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode: 'council',
      handles,
      roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
      writer,
      cwd: writer.dir,
      budget,
    });
  }

  const prompts = { 'market-adoption': 'lane one', 'economics-delivery': 'lane two' } as const;

  it('skips the paid repair and salvages when a repair could starve the tail', async () => {
    const ctx = makeCtx(4); // 4 remaining < 2 seats + 2 repairs + 3-call tail
    const seats = await s4Analyze(ctx, prompts);
    expect(seats).toHaveLength(2);
    expect(ctx.calls.map((call) => call.stage).sort()).toEqual(['S4-agy', 'S4-codex']);
  });

  it('still repairs (content-preserving) when the budget comfortably covers the tail', async () => {
    const ctx = makeCtx(12);
    const seats = await s4Analyze(ctx, prompts);
    expect(seats).toHaveLength(2);
    expect(ctx.calls.map((call) => call.stage).sort()).toEqual(['S4-agy', 'S4-agy-repair', 'S4-codex', 'S4-codex-repair']);
  });
});
