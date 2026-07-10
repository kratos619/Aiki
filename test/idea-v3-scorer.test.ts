import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { IdeaV3CaseManifest, scoreDecisionInsights, summarizeDecisionInsights } from '../src/bench/scoring/decision-insights.js';

describe('idea-v3 decision-critical insight scorer', () => {
  it('scores a correct, stance-aligned claim as full recall, precision, and F1', () => {
    const score = scoreDecisionInsights({
      expected_claims: [{
        id: 'E1',
        proposition: 'The fixed price is unsupported without willingness-to-pay evidence.',
        acceptable_stances: ['UNRESOLVED'],
        evidence_required: false,
      }],
      report_claims: [{
        id: 'R1',
        stance: 'UNRESOLVED',
        fact_kind: 'INFERENCE',
        correct: true,
        relevant: true,
        evidence_status: 'NOT_REQUIRED',
      }],
      matches: [{ expected_claim_id: 'E1', report_claim_id: 'R1' }],
    });

    expect(score).toMatchObject({ expected: 1, matched: 1, reported: 1, true_positive_reports: 1 });
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.f1).toBe(1);
  });

  it('does not count an evidence-free current fact as a true positive', () => {
    const score = scoreDecisionInsights({
      expected_claims: [{
        id: 'E1',
        proposition: 'The current fee covers loaded employment costs.',
        acceptable_stances: ['SUPPORT'],
        evidence_required: true,
      }],
      report_claims: [{
        id: 'R1',
        stance: 'SUPPORT',
        fact_kind: 'CURRENT_FACT',
        correct: true,
        relevant: true,
        evidence_status: 'UNSUPPORTED',
      }],
      matches: [{ expected_claim_id: 'E1', report_claim_id: 'R1' }],
    });

    expect(score).toMatchObject({ matched: 0, true_positive_reports: 0, recall: 0, precision: 0, f1: 0 });
  });

  it('rejects matches that reuse an expert or report claim', () => {
    const duplicated = {
      expected_claims: [{
        id: 'E1',
        proposition: 'The claim is unresolved.',
        acceptable_stances: ['UNRESOLVED' as const],
        evidence_required: false,
      }],
      report_claims: [{
        id: 'R1',
        stance: 'UNRESOLVED' as const,
        fact_kind: 'INFERENCE' as const,
        correct: true,
        relevant: true,
        evidence_status: 'NOT_REQUIRED' as const,
      }],
      matches: [
        { expected_claim_id: 'E1', report_claim_id: 'R1' },
        { expected_claim_id: 'E1', report_claim_id: 'R1' },
      ],
    };

    expect(() => scoreDecisionInsights(duplicated)).toThrow(/one-to-one/);
  });

  it('rejects matches to undeclared claim ids', () => {
    const invalid = {
      expected_claims: [],
      report_claims: [],
      matches: [{ expected_claim_id: 'missing-expected', report_claim_id: 'missing-report' }],
    };

    expect(() => scoreDecisionInsights(invalid)).toThrow(/declared/);
  });

  it('rejects duplicate expert or report claim ids', () => {
    const invalid = {
      expected_claims: [
        { id: 'E1', proposition: 'First.', acceptable_stances: ['SUPPORT' as const], evidence_required: false },
        { id: 'E1', proposition: 'Duplicate.', acceptable_stances: ['OPPOSE' as const], evidence_required: false },
      ],
      report_claims: [],
      matches: [],
    };

    expect(() => scoreDecisionInsights(invalid)).toThrow(/unique/);
  });

  it('aggregates counts across cases before calculating F1', () => {
    const summary = summarizeDecisionInsights([
      { expected: 1, matched: 1, reported: 1, true_positive_reports: 1, recall: 1, precision: 1, f1: 1 },
      { expected: 3, matched: 0, reported: 1, true_positive_reports: 0, recall: 0, precision: 0, f1: 0 },
    ]);

    expect(summary.recall).toBe(0.25);
    expect(summary.precision).toBe(0.5);
    expect(summary.f1).toBeCloseTo(1 / 3);
  });

  it('validates the frozen case-manifest fields', () => {
    const manifest = IdeaV3CaseManifest.parse({
      id: 'case-1',
      title: 'A build case',
      set: 'build',
      provenance: 'INSPECTED_BUILD',
      tags: ['evidence-poor'],
      input_file: 'input.md',
      critical_claims: [{
        id: 'E1',
        proposition: 'The decision remains unresolved.',
        acceptable_stances: ['UNRESOLVED'],
        evidence_required: false,
      }],
      common_false_claims: [{ id: 'F1', claim: 'A false certainty.', reason: 'No evidence was supplied.' }],
      required_dimensions: Array.from({ length: 12 }, (_, i) => `dimension-${i + 1}`),
      source_pack: [],
      acceptable_unresolved_outcomes: [{ claim_id: 'E1', reason: 'The input contains no deciding evidence.' }],
    });

    expect(manifest.critical_claims[0]?.id).toBe('E1');
  });

  it('loads the sanitized water and nurse build fixtures', async () => {
    const base = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build');
    const cases = ['01-water-reminder', '02-nurse-marketplace'];
    for (const name of cases) {
      const dir = join(base, name);
      const manifestText = await readFile(join(dir, 'case.json'), 'utf8');
      const input = await readFile(join(dir, 'input.md'), 'utf8');
      const manifest = IdeaV3CaseManifest.parse(JSON.parse(manifestText));
      expect(manifest.input_file).toBe('input.md');
      expect(`${manifestText}\n${input}`).not.toMatch(/\/Users\/|api[_ -]?key|bearer\s|sk-[a-z0-9]/i);
    }
  });

  it('captures only the required sanitized nurse regression outputs', async () => {
    const dir = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build', '02-nurse-marketplace', 'regression');
    const names = [
      '07-disagreement-map.json',
      '08-verifications.json',
      '09-judge-report.json',
      '09b-first.out',
      '09b-repair.out',
    ];
    const contents = await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')));
    for (const text of contents.slice(0, 3)) expect(() => JSON.parse(text!)).not.toThrow();
    expect(contents.every((text) => text.length > 40)).toBe(true);
    expect(contents.join('\n')).not.toMatch(/\/Users\/|api[_ -]?key|bearer\s|sk-[a-z0-9]/i);
  });
});
