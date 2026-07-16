import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimShortLabel, renderDecisionDossierMarkdown, stripReaderClaimIds } from '../src/orchestration/decision-dossier.js';
import { renderCouncilHtml, type CouncilView } from '../src/council/view.js';
import { requestedOutputsFor, mergeRequestedOutputs } from '../src/orchestration/preflight.js';
import { buildJudgePrompt, evidenceHoleConditions } from '../src/orchestration/stages/s9-judge.js';
import { buildDecisionReport, computeConfidence } from '../src/orchestration/stages/s10-render.js';
import { detectWeakSeat } from '../src/orchestration/stages/s6-positions.js';
import { selectVerificationTargets } from '../src/orchestration/stages/s8-verify.js';
import { selectEscalations } from '../src/orchestration/decision-graph.js';
import { DecisionGraph as DecisionGraphSchema } from '../src/schemas/index.js';
import type { DecisionReportJson, S10Args } from '../src/orchestration/stages/s10-render.js';
import type { DecisionGraph, JudgeReport, ActionPlan, IntentContract } from '../src/schemas/index.js';
import type { RunCtx } from '../src/orchestration/context.js';
import type { ProviderId } from '../src/providers/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, 'fixtures', 'c289');
const readJson = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

export const loadC289 = () => ({
  report: readJson('10-decision-report.json') as DecisionReportJson,
  graph: readJson('07-decision-graph.json') as DecisionGraph,
  judge: readJson('09-judge-report.json') as JudgeReport,
  plan: readJson('09b-action-plan.json') as ActionPlan,
  contract: readJson('01-intent-contract.json') as IntentContract,
  original: readFileSync(join(FIX, '00-original.md'), 'utf8'),
});
export const renderC289 = () => renderDecisionDossierMarkdown(loadC289().report);

/** Rebuild a fresh DecisionReportJson from the real c289 graph/judge/plan/contract, mirroring the
 *  fake-ctx pattern test/decision-report.test.ts uses. seats/verifications are synthetic empties —
 *  buildDecisionReport's risk framing only reads graph.claims, and buildDossier degrades safely
 *  (empty submissions/verification ledger) when seats or verifications are empty. */
function buildC289Report(): DecisionReportJson {
  const { graph, judge, plan, contract } = loadC289();
  const ctx = {
    runId: 'c289-risks', flags: new Set<string>(), calls: [], budget: { limit: 18, used: 0 },
    available: () => ['agy', 'codex'] as ProviderId[],
    roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
  } as unknown as RunCtx;
  const args: S10Args = {
    contract,
    seats: [],
    graph,
    verifications: { verifications: [] },
    judgeReport: judge,
    actionPlan: plan,
  };
  return buildDecisionReport(ctx, args);
}

