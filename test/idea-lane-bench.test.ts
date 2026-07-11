import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chooseLaneDefault, planIdeaLaneBench, runIdeaLaneBench, scoreLaneObservation, type LaneRotationObservation } from '../src/bench/idea-lane-rotation.js';
import type { ProviderHandle } from '../src/orchestration/context.js';
import type { ProviderId } from '../src/providers/types.js';

function handle(id: ProviderId): ProviderHandle {
  return {
    id,
    adapter: { id, run: async () => ({ ok: false, error: 'CRASH', stderrTail: 'must not run', durationMs: 0 }) },
    flags: { id, jsonOutput: true, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  };
}

let temp: string | undefined;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe('idea lane build-set rotation harness', () => {
  it('plans both provider/lane rotations for every sanitized build case without model calls', async () => {
    const plan = await planIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
    });

    expect(plan.cases).toEqual(['water-reminder', 'nurse-marketplace']);
    expect(plan.runs).toHaveLength(4);
    expect(plan.runs[0]).toMatchObject({ rotation: 'agy-market', s4: ['agy', 'codex'] });
    expect(plan.runs[1]).toMatchObject({ rotation: 'codex-market', s4: ['codex', 'agy'] });
    expect(plan.estimatedCalls).toBe(52);
  });

  it('chooses the assignment by recall, then evidence precision and operating metrics', () => {
    const observation = (
      case_id: string,
      rotation: LaneRotationObservation['rotation'],
      decision_critical_recall: number,
      evidence_precision: number,
    ): LaneRotationObservation => ({
      case_id,
      rotation,
      run_id: `${case_id}-${rotation}`,
      decision_critical_recall,
      evidence_precision,
      json_repair_rate: rotation === 'agy-market' ? 0.1 : 0,
      latency_ms: rotation === 'agy-market' ? 1200 : 900,
      unique_supported_contributions: { agy: 1, codex: 0 },
    });
    const results = [
      observation('water-reminder', 'agy-market', 0.9, 0.8),
      observation('nurse-marketplace', 'agy-market', 0.7, 0.8),
      observation('water-reminder', 'codex-market', 0.7, 1),
      observation('nurse-marketplace', 'codex-market', 0.7, 1),
    ];

    expect(chooseLaneDefault(results)).toBe('agy-market');
  });

  it('refuses to freeze a default from incomplete rotation data', () => {
    expect(chooseLaneDefault([{
      case_id: 'water-reminder',
      rotation: 'agy-market',
      run_id: 'water-agy-market',
      decision_critical_recall: 1,
      evidence_precision: 1,
      json_repair_rate: 0,
      latency_ms: 1000,
      unique_supported_contributions: { agy: 1, codex: 0 },
    }])).toBeNull();
  });

  it('executes the full matrix through an injectable no-model boundary and persists observations', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const seen: string[] = [];
    const resultsPath = join(temp, 'results.json');
    const result = await runIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      resultsPath,
      execute: async (target) => {
        seen.push(`${target.case_id}:${target.rotation}`);
        return {
          case_id: target.case_id,
          rotation: target.rotation,
          run_id: `${target.case_id}-${target.rotation}`,
          decision_critical_recall: null,
          evidence_precision: null,
          json_repair_rate: 0,
          latency_ms: 1,
          unique_supported_contributions: { agy: 0, codex: 0 },
        };
      },
    });

    expect(seen).toHaveLength(4);
    expect(result.observations).toHaveLength(4);
    expect(JSON.parse(await readFile(resultsPath, 'utf8')).observations).toHaveLength(4);
  });

  it('fills blinded quality metrics through the frozen decision-insight scorer', () => {
    const pending: LaneRotationObservation = {
      case_id: 'water-reminder', rotation: 'agy-market', run_id: 'run-1',
      decision_critical_recall: null, evidence_precision: null, json_repair_rate: 0,
      latency_ms: 1000, unique_supported_contributions: { agy: 1, codex: 0 },
    };
    const scored = scoreLaneObservation(pending, {
      expected_claims: [{ id: 'W1', proposition: 'Price is unsupported.', acceptable_stances: ['UNRESOLVED'], evidence_required: false }],
      report_claims: [{ id: 'G1', stance: 'UNRESOLVED', fact_kind: 'INFERENCE', correct: true, relevant: true, evidence_status: 'NOT_REQUIRED' }],
      matches: [{ expected_claim_id: 'W1', report_claim_id: 'G1' }],
    });

    expect(scored).toMatchObject({ decision_critical_recall: 1, evidence_precision: 1 });
  });
});
