import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderDecisionDossierMarkdown } from '../src/orchestration/decision-dossier.js';
import { buildLanePrompts } from '../src/orchestration/idea-lanes.js';
import { loadSkill } from '../src/orchestration/skills.js';
import { renderTerminalSummary, type DecisionReportJson } from '../src/orchestration/stages/s10-render.js';
import { renderCouncilHtml, type CouncilView } from '../src/council/view.js';
import { buildAnalystPrompt, buildIdeaRubric } from '../src/workflows/idea-refinement.js';
import type { DecisionContract, IntentContract } from '../src/schemas/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'c289');
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;
const legacyReport = readJson<DecisionReportJson>('10-decision-report.json');
const report: DecisionReportJson = {
  ...legacyReport,
  flags: [],
  decisionSnapshot: {
    decisiveNumbers: [{ label: 'Capital cost', value: 'Unknown', meaning: 'The remaining effort was not supplied.', claimIds: ['G1'] }],
    payback: { status: 'NOT_COMPUTABLE', result: 'Not enough information', basis: 'No known commitment', claimIds: ['G1'] },
    options: [
      { label: 'Focused demo', commitment: 'Unknown', commitmentKind: 'UNKNOWN', tradeoff: 'Requires a delivery estimate.', claimIds: [] },
      { label: 'Replay only', commitment: 'Unknown', commitmentKind: 'UNKNOWN', tradeoff: 'Reduces implementation risk.', claimIds: [] },
    ],
  },
  dossier: {
    ...legacyReport.dossier,
    readerBrief: {
      headline: 'Build `aiki serve` as a focused council workspace',
      bottom_line: 'Make the visible multi-model debate the product: start with replay, add a narrow local control plane, and avoid turning Aiki into another chat wrapper.',
      sections: [
        {
          heading: 'Product direction',
          summary: 'Lead with one job: help a developer watch competing analyses become a defensible decision.',
          bullets: ['Ship a browser workspace before considering Electron.', 'Keep the CLI engine as the source of truth.'],
        },
        {
          heading: 'Standout demo moments',
          summary: 'Show the disagreement map, live evidence trail, and chair decision as one coherent story.',
          bullets: ['Let judges replay how each model changed the final answer.', 'Make trust visible without forcing users to read the audit.'],
        },
      ],
      next_step: 'Build the read-only replay golden path and test it with five saved council runs.',
      caveats: ['Live browser-triggered execution still needs a narrow security and cancellation gate.', 'Confirm the hackathon submission format before depending on localhost-only judging.'],
      source_ids: ['codex/E1', 'codex/E3'],
    },
    featureBacklog: {
      must: [{ feature: 'Council replay', user_value: 'Makes the decision legible.', rationale: 'It is the smallest reliable demo.', effort: 'M' }],
      should: [],
      later: [],
      wont: [{ feature: 'General chat', reason: 'It dilutes the decision workflow.' }],
    },
    implementationPlan: {
      milestones: [{ order: 1, timebox: 'First phase', outcome: 'One replay is useful.', tasks: ['Render one saved council run.'], acceptance_test: 'A new viewer can explain the verdict.' }],
    },
  },
};
const contract = {
  ...readJson<IntentContract>('01-intent-contract.json'),
  requested_outputs: ['DECISION', 'FEATURE_BACKLOG', 'IMPLEMENTATION_PLAN'],
} as DecisionContract;

const markdown = renderDecisionDossierMarkdown(report);
const reader = markdown.split('## Council audit')[0]!;
const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
const htmlFor = (decisionReport: DecisionReportJson): string => renderCouncilHtml({
  runId: decisionReport.reportId,
  workflow: 'idea-refinement',
  mode: decisionReport.mode,
  verdict: decisionReport.verdict.summary,
  keyPoints: [],
  confidence: '',
  dissent: [],
  columns: [],
  rows: [],
  stats: [],
  calls: '',
  flags: decisionReport.flags,
  decisionReport,
} as CouncilView);