describe('report v4 — c289 regression harness', () => {
  it('renders the real run without throwing', () => {
    const md = renderC289();
    expect(md).toContain('## 1. Decision');
    expect(md.length).toBeGreaterThan(1000);
  });

  it('reader body contains no mangled id artifacts', () => {
    const md = renderC289();
    const readerBody = md.split('## 9. Technical audit')[0]!;
    expect(readerBody).not.toContain('(/)');
    expect(readerBody).not.toMatch(/\bG\d+\b/);
    expect(readerBody).not.toContain(" 's ");
    expect(readerBody).not.toMatch(/\|\s*and /); // no table cell starting mid-sentence
  });

  it('HTML council view carries no mangled id artifacts either', () => {
    const { report } = loadC289();
    const html = renderCouncilHtml({
      runId: report.reportId, workflow: 'idea-refinement', mode: report.mode,
      verdict: report.verdict.summary, keyPoints: [], confidence: '', dissent: [], columns: [], rows: [], stats: [], calls: '', flags: report.flags,
      decisionReport: report,
    } as CouncilView);
    // escapeHtml runs before stripReaderClaimIds, so an orphaned possessive appears as " &#39;s ".
    expect(html).not.toContain('(/)');
    expect(html).not.toContain(' &#39;s ');
    // Raw ids legitimately remain in the technical audit and the embedded REPORT_MD; check the reader body only.
    const htmlReaderBody = html.slice(html.indexOf('Council recommendation'), html.indexOf('<span class="idx">10</span>'));
    expect(htmlReaderBody).not.toMatch(/\bG\d+\b/);
  });

  it('a pipe in a claim label cannot inject phantom markdown table columns (and stays raw in HTML)', () => {
    const mutated = structuredClone(loadC289().report);
    mutated.claims.find((claim) => claim.id === 'G6')!.text = 'Cost | benefit is unclear until the deadline is confirmed';
    // G6 appears bare in experiments.actions[0].why, which renders inside a validation-plan table row.
    const md = renderDecisionDossierMarkdown(mutated);
    expect(md).toContain('\\| benefit'); // escaped inside the injected quoted label
    // Phantom columns only arise inside table rows; prose lines (e.g. "Evidence behind the
    // recommendation: …") legitimately carry the raw pipe as literal text.
    const tableRows = md.split('\n').filter((line) => line.startsWith('|'));
    expect(tableRows.some((row) => row.includes('\\| benefit'))).toBe(true);
    expect(tableRows.some((row) => /[^\\]\| benefit/.test(row))).toBe(false); // no unescaped pipe in any row
    // HTML must NOT get markdown escaping: the same label carries a raw pipe in the rendered body.
    const html = renderCouncilHtml({
      runId: mutated.reportId, workflow: 'idea-refinement', mode: mutated.mode,
      verdict: mutated.verdict.summary, keyPoints: [], confidence: '', dissent: [], columns: [], rows: [], stats: [], calls: '', flags: mutated.flags,
      decisionReport: mutated,
    } as CouncilView);
    // Scope to the rendered body: the embedded REPORT_MD copy legitimately contains the markdown-escaped form.
    const htmlReaderBody = html.slice(html.indexOf('Council recommendation'), html.indexOf('<span class="idx">10</span>'));
    expect(htmlReaderBody).toContain('Cost | benefit');
    expect(htmlReaderBody).not.toContain('Cost \\| benefit');
  });
});

describe('reader-safe id substitution (v4)', () => {
  const lookup = (id: string) =>
    ({ G13: 'live-streaming feasibility is brittle', G20: 'reuse the non-interactive path', G21: 'the spike kill-gate', G6: 'rules and deadline are unknown', G23: 'market timing is unverified' } as Record<string, string>)[id] ?? null;

  it('substitutes ids mid-sentence instead of deleting them', () => {
    const out = stripReaderClaimIds('G6 and G23 make the build decision impossible until eligibility is known', lookup);
    expect(out).not.toMatch(/\bG\d+\b/);
    expect(out).toContain('"rules and deadline are unknown"');
    expect(out).not.toMatch(/^and /i);
  });
  it('kills the "(/)" artifact from slash-separated citation groups', () => {
    const out = stripReaderClaimIds('may exceed the team capacity (G7/G13), making a live demo a coin-flip', lookup);
    expect(out).not.toContain('(/)');
    expect(out).not.toMatch(/\(\s*\/?\s*\)/);
  });
  it('handles possessives without leaving orphan apostrophes', () => {
    const out = stripReaderClaimIds("directly carries G21's kill criteria", lookup);
    expect(out).not.toContain(" 's ");
    expect(out).toContain('the spike kill-gate');
  });
  it('unknown id degrades to a neutral phrase, never an empty hole', () => {
    const out = stripReaderClaimIds('Resolve the evidence status for G99.', lookup);
    expect(out).toBe('Resolve the evidence status for a related claim.');
  });
  it('claimShortLabel: strips Verdict:, first clause, at most 61 chars (60 + ellipsis) at a word boundary', () => {
    // Exact clip point is an implementation detail of the word-boundary heuristic, not a contract —
    // pin length + stable prefix rather than the brittle full string (brief §Step 1 note).
    const label = claimShortLabel('Verdict: build `aiki serve` only as an optional, demo-focused visual companion to the existing CLI, not as a general-purpose web application.');
    expect(label.length).toBeLessThanOrEqual(61);
    expect(label.endsWith('…')).toBe(true);
    expect(label).toMatch(/^build `aiki serve` only as an optional, demo-focused/);
    expect(claimShortLabel('short one')).toBe('short one');
  });
});

