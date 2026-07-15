import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateCalculation } from '../src/orchestration/calculations.js';
import { compileDecisionGraph, type AnalystSubmission } from '../src/orchestration/decision-graph.js';
import { buildEvidencePack } from '../src/orchestration/evidence-pack.js';
import type { RunCtx } from '../src/orchestration/context.js';
import { s9Judge } from '../src/orchestration/stages/s9-judge.js';
import { EvidenceCard, type CalculationLedger } from '../src/schemas/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const calculation = (step: CalculationLedger['steps'][number]): CalculationLedger => ({
  id: 'C1',
  claim_id: 'P1',
  inputs: [
    { id: 'I1', name: 'monthly price', value: 10, unit: 'USD/customer', evidence_ids: ['E1'] },
    { id: 'I2', name: 'customers', value: 3, unit: 'customer', evidence_ids: ['E1'] },
  ],
  steps: [step],
  result_step: step.id,
});

function submission(proposition: string, stance: 'SUPPORT' | 'OPPOSE' = 'SUPPORT'): AnalystSubmission {
  return {
    task_echo: 'evaluate the fee',
    strongest_version: 'A focused version may work.',
    positions: [{
      local_id: 'P1', proposition, dimension_id: 'R8', stance, basis: 'EVIDENCE', load_bearing: true,
      if_false: 'STOP', reasoning: 'The fee must cover the cost base.', evidence_ids: ['E1'], depends_on: [],
    }],
    evidence: [{
      id: 'E1', claim_supported: proposition, source_kind: 'USER',
      support: stance === 'OPPOSE' ? 'CONTRADICTS' : 'SUPPORTS', freshness: 'CURRENT',
    }],
    coverage: [{ dimension_id: 'R8', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 covers pricing.' }],
    decision_questions: [],
  };
}

describe('R4 evidence packs', () => {
  it('stores deterministic absolute paths and hashes, not source contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiki-evidence-'));
    roots.push(root);
    const path = join(root, 'study.txt');
    const content = 'measured adoption: 42%';
    await writeFile(path, content);

    const pack = await buildEvidencePack(root);

    expect(pack.files).toEqual([{
      path: await realpath(path),
      sha256: createHash('sha256').update(content).digest('hex'),
    }]);
    expect(JSON.stringify(pack)).not.toContain(content);
  });
});

describe('R4 evidence and calculation integrity', () => {
  it('requires locators/access dates for current external evidence and never calls model memory current', () => {
    expect(() => EvidenceCard.parse({
      id: 'E1', claim_supported: 'Current price is $10', source_kind: 'PRIMARY',
      url: 'https://example.com/price', support: 'SUPPORTS', freshness: 'CURRENT',
    })).toThrow(/accessed_at/);
    expect(() => EvidenceCard.parse({
      id: 'E1', claim_supported: 'Current price is $10', source_kind: 'MODEL_KNOWLEDGE',
      support: 'SUPPORTS', freshness: 'CURRENT',
    })).toThrow(/cannot claim current freshness/);
    expect(EvidenceCard.parse({
      id: 'E1', claim_supported: 'Current price is $10', source_kind: 'PRIMARY',
      url: 'https://example.com/price', accessed_at: '2026-07-13', support: 'SUPPORTS', freshness: 'CURRENT',
    })).toMatchObject({ accessed_at: '2026-07-13' });
  });

  it('catches planted operation and unit errors with the pure evaluator', () => {
    expect(evaluateCalculation(calculation({
      id: 'S1', operation: 'MULTIPLY', left: 'I1', right: 'I2', result: 30, unit: 'USD',
    }))).toMatchObject({ status: 'PASS', issues: [] });

    const bad = evaluateCalculation(calculation({
      id: 'S1', operation: 'ADD', left: 'I1', right: 'I2', result: 30, unit: 'USD/month',
    }));
    expect(bad.status).toBe('FAIL');
    expect(bad.issues.join(' ')).toMatch(/matching units|does not match/);
  });

  it('canonicalizes ordinary plural, currency-margin, and ratio units', () => {
    const ledger: CalculationLedger = {
      id: 'C-rate',
      claim_id: 'P1',
      inputs: [
        { id: 'visitors', name: 'monthly visitors', value: 4000, unit: 'visitors/month', evidence_ids: ['E1'] },
        { id: 'conversion', name: 'conversion', value: 0.06, unit: 'orders/visitor', evidence_ids: ['E1'] },
        { id: 'aov', name: 'average order value', value: 2400, unit: 'INR/order', evidence_ids: ['E1'] },
        { id: 'margin', name: 'gross margin', value: 0.58, unit: 'INR gross profit/INR revenue', evidence_ids: ['E1'] },
        { id: 'share', name: 'revenue share', value: 0.08, unit: 'ratio', evidence_ids: ['E1'] },
      ],
      steps: [
        { id: 'orders', operation: 'MULTIPLY', left: 'visitors', right: 'conversion', result: 240, unit: 'orders/month' },
        { id: 'revenue', operation: 'MULTIPLY', left: 'orders', right: 'aov', result: 576000, unit: 'INR/month' },
        { id: 'gross_profit', operation: 'MULTIPLY', left: 'revenue', right: 'margin', result: 334080, unit: 'INR/month' },
        { id: 'revenue_share', operation: 'MULTIPLY', left: 'revenue', right: 'share', result: 46080, unit: 'INR/month' },
      ],
      result_step: 'gross_profit',
    };

    expect(evaluateCalculation(ledger)).toMatchObject({ status: 'PASS', issues: [] });
  });

  it('keeps a load-bearing claim unresolved when its deterministic calculation fails', () => {
    const input = submission('A $10 price across 3 customers produces $30 monthly revenue.');
    input.calculations = [calculation({
      id: 'S1', operation: 'ADD', left: 'I1', right: 'I2', result: 30, unit: 'USD',
    })];
    const graph = compileDecisionGraph([{ provider: 'agy', submission: input }], [{ id: 'R8', label: 'business model' }]);

    expect(graph.calculation_checks[0]?.status).toBe('FAIL');
    expect(graph.claims[0]).toMatchObject({ state: 'UNCERTAIN', evidence_state: 'UNVERIFIED' });
    expect(graph.holes.evidence[0]?.reason).toContain('deterministic calculation failed');
  });
});

describe('R4 chair boundary', () => {
  it('rejects a bad evidence id before acquiring/calling the chair', async () => {
    const proposition = 'A 15% fee covers loaded costs.';
    const graph = compileDecisionGraph([
      { provider: 'agy', submission: submission(proposition, 'SUPPORT') },
      { provider: 'codex', submission: submission(proposition, 'OPPOSE') },
    ], [{ id: 'R8', label: 'business model' }], [['agy/P1', 'codex/P1']]);
    let chairTouched = false;
    const ctx = {
      roles: { judge: 'claude' },
      handle: () => {
        chairTouched = true;
        throw new Error('chair should not be touched');
      },
    } as unknown as RunCtx;

    await expect(s9Judge(
      ctx,
      { task: 'evaluate the fee', task_type: 'idea-refinement', constraints: [], unknowns: [], success_criteria: [] },
      graph,
      { verifications: [{ claim_id: 'G1', status: 'VERIFIED', reasoning: 'bad ref', evidence_ids: ['E999'], missing_evidence: [] }] },
      [{ id: 'R8', label: 'business model', keywords: ['fee'] }],
    )).rejects.toThrow(/invalid verification references/);
    expect(chairTouched).toBe(false);
  });
});
