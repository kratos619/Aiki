import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLaneRunDiversity, chooseLaneDefault, findLatestLaneResults, importLaneAdjudications, planIdeaLaneBench, runIdeaLaneBench, scoreLaneObservation, type LaneRotationObservation } from '../src/bench/idea-lane-rotation.js';
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

    expect(plan.cases).toEqual([
      'water-reminder',
      'nurse-marketplace',
      'postgres-multitenancy',
      'library-sunday-hours',
      'school-ai-tutor',
      'restaurant-surplus-marketplace',
      'heat-pump-financing',
      'support-four-day-week',
    ]);
    expect(plan.runs).toHaveLength(16);
    expect(plan.runs[0]).toMatchObject({ rotation: 'agy-market', s4: ['agy', 'codex'] });
    expect(plan.runs[1]).toMatchObject({ rotation: 'codex-market', s4: ['codex', 'agy'] });
    expect(plan.estimatedCalls).toBe(128);
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

    expect(seen).toHaveLength(16);
    expect(result.observations).toHaveLength(16);
    expect(JSON.parse(await readFile(resultsPath, 'utf8')).observations).toHaveLength(16);
  });

  it('finds the latest dated lane results file and ignores non-campaign files', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const dir = join(temp, 'bench', 'results');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'idea-lanes-2026-07-10.json'), '{}', 'utf8');
    await writeFile(join(dir, 'idea-lanes-2026-07-11.json'), '{}', 'utf8');
    await writeFile(join(dir, 'idea-lanes-2026-07-11.void.json'), '{}', 'utf8');

    expect(await findLatestLaneResults(temp)).toBe(join(dir, 'idea-lanes-2026-07-11.json'));
    expect(await findLatestLaneResults(join(temp, 'nope'))).toBeNull();
  });

  it('resumes a partial results file: keeps prior observations, pays only for missing pairs', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    const prior = {
      case_id: 'school-ai-tutor', rotation: 'agy-market', run_id: 'kept-run',
      decision_critical_recall: null, evidence_precision: null, json_repair_rate: 0.25,
      latency_ms: 1080352, unique_supported_contributions: { agy: 1, codex: 1 },
    };
    await writeFile(resultsPath, JSON.stringify({ at: '2026-07-11T18:41:36.305Z', observations: [prior] }), 'utf8');

    const seen: string[] = [];
    const result = await runIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      resultsPath,
      resume: true,
      execute: async (target) => {
        seen.push(`${target.case_id}:${target.rotation}`);
        return {
          case_id: target.case_id, rotation: target.rotation,
          run_id: `${target.case_id}-${target.rotation}`,
          decision_critical_recall: null, evidence_precision: null, json_repair_rate: 0,
          latency_ms: 1, unique_supported_contributions: { agy: 0, codex: 0 },
        };
      },
    });

    expect(seen).toHaveLength(15);
    expect(seen).not.toContain('school-ai-tutor:agy-market');
    expect(result.observations).toHaveLength(16);
    const persisted = JSON.parse(await readFile(resultsPath, 'utf8')).observations;
    expect(persisted).toHaveLength(16);
    expect(persisted.map((o: LaneRotationObservation) => o.run_id)).toContain('kept-run');
  });

  it('plans a resume with the reduced pair count and call estimate', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    await writeFile(resultsPath, JSON.stringify({
      at: '2026-07-11T18:41:36.305Z',
      observations: [{
        case_id: 'school-ai-tutor', rotation: 'agy-market', run_id: 'kept-run',
        decision_critical_recall: null, evidence_precision: null, json_repair_rate: 0.25,
        latency_ms: 1080352, unique_supported_contributions: { agy: 1, codex: 1 },
      }],
    }), 'utf8');

    const plan = await planIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      resultsPath,
      resume: true,
    });

    expect(plan.runs).toHaveLength(15);
    expect(plan.runs.map((r) => `${r.case}:${r.rotation}`)).not.toContain('school-ai-tutor:agy-market');
    expect(plan.estimatedCalls).toBe(120);
    expect(plan.resumedFrom).toBe(resultsPath);
  });

  const pendingObservation = (case_id: string, rotation: LaneRotationObservation['rotation']): LaneRotationObservation => ({
    case_id, rotation, run_id: `${case_id}-${rotation}`,
    decision_critical_recall: null, evidence_precision: null, json_repair_rate: 0,
    latency_ms: 1000, unique_supported_contributions: { agy: 1, codex: 0 },
  });
  const adjudication = {
    expected_claims: [{ id: 'W1', proposition: 'Price is unsupported.', acceptable_stances: ['UNRESOLVED'], evidence_required: false }],
    report_claims: [{ id: 'G1', stance: 'UNRESOLVED', fact_kind: 'INFERENCE', correct: true, relevant: true, evidence_status: 'NOT_REQUIRED' }],
    matches: [{ expected_claim_id: 'W1', report_claim_id: 'G1' }],
  };

  it('imports blind adjudications and fills the null metrics through the frozen scorer', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    await writeFile(resultsPath, JSON.stringify({
      at: '2026-07-11T18:41:36.305Z',
      observations: [pendingObservation('school-ai-tutor', 'agy-market'), pendingObservation('school-ai-tutor', 'codex-market')],
    }), 'utf8');
    const importPath = join(temp, 'adjudications.json');
    await writeFile(importPath, JSON.stringify([
      { case_id: 'school-ai-tutor', rotation: 'agy-market', adjudication },
      { case_id: 'school-ai-tutor', rotation: 'codex-market', adjudication },
    ]), 'utf8');

    const result = await importLaneAdjudications({ resultsPath, importPath });

    expect(result.scored).toHaveLength(2);
    expect(result.scored[0]).toMatchObject({ decision_critical_recall: 1, evidence_precision: 1 });
    const persisted = JSON.parse(await readFile(resultsPath, 'utf8')).observations;
    expect(persisted.every((o: LaneRotationObservation) => o.decision_critical_recall !== null && o.evidence_precision !== null)).toBe(true);
  });

  it('refuses an adjudication for a pair the campaign file has not run', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    await writeFile(resultsPath, JSON.stringify({
      at: '2026-07-11T18:41:36.305Z',
      observations: [pendingObservation('school-ai-tutor', 'agy-market')],
    }), 'utf8');
    const importPath = join(temp, 'adjudications.json');
    await writeFile(importPath, JSON.stringify([
      { case_id: 'school-ai-tutor', rotation: 'codex-market', adjudication },
    ]), 'utf8');

    await expect(importLaneAdjudications({ resultsPath, importPath }))
      .rejects.toThrow(/school-ai-tutor:codex-market/);
  });

  it('refuses to overwrite an already-scored pair — blind adjudication is one pass', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    await writeFile(resultsPath, JSON.stringify({
      at: '2026-07-11T18:41:36.305Z',
      observations: [{ ...pendingObservation('school-ai-tutor', 'agy-market'), decision_critical_recall: 0.5, evidence_precision: 0.5 }],
    }), 'utf8');
    const importPath = join(temp, 'adjudications.json');
    await writeFile(importPath, JSON.stringify([
      { case_id: 'school-ai-tutor', rotation: 'agy-market', adjudication },
    ]), 'utf8');

    await expect(importLaneAdjudications({ resultsPath, importPath }))
      .rejects.toThrow(/already scored/);
  });

  it('restricts a metered run to one named case, combined with resume', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-lanes-'));
    const resultsPath = join(temp, 'idea-lanes-2026-07-11.json');
    await writeFile(resultsPath, JSON.stringify({
      at: '2026-07-11T18:41:36.305Z',
      observations: [pendingObservation('school-ai-tutor', 'agy-market')],
    }), 'utf8');

    const plan = await planIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      resultsPath,
      resume: true,
      caseId: 'school-ai-tutor',
    });
    expect(plan.runs).toEqual([{ case: 'school-ai-tutor', rotation: 'codex-market', s4: ['codex', 'agy'] }]);
    expect(plan.estimatedCalls).toBe(8);

    const seen: string[] = [];
    const result = await runIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      resultsPath,
      resume: true,
      caseId: 'school-ai-tutor',
      execute: async (target) => {
        seen.push(`${target.case_id}:${target.rotation}`);
        return pendingObservation(target.case_id, target.rotation);
      },
    });
    expect(seen).toEqual(['school-ai-tutor:codex-market']);
    expect(result.observations).toHaveLength(2);
  });

  it('rejects an unknown --case id instead of silently running nothing', async () => {
    await expect(planIdeaLaneBench({
      root: process.cwd(),
      handles: [handle('agy'), handle('codex'), handle('claude')],
      caseId: 'school-ai-tutorr',
    })).rejects.toThrow(/school-ai-tutorr/);
  });

  it('rejects a low_diversity run as a rotation sample — a dead scout seat is not a valid pair', () => {
    expect(() => assertLaneRunDiversity(['low_diversity'], 'school-ai-tutor/codex-market'))
      .toThrow(/not a valid rotation sample/);
    expect(() => assertLaneRunDiversity([], 'x')).not.toThrow();
    expect(() => assertLaneRunDiversity(undefined, 'x')).not.toThrow();
    expect(() => assertLaneRunDiversity(['plan_fallback'], 'x')).not.toThrow();
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