describe('report v5 — hand-authored reader projection', () => {
  it('keeps the reader answer below 1,800 words', () => {
    expect(words(reader)).toBeLessThanOrEqual(1_800);
  });

  it('keeps internal audit language out of the reader answer', () => {
    expect(reader).not.toMatch(/\b(?:UNVERIFIED|UNVERIFIABLE|PARTIAL)\b|structural score|\bG\d+\b/i);
  });

  it('hides a numeric snapshot when every commitment is unknown and payback is not computable', () => {
    expect(report.decisionSnapshot?.options.every((option) => option.commitmentKind === 'UNKNOWN')).toBe(true);
    expect(report.decisionSnapshot?.payback?.status).toBe('NOT_COMPUTABLE');
    expect(reader).not.toContain('### Decisive numbers');
    expect(reader).not.toContain('Capital cost');
    expect(reader).not.toContain('Payback');
  });

  it('shows a useful numeric snapshot in Markdown and HTML', () => {
    const numeric: DecisionReportJson = {
      ...report,
      decisionSnapshot: {
        decisiveNumbers: [{ label: 'Monthly break-even', value: '₹6.5L', meaning: 'The current case is below this threshold.', claimIds: ['G1'] }],
        payback: { status: 'NOT_ACHIEVED', result: 'More than 12 months', basis: 'Current contribution margin', claimIds: ['G1'] },
        options: [
          { label: 'Pilot', commitment: '₹5L cap', commitmentKind: 'TARGET_CAP', tradeoff: 'Limits downside.', claimIds: ['G1'] },
          { label: 'Full launch', commitment: '₹32L', commitmentKind: 'KNOWN', tradeoff: 'Commits before proof.', claimIds: ['G1'] },
        ],
      },
    };

    const numericMarkdown = renderDecisionDossierMarkdown(numeric).split('## Council audit')[0]!;
    const numericHtml = htmlFor(numeric).slice(0, htmlFor(numeric).indexOf('Council audit —'));
    expect(numericMarkdown).toContain('Monthly break-even');
    expect(numericMarkdown).toContain('₹5L cap');
    expect(numericHtml).toContain('Monthly break-even');
    expect(numericHtml).toContain('₹5L cap');
  });

  it('shows material warnings before the audit and prioritizes one in the terminal', () => {
    const warned = { ...report, flags: [...report.flags, 'low_diversity', 'weak_seat', 'deliverable_gap', 'research_ungrounded'] };
    const warnedMarkdown = renderDecisionDossierMarkdown(warned);
    const warnedHtml = htmlFor(warned);
    expect(warnedMarkdown.split('## Council audit')[0]).toContain('Independent diversity was reduced');
    expect(warnedMarkdown.split('## Council audit')[0]).toContain('Source investigation did not produce a cited public source');
    expect(warnedMarkdown.split('## Council audit')[0]).toContain('omitted a requested feature or implementation proposal');
    expect(warnedHtml.slice(0, warnedHtml.indexOf('Council audit —'))).toContain('Independent diversity was reduced');
    const terminal = renderTerminalSummary(warned, { markdownPath: '/run/final-report.md', jsonPath: '/run/10-decision-report.json' });
    expect(terminal).toContain('Warning: Independent diversity was reduced');
    expect(terminal.split('\n').filter((line) => line.trim()).length).toBeLessThanOrEqual(16);
  });

  it('deduplicates public sources and masks every local locator before the audit', () => {
    const base = report.dossier.evidence[0]!;
    const citedClaimId = report.claims[0]!.id;
    const sourced: DecisionReportJson = {
      ...report,
      dossier: {
        ...report.dossier,
        readerBrief: { ...report.dossier.readerBrief!, source_ids: ['S1', 'S2', 'S3', 'S4', 'S5'] },
        evidence: [
          { ...base, id: 'S1', title: 'Public rules', url: undefined, source: 'https://example.com/rules', claimIds: [citedClaimId] },
          { ...base, id: 'S2', title: 'Duplicate rules', url: undefined, source: 'https://example.com/rules', claimIds: [citedClaimId] },
          { ...base, id: 'S3', sourceKind: 'USER', source: '/Users/private/input.md', title: undefined, url: undefined },
          { ...base, id: 'S4', sourceKind: 'USER', source: '../private/input.md', title: undefined, url: undefined },
          { ...base, id: 'S5', sourceKind: 'USER', source: 'C:\\private\\input.md', title: undefined, url: undefined },
        ],
      },
    };

    const beforeAudit = renderDecisionDossierMarkdown(sourced).split('## Council audit')[0]!;
    const htmlBeforeAudit = htmlFor(sourced).split('Council audit —')[0]!;
    expect(beforeAudit.match(/https:\/\/example\.com\/rules/g)).toHaveLength(1);
    expect(beforeAudit).toContain('User-supplied material');
    expect(beforeAudit.match(/User-supplied material/g)).toHaveLength(1);
    expect(beforeAudit).toContain('Cited for:');
    expect(htmlBeforeAudit).toContain('Cited for:');
    expect(beforeAudit).not.toMatch(/\/tmp\/|\/Users\/|\.\.\/private|C:\\private|file:/);
    expect(htmlBeforeAudit).not.toMatch(/\/tmp\/|\/Users\/|\.\.\/private|C:\\private|file:/);
  });

  it('keeps an already-persisted report without a reader brief on the legacy path', () => {
    const legacyMarkdown = renderDecisionDossierMarkdown(legacyReport);
    expect(legacyMarkdown).toMatch(/^# Multi-Model Decision Report/);
    expect(legacyMarkdown).not.toContain('## Council audit');
  });

  it('retains every requested practical deliverable', () => {
    const requested = contract.requested_outputs ?? ['DECISION'];
    if (requested.includes('FEATURE_BACKLOG')) expect(report.dossier.featureBacklog).toBeTruthy();
    if (requested.includes('IMPLEMENTATION_PLAN')) expect(report.dossier.implementationPlan).toBeTruthy();
  });

  it('keeps the terminal handoff to 16 lines without audit scoring', () => {
    const terminal = renderTerminalSummary(report, { markdownPath: '/run/final-report.md', jsonPath: '/run/10-decision-report.json' });
    expect(terminal.split('\n').filter((line) => line.trim()).length).toBeLessThanOrEqual(16);
    expect(terminal).not.toMatch(/structural score|verification coverage|audit json|decision state|consensus:/i);
  });

  it('uses the same concise reader brief in HTML and copied Markdown', () => {
    const html = htmlFor(report);
    const visible = html.slice(0, html.indexOf('Council audit —'));

    expect(visible).toContain('Build `aiki serve` as a focused council workspace');
    expect(visible).not.toMatch(/structural score|verification coverage|\bG\d+\b|headless intent/i);
    expect(html).toContain(`const REPORT_MD = ${JSON.stringify(markdown).replace(/</g, '\\u003c')};`);
  });
});

describe('report v5 — council creates requested deliverables', () => {
  it('gives both scout lanes typed proposal instructions with complementary creative roles', () => {
    const decisionContract = contract as DecisionContract;
    const base = buildAnalystPrompt(
      decisionContract,
      '/tmp/idea.md',
      undefined,
      'council',
      loadSkill('idea-refinement', 'analyst'),
    );
    const lanes = buildLanePrompts(base, buildIdeaRubric(decisionContract.domain_dimensions));

    expect(base).toContain('deliverable_proposals');
    expect(lanes['market-adoption']).toMatch(/visionary|product strategist/i);
    expect(lanes['economics-delivery']).toMatch(/skeptic|executor/i);
    expect(lanes['market-adoption']).toContain('FEATURE_BACKLOG');
    expect(lanes['economics-delivery']).toContain('FEATURE_BACKLOG');
  });
});
