import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunCtx, makeRunId } from '../src/orchestration/context.js';
import { deterministicContract } from '../src/orchestration/preflight.js';
import { s5Drift } from '../src/orchestration/stages/s5-drift.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';
import { RunWriter } from '../src/storage/runs.js';
import type { IntentContract, IdeaRoleOutput } from '../src/schemas/index.js';
import type { ProviderId } from '../src/providers/types.js';

import fixture from './fixtures/s5-drift-626e.json' with { type: 'json' };

// Run 20260718-1536-idea-refinement-626e (REAL, 2026-07-18): S5 excluded BOTH seats — codex
// (12 positions, echo overlap 0.294) and agy (6 positions, 0.250) — and killed the run QUORUM,
// yet both echoes are accurate paraphrases of the task. Root cause: the reference token set was
// ONLY the one-sentence contract task (17 tokens, model-authored vocabulary), so paraphrase
// distance — which the stage explicitly documents it does NOT penalize — was exactly what it
// measured. Fix: compare against the contract the seat was told to address (task + constraints
// + success_criteria). Measured on this run: codex 0.680 / agy 0.500, while a genuinely
// off-task echo stays at ~0.08 — the 0.3 threshold is untouched.

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-s5-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): RunCtx {
  const writer = new RunWriter(makeRunId('idea-refinement'), root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles: [],
    roles: { analyst: 'claude', judge: 'claude', verifier: 'claude', s4: ['claude'] },
    writer,
    cwd: writer.dir,
    budget: 12,
  });
}

const contract = fixture.contract as IntentContract;

function seat(provider: string, task_echo: string, positionCount: number): SeatOutput {
  return {
    provider: provider as ProviderId,
    output: { task_echo, positions: new Array(positionCount).fill({}) } as IdeaRoleOutput,
  };
}

const realSeats = fixture.seats.map((s) => seat(s.provider, s.task_echo, s.position_count));

describe('s5Drift', () => {
  it('REPLAY 626e: both real on-task paraphrase echoes survive (was: QUORUM kill)', async () => {
    const { report, kept } = await s5Drift(makeCtx(), contract, realSeats);
    expect(kept.map((s) => s.provider)).toEqual(['codex', 'agy']);
    expect(report.excluded).toEqual([]);
    for (const entry of report.entries) expect(entry.on_task).toBe(true);
  });

  it('a genuinely off-task echo is still excluded — the gate keeps its teeth', async () => {
    const drifted = seat(
      'codex',
      'Audit the npm registry package for malware and typosquatting, then report supply chain vulnerabilities in its dependency tree.',
      5,
    );
    const { report, kept } = await s5Drift(makeCtx(), contract, [realSeats[0]!, realSeats[1]!, drifted]);
    expect(kept).toHaveLength(2);
    expect(report.entries[2]!.on_task).toBe(false);
  });

  it('accepts an on-task fast-path contract with empty constraints', async () => {
    const input = 'Should I use Postgres or MySQL for my side project?';
    const fastContract = deterministicContract(input, ['feasibility']);
    const { kept } = await s5Drift(makeCtx(), fastContract, [seat('claude', input, 1)], 1);

    expect(fastContract.constraints).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it('no positions is still excluded regardless of echo', async () => {
    const empty = seat('agy', contract.task, 0);
    const { report } = await s5Drift(makeCtx(), contract, [realSeats[0]!, empty], 1);
    expect(report.excluded).toEqual(['agy']);
    expect(report.entries[1]!.evidence).toBe('no positions produced');
  });

  it('below-quorum survivors still abort the run', async () => {
    const d1 = seat('codex', 'Summarize the latest trends in cloud pricing and recommend a database vendor.', 3);
    const d2 = seat('agy', 'Write a poem about the sea.', 3);
    await expect(s5Drift(makeCtx(), contract, [d1, d2])).rejects.toThrow(/drift exclusion left 0/);
  });
});