describe('requested-output detection (v4)', () => {
  it('keyword fallback catches c289 phrasing that the old regex missed', () => {
    const { original } = loadC289(); // contains "decide a ultra level freatures so that we can standout"
    expect(requestedOutputsFor(original)).toContain('FEATURE_BACKLOG');
  });
  it('still catches the old literal phrasings', () => {
    expect(requestedOutputsFor('give me a prioritized feature list')).toContain('FEATURE_BACKLOG');
    expect(requestedOutputsFor('write an implementation plan')).toContain('IMPLEMENTATION_PLAN');
  });
  it('unions model-backed detection from readings', () => {
    const out = mergeRequestedOutputs('plain decision prompt', [['FEATURE_BACKLOG'], []]);
    expect(out).toEqual(['DECISION', 'FEATURE_BACKLOG']);
  });
  it('never duplicates and always leads with DECISION', () => {
    const out = mergeRequestedOutputs('feature backlog please', [['FEATURE_BACKLOG', 'IMPLEMENTATION_PLAN']]);
    expect(out[0]).toBe('DECISION');
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('conditions (v4)', () => {
  it('one condition per claim, labeled, no generic placeholder text', () => {
    const { graph } = loadC289();
    const conditions = evidenceHoleConditions(graph);
    expect(new Set(conditions).size).toBe(conditions.length);
    expect(conditions.length).toBeLessThanOrEqual(4);
    for (const c of conditions) {
      expect(c).not.toContain('claim requires independently checkable evidence');
      expect(c).toMatch(/Obtain independent evidence for: ".+"/);
    }
  });
  it('rendered c289 conditions are deduplicated even though the stored artifact has duplicates', () => {
    const md = renderC289();
    const lines = md.split('\n').filter((l) => l.startsWith('- Proceed only after') || l.startsWith('- Obtain independent evidence'));
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.length).toBeLessThanOrEqual(4);
  });
  it('HTML conditions list is deduped and id-substituted for old stored artifacts', () => {
    const mutated = structuredClone(loadC289().report);
    const first = mutated.dossier.recommendation.conditions[0]!;
    mutated.dossier.recommendation.conditions = [first, { ...first }, ...mutated.dossier.recommendation.conditions.slice(1)];
    const html = renderCouncilHtml({
      runId: mutated.reportId, workflow: 'idea-refinement', mode: mutated.mode,
      verdict: mutated.verdict.summary, keyPoints: [], confidence: '', dissent: [], columns: [], rows: [], stats: [], calls: '', flags: mutated.flags,
      decisionReport: mutated,
    } as CouncilView);
    const start = html.indexOf('Conditions and decision state');
    const block = html.slice(start, html.indexOf('</details>', start));
    const items = [...block.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    expect(items.length).toBe(loadC289().report.dossier.recommendation.conditions.length);
    expect(new Set(items).size).toBe(items.length);
    expect(block).not.toMatch(/\bG\d+\b/);
  });
  it('collapses a literal duplicate stored condition at render (old runs pre-dating dedup)', () => {
    // The c289 fixture's own 6 stored conditions are already distinct post-substitution, so this
    // synthesizes the case the fixture doesn't: an old run that persisted the same condition twice.
    const mutated = structuredClone(loadC289().report);
    const first = mutated.dossier.recommendation.conditions[0]!;
    mutated.dossier.recommendation.conditions = [first, { ...first }, ...mutated.dossier.recommendation.conditions.slice(1)];
    const md = renderDecisionDossierMarkdown(mutated);
    const lines = md.split('\n').filter((l) => l.startsWith('- Proceed only after') || l.startsWith('- Obtain independent evidence'));
    expect(lines.length).toBe(Math.min(4, loadC289().report.dossier.recommendation.conditions.length));
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('risks (v4)', () => {
  const severityRank: Record<'High' | 'Medium' | 'Low', number> = { High: 0, Medium: 1, Low: 2 };

  it('frames every risk as an unsettled load-bearing claim, sorted by severity', () => {
    const report = buildC289Report();
    expect(report.risks.length).toBeGreaterThan(0);
    for (const r of report.risks) expect(r.risk).toMatch(/^Rests on unsettled claim: /);
    const order = report.risks.map((r) => severityRank[r.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('does not re-list the critical-warning claim as a risk', () => {
    const { graph } = loadC289();
    const report = buildC289Report();
    const criticalClaim = graph.claims.find(
      (claim) => claim.load_bearing && claim.if_false === 'STOP' && claim.evidence_state !== 'SUPPORTED');
    expect(report.verdict.criticalWarning).toBeTruthy();
    expect(criticalClaim).toBeDefined();
    for (const r of report.risks) expect(r.risk).not.toContain(criticalClaim!.proposition);
  });

  it('reader body caps risks at 8 with an overflow note', () => {
    const md = renderC289(); // stored fixture has 13 raw risks; render caps
    const section = md.split('### Risks')[1]!.split('###')[0]!;
    const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Risk') && !line.startsWith('|---'));
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(md).toContain('more in the technical audit');
  });
});

describe('answer-first body (v4)', () => {
  const md = () => renderC289();

  it('drops the truncated evidence-behind-recommendation line', () => {
    expect(md()).not.toContain('Evidence behind the recommendation:');
  });

  it('uses chair reasoning instead of a claims table in Why', () => {
    const why = md().split('## 3.')[1]!.split('## 4.')[0]!;
    expect(why).toContain('The differentiator is proving critique');
    expect(why).not.toContain('| Claim | Ruling |');
  });

  it('caps decision-sensitive facts at five and omits linked claims', () => {
    const section = md().split('### Decision-sensitive facts')[1]!.split('###')[0]!;
    const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Fact') && !line.startsWith('|---'));
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(section).not.toContain('Linked claims');
  });

  it('keeps evidence, coverage, and full claims tables inside the technical audit', () => {
    const rendered = md();
    const auditAt = rendered.indexOf('## 9. Technical audit');
    expect(auditAt).toBeGreaterThan(0);
    const readerBody = rendered.slice(0, auditAt);
    const audit = rendered.slice(auditAt);
    for (const header of ['| Evidence ID | Source |', '| Dimension | Status |', '| Claim | Ruling |']) {
      expect(readerBody).not.toContain(header);
      expect(audit).toContain(header);
    }
  });

  it('dedupes open questions case-insensitively and caps them at five', () => {
    const section = md().split('### Open questions')[1]!.split('##')[0]!;
    const questions = section.split('\n').filter((line) => line.startsWith('- '));
    expect(questions.length).toBeLessThanOrEqual(5);
    expect(new Set(questions.map((question) => question.slice(0, 62).toLowerCase())).size).toBe(questions.length);
  });

  it('does not repeat a claim sentence more than twice in the reader body', () => {
    const readerBody = md().split('## 9. Technical audit')[0]!;
    const { report } = loadC289();
    for (const claim of report.claims) {
      const needle = claim.text.slice(0, 60);
      const count = readerBody.split(needle).length - 1;
      expect(count, needle).toBeLessThanOrEqual(2);
    }
  });
});

describe('council story + flags (v4)', () => {
  it('explains degradation flags in plain language while retaining the token', () => {
    const md = renderC289();
    expect(md).toContain('synthesis_suspect');
    expect(md).toMatch(/chair.*(repair|degrad)/i);
  });

  it('computes per-seat contribution lines from graph positions', () => {
    const report = buildC289Report();
    expect(report.dossier.seatStats?.find((seat) => seat.provider === 'agy')).toMatchObject({ positions: 4, evidenced: 1 });
    expect(report.dossier.seatStats?.find((seat) => seat.provider === 'codex')).toMatchObject({ positions: 24 });
  });

  it('does not render an all-zero verified-contributions table for a new report', () => {
    const report = buildC289Report();
    report.flags.push('weak_seat');
    const built = renderDecisionDossierMarkdown(report);
    expect(built).not.toContain('| Claude | none recorded | 0 |');
    expect(built).toContain('Gemini: 4 positions, 1 with evidence — weak seat this run.');
    expect(built).not.toContain('Codex: 24 positions, 24 with evidence — weak seat this run.');
  });
});

describe('weak_seat (v4)', () => {
  it('flags the c289 Gemini seat against its strong sibling', () => {
    expect(detectWeakSeat(loadC289().graph.positions, 'council')).toEqual(['agy']);
  });

  it('does not flag balanced seats or quick mode', () => {
    const balanced = [
      { id: 'agy/p1', evidence_ids: ['e1'] }, { id: 'agy/p2', evidence_ids: ['e2'] }, { id: 'agy/p3', evidence_ids: ['e3'] },
      { id: 'codex/p1', evidence_ids: ['e4'] }, { id: 'codex/p2', evidence_ids: ['e5'] }, { id: 'codex/p3', evidence_ids: [] },
    ];
    expect(detectWeakSeat(balanced, 'council')).toEqual([]);
    expect(detectWeakSeat(loadC289().graph.positions, 'quick')).toEqual([]);
  });
});

describe('claim nature (v4)', () => {
  it('defaults old position and claim artifacts to JUDGMENT', () => {
    const parsed = DecisionGraphSchema.parse(loadC289().graph);
    expect(parsed.positions.every((position) => position.nature === 'JUDGMENT')).toBe(true);
    expect(parsed.claims.every((claim) => claim.nature === 'JUDGMENT')).toBe(true);
  });

  it('selects FACTUAL load-bearing claims before JUDGMENT claims', () => {
    const claims = [
      { id: 'G1', load_bearing: true, nature: 'JUDGMENT' as const },
      { id: 'G2', load_bearing: true, nature: 'FACTUAL' as const },
      { id: 'G3', load_bearing: true, nature: 'FACTUAL' as const },
    ];
    expect(selectVerificationTargets(claims, 2).map((claim) => claim.id)).toEqual(['G2', 'G3']);
  });

  it('passes the same factual-first capped claim set from verification into the chair prompt', () => {
    const graph = DecisionGraphSchema.parse(loadC289().graph);
    for (const claim of graph.claims) claim.nature = 'JUDGMENT';
    const ranked = selectEscalations(graph, { max: graph.claims.length });
    const factualId = ranked[8]?.claim_id;
    expect(factualId).toBeDefined();
    graph.claims.find((claim) => claim.id === factualId)!.nature = 'FACTUAL';

    const prompt = buildJudgePrompt(loadC289().contract, graph, { verifications: [] }, []);
    const escalated = prompt.split('ESCALATED CLAIMS + VERIFICATION: ')[1]!.split('\nAPPEND-ONLY REBUTTAL EVENTS:')[0]!;
    expect(escalated).toContain(`"id": "${factualId}"`);
  });

  it('uses factual load-bearing claims as the verification denominator when present', () => {
    const graph = structuredClone(loadC289().graph);
    graph.claims = graph.claims.map((claim, index) => ({
      ...claim,
      nature: index === 0 ? 'FACTUAL' as const : 'JUDGMENT' as const,
      load_bearing: true,
      evidence_state: index === 0 ? 'SUPPORTED' as const : 'UNVERIFIED' as const,
    }));
    const confidence = computeConfidence(graph, new Set());
    expect(confidence.verificationCoverage).toBe(1);
    expect(confidence.verificationScope).toBe('FACTUAL');
  });

  it('keeps legacy coverage wording and labels factual-only coverage honestly', () => {
    expect(renderC289()).toContain('% of load-bearing claims');
    const report = structuredClone(loadC289().report);
    report.confidenceBreakdown.verificationScope = 'FACTUAL';
    expect(renderDecisionDossierMarkdown(report)).toContain('% of checkable factual claims independently verified; design judgments are adjudicated by the chair, not verified.');
  });
});
