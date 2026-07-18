import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { buildDecisionReport, renderTerminalSummary, type DecisionReportJson } from '../src/orchestration/stages/s10-render.js';
import { renderDecisionDossierMarkdown } from '../src/orchestration/decision-dossier.js';
import { renderCouncilHtml } from '../src/council/view.js';
import { buildIdeaRubric } from '../src/workflows/idea-refinement.js';
import { normalizePlannerOutput, anchoredActionPlan, type PlanAnchors } from '../src/orchestration/stages/s9b-plan.js';
import { overlayClaimGroups } from '../src/orchestration/claim-groups.js';
import { coerceToSchema } from '../src/orchestration/jsonStage.js';
import { extractJson } from '../src/providers/adapter-core.js';
import { IdeaRoleOutputModel, salvageIdeaRoleOutputModel, type IntentContract } from '../src/schemas/index.js';
import type { RunCtx } from '../src/orchestration/context.js';
import type { DecisionGraph } from '../src/orchestration/decision-graph.js';
import type { ProviderId } from '../src/providers/types.js';

// T9 + T11 (plan/AIKI-v6-council-integrity-plan.md): the exact artifacts of run f740, replayed
// through the v6 pipeline, must produce the report the user should have received on 2026-07-17.

const read = (name: string): string => readFileSync(`test/fixtures/${name}`, 'utf8');
const contract = JSON.parse(read('f740-contract.json')) as IntentContract & { requested_outputs: Array<'DECISION' | 'FEATURE_BACKLOG' | 'IMPLEMENTATION_PLAN'> };
const baseGraph = JSON.parse(read('f740-graph.json')) as DecisionGraph;
const verifications = JSON.parse(read('f740-verifications.json')) as never;
const judgeReport = JSON.parse(read('f740-judge-report.json')) as never;

// Seats: the real S4 first outputs, recovered exactly as the live pipeline now recovers them —
// codex via lossless coercion, agy via salvage (T1/T3).
function seat(provider: ProviderId, fixture: string): { provider: ProviderId; output: never } {
  const json = extractJson(read(fixture));
  const eased = IdeaRoleOutputModel.safeParse(coerceToSchema(IdeaRoleOutputModel, json, false));
  const parsed = eased.success ? eased
    : IdeaRoleOutputModel.safeParse(coerceToSchema(IdeaRoleOutputModel, salvageIdeaRoleOutputModel(json), true));
  expect(parsed.success).toBe(true);
  return { provider, output: { workflow: 'idea-refinement', ...(parsed as { data: object }).data } as never };
}
const seats = [seat('codex', 'f740-s4-codex-first.out.txt'), seat('agy', 'f740-s4-agy-first.out.txt')];

// The planner output that the live run discarded (T2 recovers it).
const plannerRaw = JSON.parse(read('f740-s9b-first.out.txt').match(/```json\s*([\s\S]*?)```/)![1]!);
const anchors: PlanAnchors = {
  claimIds: baseGraph.claims.map((claim) => claim.id),
  knownReaderIds: baseGraph.claims.map((claim) => claim.id),
  blindSpots: baseGraph.holes.coverage.map((hole) => hole.label),
  openQuestions: [
    'Can the existing Aiki engine stream structured stage events and cancel a provider process reliably within the first 48 hours?',
    'Does a prepared council demo visibly produce a better supported decision than the strongest single-provider result?',
  ],
  sourceIds: baseGraph.evidence.map((evidence) => evidence.id),
};
const actionPlan = anchoredActionPlan(normalizePlannerOutput(plannerRaw, true), anchors, contract.requested_outputs, true)!;

// The semantic join S8 can now produce (T5): the real cross-provider paraphrase pair.
const graph = overlayClaimGroups(baseGraph, [{ ids: ['G3', 'G13'], relation: 'SAME' }]);

const ctx = {
  runId: 'f740-replay', mode: 'council', flags: new Set<string>(['source_fallback_search']),
  calls: [], budget: { limit: 12, used: 9 },
  available: () => ['agy', 'codex', 'claude'] as ProviderId[],
  roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['codex', 'agy'] },
} as unknown as RunCtx;

const report: DecisionReportJson = buildDecisionReport(ctx, {
  contract,
  seats: seats as never,
  graph,
  verifications,
  judgeReport,
  actionPlan,
  rebuttals: { round: 1, selected_claim_ids: [], events: [], stop_reason: 'NO_ESCALATIONS' } as never,
  rubric: buildIdeaRubric(contract.domain_dimensions as never),
  original: 'Decide between an Electron app and `aiki serve` for the hackathon UI, with standout features and a development plan.',
});
const md = renderDecisionDossierMarkdown(report);
const terminal = renderTerminalSummary(report, { markdownPath: '(run)/final-report.md', jsonPath: '(run)/10-decision-report.json' });
const html = renderCouncilHtml({
  runId: report.reportId,
  workflow: 'idea-refinement',
  mode: report.mode,
  verdict: report.verdict.summary,
  keyPoints: [],
  confidence: '',
  dissent: [],
  columns: [],
  rows: [],
  stats: [],
  calls: '',
  flags: report.flags,
  decisionReport: report,
} as never);

describe('T9: report hygiene on the regenerated f740 report', () => {
  it('the verdict paragraph renders exactly once', () => {
    const lead = /Build the `aiki serve` local web interface rather than an Electron app/g;
    expect(md.match(lead)!.length).toBe(1);
  });

  it('chair prose is never regex-mangled', () => {
    expect(md).not.toContain('confirmed-not yet confirmed');
    expect(md).toContain('confirmed-unverified'); // the chair's own words survive
  });

  it('payback is hidden when NOT_COMPUTABLE', () => {
    expect(md).not.toContain('NOT COMPUTABLE');
  });

  it('each chair condition renders exactly once', () => {
    const condition = /gates the whole plan/g;
    expect((md.match(condition) ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe('T11: f740, replayed through v6, is the report the user should have received', () => {
  it('the requested deliverables exist — never "unavailable"', () => {
    expect(md).not.toContain('Requested deliverables unavailable');
    expect(md).toMatch(/Feature priorities/i);
    expect(md).toContain('First 48 hours');
    expect(md).toContain('loopback-only local server');
  });

  it('the council actually met: the real paraphrase pair counts as consensus', () => {
    expect(report.claims.filter((claim) => claim.id === 'G3' || claim.id === 'G13')
      .every((claim) => Object.keys(claim.stances).length >= 1)).toBe(true);
    expect(graph.claims.find((claim) => claim.id === 'G3')!.state).toBe('CONSENSUS');
    expect(html).not.toContain('0 consensus');
  });

  it('evidence is honest: one external source line, no VERIFIED on the user brief', () => {
    expect(md).toMatch(/2 independent external sources/i);
    expect(md).not.toMatch(/idea-brief[^|\n]*\|[^|\n]*\|[^|\n]*\| VERIFIED/);
    expect(md).toContain('consistent with your materials (not independently checked)');
  });

  it('no local usernames anywhere in the artifacts', () => {
    for (const out of [md, html]) {
      expect(out).not.toMatch(/\/Users\/[^\s/]+\//);
      expect(out).not.toMatch(/\/home\/[^\s/]+\//);
    }
  });

  it('terminal summary leads with the recovered headline', () => {
    expect(terminal).toContain('aiki serve');
    expect(terminal).not.toContain('Requested deliverables unavailable');
  });
});
