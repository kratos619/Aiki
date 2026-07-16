import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import type { WorkflowId } from '../orchestration/context.js';
import { RoleOutput as RoleOutputSchema, type ActionPlanArtifact, type AnnotatedFinding, type DecisionGraph, type DisagreementMap, type IdeaMode, type JudgeReport, type Recommendation, type ReviewMap, type RoleOutput, type RunMeta } from '../schemas/index.js';
import { deriveAudit, deriveScorecard, mergeOpenQuestions, type AuditRow, type DecisionReportJson, type ScorecardRow } from '../orchestration/stages/s10-render.js';
import { buildReaderProjection, claimLookup, readerClaimLabel, readerClaimRefs, renderDecisionDossierMarkdown, stripReaderClaimIds } from '../orchestration/decision-dossier.js';
import type { SeatOutput } from '../orchestration/stages/s4-analyze.js';
import { IDEA_RUBRIC } from '../workflows/idea-refinement.js';
import { listArtifacts, readJsonArtifact } from '../storage/runs-read.js';
import { adaptIdeaOutput, adaptLegacyDecisionGraph } from '../orchestration/legacy-idea-adapter.js';

type Column = { provider: string; title: string; lines: string[] };
type RowKind = 'consensus' | 'dispute' | 'unique' | 'single';
type CouncilRow = { kind: RowKind; title: string; detail: string; providers: ProviderId[]; ruling?: string };

// ── Human-facing narrative (idea workflow) ─────────────────────────────────────
// The raw artifacts speak in internal terms (contradiction ids, UPHOLD/REJECT, "consensus"). A normal
// reader wants: is my idea sound, what are the real risks, what got missed, what do I do next. These
// structured fields translate the artifacts into that story. All derived deterministically — no model
// call, no schema change.

export type Tone = 'good' | 'caution' | 'risk';
export interface Signal { label: string; tone: Tone; }
/** A dispute the judge UPHELD → the attack won → an assumption the idea leans on did NOT hold up. */
export interface RiskItem { assumption: string; severity: string; challenge: string; reasoning: string; providers: ProviderId[]; }
/** A dispute the judge REJECTED → the objection was dismissed → the idea holds up here. */
export interface DefendedItem { assumption: string; challenge: string; reasoning: string; }
export interface Agreement { statement: string; providers: ProviderId[]; }
export interface DebateItem { claim: string; claimantProviders: ProviderId[]; attackerProviders: ProviderId[]; challenge: string; chair: string; reasoning: string; }

export interface CouncilView {
  runId: string;
  workflow: WorkflowId;
  mode?: IdeaMode;
  verdict: string;
  keyPoints: string[]; // chairman's bulleted reasoning (idea); [] for code-review
  confidence: string;
  dissent: string[];
  columns: Column[];
  rows: CouncilRow[];
  stats: string[];
  calls: string;
  flags: string[];
  // Additive narrative fields (populated for idea-refinement; the TUI ignores them).
  topic?: string;
  moderator?: string;
  signal?: Signal;
  agreements?: Agreement[];
  risks?: RiskItem[];
  defended?: DefendedItem[];
  blindSpots?: string[];
  nextSteps?: string[];
  biggestRisk?: string;
  bestNextStep?: string;
  recommendation?: Recommendation;
  conditions?: string[];
  scorecard?: ScorecardRow[];
  audit?: AuditRow[];
  debates?: DebateItem[];
  actionPlan?: ActionPlanArtifact;
  openQuestions?: string[];
  receipt?: string[];
  decisionReport?: DecisionReportJson;
}

function providerName(id: string): string {
  return id in DISPLAY_NAME ? DISPLAY_NAME[id as ProviderId] : id;
}

function findingLine(f: AnnotatedFinding['finding']): string {
  return `${f.severity}/${f.category} ${f.file}:${f.line_start}-${f.line_end} — ${f.claim}`;
}

function roleColumn(provider: string, role: RoleOutput): Column {
  if (role.workflow === 'code-review') {
    return {
      provider,
      title: providerName(provider),
      lines: role.findings.map(findingLine),
    };
  }
  return {
    provider,
    title: providerName(provider),
    lines: [
      `Strongest version: ${role.strongest_version}`,
      ...role.positions.map((position) => `${position.load_bearing ? 'Load-bearing' : position.stance}: ${position.proposition}`),
      ...role.decision_questions.map(({ question }) => `Question: ${question}`),
    ],
  };
}

function judgeRulings(judge: JudgeReport | null): Map<string, string> {
  return new Map((judge?.adjudications ?? []).map((a) => [a.id, `${a.ruling}: ${a.reasoning}`]));
}

function codeReviewRows(map: ReviewMap, judge: JudgeReport | null): CouncilRow[] {
  const rulings = judgeRulings(judge);
  const row = (kind: RowKind, a: AnnotatedFinding): CouncilRow => ({
    kind,
    title: findingLine(a.finding),
    detail: a.refutation ?? a.finding.evidence,
    providers: a.reviewers,
    ruling: rulings.get(a.finding.id),
  });
  return [
    ...map.consensus.map((a) => row('consensus', a)),
    ...map.disputed.map((a) => row('dispute', a)),
    ...map.single_reviewer.map((a) => row('single', a)),
  ];
}

function graphRows(graph: DecisionGraph, judge: JudgeReport | null): CouncilRow[] {
  const rulings = judgeRulings(judge);
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  return graph.claims.map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const providers = [...new Set(positions.map((position) => position.provider))];
    const kind: RowKind = claim.state === 'DISAGREEMENT' ? 'dispute'
      : claim.state === 'CONSENSUS' || claim.state === 'SHARED_CONCERN' ? 'consensus'
        : 'unique';
    return {
      kind,
      title: claim.proposition,
      detail: positions.map((position) => `${providerName(position.provider)} ${position.stance}: ${position.reasoning}`).join(' · '),
      providers,
      ruling: rulings.get(claim.id),
    };
  });
}

const SEV_ORDER: Record<string, number> = { HIGH: 0, MED: 1, MEDIUM: 1, LOW: 2 };
function sevRank(s: string): number {
  return SEV_ORDER[s.toUpperCase()] ?? 1;
}
function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}
/** The intent-contract task is a third-person restatement ("The user is asking about …"). Strip that
 *  meta-preamble and keep the first sentence so the masthead reads as the plain question. */
function cleanTopic(t: string): string {
  let s = t.trim().replace(/^the user('?s)?\s+(is\s+asking\s+(about|for)|wants\s+to\s+know(\s+(if|whether|how))?|wants|is\s+asking|question\s+is|request\s+is|idea\s+is)\s*:?\s*/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const firstSentence = s.match(/^[^.?!]{25,}[.?!]/);
  return clip(firstSentence ? firstSentence[0] : s, 200);
}

function computeSignal(riskCount: number, agreeCount: number): Signal {
  if (riskCount === 0) return { tone: 'good', label: agreeCount ? 'Holds up well' : 'No major objections' };
  const tone: Tone = riskCount >= 3 ? 'risk' : 'caution';
  return { tone, label: agreeCount ? 'Feasible — with real caveats' : 'Proceed with caution' };
}

function recommendationTone(r: Recommendation | undefined, fallback: Tone): Tone {
  if (r === 'PROCEED') return 'good';
  if (r === 'STOP') return 'risk';
  if (r === 'PIVOT' || r === 'PROCEED_WITH_CONDITIONS') return 'caution';
  return fallback;
}

function recommendationLabel(r: Recommendation | undefined, fallback: string): string {
  if (!r) return fallback;
  return r === 'PROCEED_WITH_CONDITIONS' ? 'Proceed with conditions' : r.charAt(0) + r.slice(1).toLowerCase();
}

function chairPhrase(ruling: string | undefined): string {
  if (ruling === 'UPHOLD') return 'the objection stands';
  if (ruling === 'REJECT') return 'the idea holds here';
  return 'left to you';
}

function graphDebates(graph: DecisionGraph, judge: JudgeReport | null): DebateItem[] {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const adjudication = new Map((judge?.adjudications ?? []).map((item) => [item.id, item]));
  return graph.claims.filter((claim) => claim.state === 'DISAGREEMENT').map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const supporting = positions.filter((position) => position.stance === 'SUPPORT');
    const opposing = positions.filter((position) => position.stance === 'OPPOSE');
    const ruling = adjudication.get(claim.id);
    return {
      claim: claim.proposition,
      claimantProviders: [...new Set(supporting.map((position) => position.provider))],
      attackerProviders: [...new Set(opposing.map((position) => position.provider))],
      challenge: opposing.map((position) => `${providerName(position.provider)}: ${position.reasoning}`).join('\n\n'),
      chair: chairPhrase(ruling?.ruling),
      reasoning: ruling?.reasoning ?? '',
    };
  });
}

function ideaSeatOutputs(roles: Array<{ provider: string; role: RoleOutput }>): SeatOutput[] {
  return roles
    .filter((r): r is { provider: ProviderId; role: Extract<RoleOutput, { workflow: 'idea-refinement' }> } =>
      r.role.workflow === 'idea-refinement' && r.provider in DISPLAY_NAME,
    )
    .map((r) => ({ provider: r.provider, output: r.role }));
}

function receiptLines(meta: RunMeta): string[] {
  const calls = meta.calls ?? [];
  const byProvider = new Map<ProviderId, number>();
  let ms = 0;
  for (const c of calls) {
    byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
    ms += c.durationMs;
  }
  const providerCounts = [...byProvider.entries()].map(([p, n]) => `${providerName(p)} ${n}`).join(', ') || 'none';
  const profiles = Object.values(meta.flag_profiles ?? {})
    .map((p) => `${providerName(p.id)}: ${'model' in p && p.model ? p.model : 'default model'}`)
    .join(' · ');
  return [
    `Calls: ${meta.call_count ?? calls.length}/${meta.budget?.limit ?? '?'}`,
    ...(meta.receipt ? [`Categories: discovery ${meta.receipt.discovery} · verification ${meta.receipt.verification} · repair ${meta.receipt.repair} · planning ${meta.receipt.planning}`] : []),
    `Per-provider: ${providerCounts}`,
    `Recorded model time: ${(ms / 1000).toFixed(1)}s`,
    profiles ? `Models: ${profiles}` : '',
    meta.flags?.length ? `Flags: ${meta.flags.join(', ')}` : '',
  ].filter(Boolean);
}

function graphNarrative(graph: DecisionGraph, judge: JudgeReport | null): Partial<CouncilView> {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const ruling = new Map((judge?.adjudications ?? []).map((item) => [item.id, item]));
  const agreements: Agreement[] = graph.claims
    .filter((claim) => claim.state === 'CONSENSUS')
    .map((claim) => ({
      statement: claim.proposition,
      providers: [...new Set(claim.position_ids.map((id) => positionById.get(id)!.provider))],
    }));
  const risks: RiskItem[] = graph.claims.flatMap((claim): RiskItem[] => {
    const decision = ruling.get(claim.id);
    if (claim.state !== 'SHARED_CONCERN' && decision?.ruling !== 'UPHOLD') return [];
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    return [{
      assumption: claim.proposition,
      severity: claim.sensitivity === 'DECISIVE' ? 'HIGH' : claim.sensitivity === 'MATERIAL' ? 'MED' : 'LOW',
      challenge: positions.filter((position) => position.stance === 'OPPOSE').map((position) => `${providerName(position.provider)}: ${position.reasoning}`).join('\n\n'),
      reasoning: decision?.reasoning ?? 'Multiple analysts independently raised this concern.',
      providers: [...new Set(positions.map((position) => position.provider))],
    }];
  }).sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const defended: DefendedItem[] = graph.claims.flatMap((claim): DefendedItem[] => {
    const decision = ruling.get(claim.id);
    if (decision?.ruling !== 'REJECT') return [];
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    return [{
      assumption: claim.proposition,
      challenge: positions.filter((position) => position.stance === 'OPPOSE').map((position) => position.reasoning).join('\n\n'),
      reasoning: decision.reasoning,
    }];
  });
  const blindSpots = graph.holes.coverage.map((hole) => hole.label);
  const nextSteps = [
    ...risks.map((risk) => `Pressure-test “${clip(risk.assumption, 130)}”.`),
    ...blindSpots.map((spot) => `Work out: ${spot}.`),
  ];
  return {
    signal: computeSignal(risks.length, agreements.length),
    agreements,
    risks,
    defended,
    blindSpots,
    nextSteps,
    biggestRisk: risks[0]?.assumption,
    bestNextStep: nextSteps[0],
  };
}

async function loadRoleOutputs(dir: string): Promise<Array<{ provider: string; role: RoleOutput }>> {
  const artifacts = await listArtifacts(dir);
  const roleFiles = artifacts.filter((f) => f.startsWith('04-role-outputs/') && f.endsWith('.json'));
  const roles = await Promise.all(roleFiles.map(async (file) => {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const role = typeof raw === 'object' && raw !== null && 'workflow' in raw && raw.workflow === 'idea-refinement'
      ? adaptIdeaOutput(raw)
      : RoleOutputSchema.parse(raw);
    return { provider: basename(file, '.json'), role };
  }));
  return roles.sort((a, b) => providerName(a.provider).localeCompare(providerName(b.provider)));
}

export async function loadCouncilView(runId: string, dir: string): Promise<CouncilView | null> {
  const meta = await readJsonArtifact<RunMeta>(dir, 'meta.json');
  if (!meta) return null;
  const [judge, actionPlan, roles, intent, decisionReport] = await Promise.all([
    readJsonArtifact<JudgeReport>(dir, '09-judge-report.json'),
    readJsonArtifact<ActionPlanArtifact>(dir, '09b-action-plan.json'),
    loadRoleOutputs(dir),
    readJsonArtifact<{ task?: string }>(dir, '01-intent-contract.json'),
    readJsonArtifact<DecisionReportJson>(dir, '10-decision-report.json'),
  ]);
  const columns = roles.map(({ provider, role }) => roleColumn(provider, role));
  const verdict = judge?.verdict ?? (meta.exit_status === 'ok' ? 'Run completed without a judge verdict artifact.' : `Run ${meta.exit_status}.`);
  let rows: CouncilRow[] = [];
  let stats: string[] = [];
  let narrative: Partial<CouncilView> = {};
  if (meta.workflow === 'code-review') {
    const map = await readJsonArtifact<ReviewMap>(dir, '07-review-map.json');
    if (map) {
      rows = codeReviewRows(map, judge);
      stats = [
        `${map.consensus.length} consensus`,
        `${map.disputed.length} disputed`,
        `${map.single_reviewer.length} single-reviewer`,
      ];
    }
  } else {
    const storedGraph = await readJsonArtifact<DecisionGraph>(dir, '07-decision-graph.json');
    const legacyMap = storedGraph ? null : await readJsonArtifact<DisagreementMap>(dir, '07-disagreement-map.json');
    const graph = storedGraph ?? (legacyMap ? adaptLegacyDecisionGraph(legacyMap) : null);
    if (graph) {
      rows = graphRows(graph, judge);
      stats = [
        `${graph.claims.filter((claim) => claim.state === 'CONSENSUS').length} consensus`,
        `${graph.claims.filter((claim) => claim.state === 'SHARED_CONCERN').length} shared concerns`,
        `${graph.claims.filter((claim) => claim.state === 'DISAGREEMENT').length} disputes`,
        `${graph.claims.filter((claim) => claim.state === 'UNIQUE').length} unique`,
        `${graph.holes.coverage.length} coverage holes`,
      ];
      narrative = graphNarrative(graph, judge);
      const reportV3 = Boolean(judge?.recommendation || actionPlan);
      if (actionPlan && !('kind' in actionPlan)) narrative.nextSteps = actionPlan.actions.map((a) => a.action);
      if (reportV3) {
        const ideaSeats = ideaSeatOutputs(roles);
        narrative = {
          ...narrative,
          recommendation: judge?.recommendation,
          conditions: judge?.conditions,
          scorecard: deriveScorecard(IDEA_RUBRIC, graph),
          audit: judge ? deriveAudit(graph, judge) : [],
          debates: graphDebates(graph, judge),
          actionPlan: actionPlan ?? undefined,
          openQuestions: mergeOpenQuestions(ideaSeats),
          receipt: receiptLines(meta),
        };
      }
    }
  }
  const moderator = meta.roles?.judge ? providerName(meta.roles.judge) : undefined;
  const hydratedDecisionReport = decisionReport?.dossier ? {
    ...decisionReport,
    keyFindings: decisionReport.keyFindings?.length ? decisionReport.keyFindings : judge?.key_points ?? [decisionReport.verdict.primaryReason],
    criticalUnknowns: decisionReport.criticalUnknowns?.length
      ? decisionReport.criticalUnknowns
      : (narrative.openQuestions ?? []).slice(0, 3),
  } : undefined;
  return {
    runId,
    workflow: meta.workflow,
    mode: meta.mode,
    verdict,
    keyPoints: judge?.key_points ?? [],
    confidence: judge?.confidence_notes ?? '',
    dissent: judge?.dissent ?? [],
    columns,
    rows,
    stats,
    calls: `${meta.call_count}/${meta.budget.limit} provider calls`,
    flags: meta.flags ?? [],
    topic: intent?.task ?? decisionReport?.task.original,
    moderator,
    ...(hydratedDecisionReport ? { decisionReport: hydratedDecisionReport } : {}),
    ...narrative,
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
/** Escape then turn blank-line gaps into paragraph breaks. */
function paras(s: string): string {
  return s
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replaceAll('\n', '<br>')}</p>`)
    .join('');
}
function sevClass(s: string): string {
  const r = sevRank(s);
  return r === 0 ? 'sev-high' : r === 2 ? 'sev-low' : 'sev-med';
}
function sevLabel(s: string): string {
  const r = sevRank(s);
  return r === 0 ? 'High severity' : r === 2 ? 'Low severity' : 'Medium severity';
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}
function providerDots(ids: ProviderId[]): string {
  const seen = new Set<string>();
  const names = ids.map(providerName).filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  if (!names.length) return '';
  return `<span class="who">${names.map((n) => `<span class="dot" title="${escapeHtml(n)}">${escapeHtml(initials(n))}</span>`).join('')}<span class="who-names">${escapeHtml(names.join(' · '))}</span></span>`;
}

function section(index: string, title: string, inner: string, delay: number, note = ''): string {
  return `
  <section class="block reveal" style="animation-delay:${delay}ms">
    <div class="block-head"><span class="idx">${index}</span><h2>${escapeHtml(title)}</h2></div>
    ${note ? `<p class="lede">${escapeHtml(note)}</p>` : ''}
    ${inner}
  </section>`;
}

function dossierTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return '<p class="muted">None recorded.</p>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function dossierRefs(ids: string[]): string {
  return ids.length ? ids.join(', ') : 'none recorded';
}

function dossierPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function dossierCoverageLabel(value: number): 'High' | 'Medium' | 'Low' {
  return value >= 0.75 ? 'High' : value >= 0.5 ? 'Medium' : 'Low';
}

function dossierCouncilRead(report: DecisionReportJson): string {
  if (report.mode === 'quick') return 'One structured analyst produced this result; no council, consensus, or independent-verification claim is being made.';
  const scouts = report.models.filter((model) => model.roles.includes('scout')).length;
  if (report.disagreements.length === 0) {
    return `${scouts || 'The'} independent scout ${scouts === 1 ? 'analysis produced' : 'analyses produced'} no genuine opposing claim. The chair had less contested material to resolve.`;
  }
  const resolved = report.disagreements.filter((item) => item.status === 'RESOLVED').length;
  return `${report.disagreements.length} genuine disagreement${report.disagreements.length === 1 ? '' : 's'} reached the chair; ${resolved} ${resolved === 1 ? 'was' : 'were'} resolved.`;
}

function dossierWarning(report: DecisionReportJson, flags: string[]): string {
  const active = flags.filter((flag) => report.flags.includes(flag));
  return active.length ? `<div class="warns"><span class="warn">⚑ DEGRADED: ${escapeHtml(active.join(', '))}</span></div>` : '';
}

function renderDossierIdeaBody(report: DecisionReportJson): string {
  const dossier = report.dossier;
  const confidence = report.confidenceBreakdown;
  const coverageLabel = dossierCoverageLabel(confidence.verificationCoverage);
  const keyFindings = report.keyFindings?.length ? report.keyFindings : [dossier.recommendation.reason];
  const criticalUnknowns = report.criticalUnknowns?.length ? report.criticalUnknowns : report.openQuestions.slice(0, 3);
  const tone: Tone = dossier.recommendation.status === 'ACCEPTED' ? 'good'
    : dossier.recommendation.status === 'REJECTED' ? 'risk' : 'caution';
  const labelFor = claimLookup(report);
  // Substitute ids then dedupe before escaping, mirroring the markdown renderer: old stored artifacts
  // may carry duplicate / bare-G# condition strings.
  const conditionItems = [...new Set(dossier.recommendation.conditions.map((condition) => stripReaderClaimIds(condition.text, labelFor)))];
  const conditions = conditionItems.length
    ? `<details class="decision-details"><summary>Conditions and decision state</summary><div><p><strong>Internal state:</strong> ${escapeHtml(dossier.recommendation.status)}</p><ul>${conditionItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></details>`
    : '';
  const startHere = dossier.experiments.actions[0]?.action ?? 'No executable next step was produced.';
  const recommendationLead = stripReaderClaimIds(dossier.recommendation.reason, labelFor);
  const recommendationDetail = stripReaderClaimIds(dossier.recommendation.summary, labelFor);
  const factLabels = ['Decisive result', 'Consequence', 'Supporting signal'];
  const facts = keyFindings.slice(0, 3).map((finding, index) => `<article class="decision-fact"><span>${factLabels[index]}</span><p>${escapeHtml(finding)}</p></article>`).join('');
  const snapshot = report.decisionSnapshot;
  const decisiveNumbers = snapshot ? `<div class="decision-numbers">
      <span class="section-eyebrow">Decisive numbers</span>
      <div class="table-wrap"><table class="snapshot-table decisive-table"><thead><tr><th>Metric</th><th>Value</th><th>What it means</th></tr></thead><tbody>${snapshot.decisiveNumbers.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="number-value">${escapeHtml(item.value)}</td><td>${escapeHtml(item.meaning)}</td></tr>`).join('')}</tbody></table></div>
      ${snapshot.payback ? `<div class="payback-result"><span>Payback · ${escapeHtml(snapshot.payback.status.replaceAll('_', ' '))}</span><strong>${escapeHtml(snapshot.payback.result)}</strong><p>${escapeHtml(snapshot.payback.basis)}</p></div>` : ''}
    </div>` : '';
  const optionComparison = snapshot ? `<div class="option-comparison">
      <span class="section-eyebrow">Options at a glance</span>
      <div class="table-wrap"><table class="snapshot-table options-table"><thead><tr><th>Path</th><th>Commitment</th><th>Basis</th><th>Trade-off</th></tr></thead><tbody>${snapshot.options.map((option) => `<tr><td>${escapeHtml(option.label)}</td><td class="number-value">${escapeHtml(option.commitment)}</td><td><span class="basis-chip ${option.commitmentKind.toLowerCase()}">${escapeHtml(option.commitmentKind.replace('_', ' '))}</span></td><td>${escapeHtml(option.tradeoff)}</td></tr>`).join('')}</tbody></table></div>
    </div>` : '';
  const tripwire = snapshot?.tripwire ? `<div class="tripwire"><span class="tag">Go/no-go tripwire</span><strong>${escapeHtml(snapshot.tripwire.metric)} · ${escapeHtml(snapshot.tripwire.threshold)}</strong><p>${escapeHtml(snapshot.tripwire.decisionRule)}</p></div>` : '';
  const topCounterCase = dossier.counterCase.reasoning;
  const unknowns = criticalUnknowns.length
    ? `<ul class="critical-unknowns">${criticalUnknowns.map((unknown) => `<li>${escapeHtml(unknown)}</li>`).join('')}</ul>`
    : '<p class="muted">No verdict-flipping unknown was recorded.</p>';
  const recommendation = `<div class="verdict tone-${tone}">
    <div class="decision-status"><span class="pill">Council recommendation</span><span>${escapeHtml(dossier.recommendation.status.replaceAll('_', ' '))}</span></div>
    ${decisiveNumbers}
    <p class="verdict-text">${escapeHtml(recommendationLead)}</p>
    <p class="verdict-detail">${escapeHtml(recommendationDetail)}</p>
    <div class="evidence-coverage ${coverageLabel.toLowerCase()}">
      <div><span class="fk">Evidence coverage</span><strong>${coverageLabel} · ${dossierPct(confidence.verificationCoverage)}</strong></div>
      <div class="coverage-track"><span style="width:${Math.round(confidence.verificationCoverage * 100)}%"></span></div>
      <p>${confidence.verificationCoverage < 0.5 ? 'Important inputs remain unchecked. Confirm them before committing.' : 'Most load-bearing claims received independent checking.'} This is not a probability that the recommendation is correct.</p>
    </div>
    ${snapshot ? '' : `<div class="decision-facts">${facts}</div>`}
    <div class="action-callout"><span>Do this first</span><p>${escapeHtml(startHere)}</p></div>
    ${optionComparison}
    ${tripwire}
    <div class="decision-safety">
      <article><span class="tag">What could overturn this</span><p>${escapeHtml(topCounterCase)}</p></article>
      <article><span class="tag">Critical unknowns</span>${unknowns}</article>
    </div>
    ${report.verdict.criticalWarning ? `<div class="critical-warning"><span class="tag">Critical warning</span><p>${escapeHtml(report.verdict.criticalWarning)}</p></div>` : ''}
    <p class="council-read"><strong>Council read:</strong> ${escapeHtml(dossierCouncilRead(report))}</p>
    ${conditions}
    ${dossier.recommendation.claimIds.length ? `<details class="decision-evidence"><summary>Evidence behind this recommendation (${dossier.recommendation.claimIds.length})</summary><ul>${dossier.recommendation.claimIds.map((id) => `<li>${escapeHtml(readerClaimLabel(report, id))}</li>`).join('')}</ul></details>` : ''}
    ${dossierWarning(report, ['synthesis_suspect'])}
    ${dossier.recommendation.claimIds.length ? '' : '<div class="warns"><span class="warn">⚑ DEGRADED: recommendation has no stored graph anchor</span></div>'}
  </div>`;

  const claimChain = dossierTable(
    ['Claim', 'Ruling', 'Evidence status', 'Depends on'],
    dossier.claimChain.map((claim) => [claim.text, claim.ruling, claim.evidenceStatus, readerClaimRefs(report, claim.dependsOn)]),
  );
  const evidence = `${dossierWarning(report, ['verification_skipped', 'research_ungrounded'])}${dossierTable(
    ['Evidence ID', 'Source', 'Date', 'Freshness', 'Verification', 'Linked claims'],
    dossier.evidence.map((item) => [item.id, `${item.source} (${item.sourceKind})`, item.date, item.freshness, item.verificationStatus, readerClaimRefs(report, item.claimIds)]),
  )}`;

  const disagreementCards = report.disagreements.length
    ? report.disagreements.map((item) => `<article class="card debate-card"><h3>${escapeHtml(item.topic)}</h3>${item.sides.map((side) => `<div class="field"><span class="fk">${escapeHtml(side.stance)} · ${escapeHtml(side.providers.map(providerName).join(', '))}</span><p>${escapeHtml(side.reasoning.join(' '))}</p></div>`).join('')}<div class="field"><span class="fk">Ruling</span><p>${escapeHtml(item.status)} · ${escapeHtml(item.ruling)}</p></div>${item.reasoning ? `<div class="field"><span class="fk">Why</span><p>${escapeHtml(item.reasoning)}</p></div>` : ''}</article>`).join('')
    : `<p class="muted">${report.mode === 'quick' ? 'No cross-model disagreement analysis runs in quick mode.' : 'No genuine disagreements were stored.'}</p>`;
  const changes = dossier.positionChanges.length
    ? dossierTable(
        ['Event', 'Claim', 'Responder', 'Change', 'Evidence', 'Detail'],
        dossier.positionChanges.map((event) => [event.eventId, readerClaimLabel(report, event.claimId), providerName(event.responder), event.response, dossierRefs(event.evidenceIds), event.narrowedProposition ?? event.reasoning]),
      )
    : '<p class="muted">No CONCEDE, COUNTER, or NARROW event was recorded.</p>';
  const minority = `<h3>Minority report</h3>${report.minority.dissent.length
    ? `<ul class="checks">${report.minority.dissent.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p class="muted">No minority dissent was recorded.</p>'}
    ${report.minority.uniqueOppositions.length ? `<ul class="checks">${report.minority.uniqueOppositions.map((item) => `<li><strong>${escapeHtml(providerName(item.provider))}</strong> uniquely opposed: ${escapeHtml(item.proposition)}</li>`).join('')}</ul>` : ''}
    <p class="lede">Decision-blocking status: <strong>${escapeHtml(report.minority.blocksDecision)}</strong></p>`;
  const disagreement = `${dossierWarning(report, ['single_model', 'low_diversity'])}${disagreementCards}<h3>Position changes</h3>${changes}${minority}`;

  const shared = dossier.sharedConcerns.length
    ? `<h3>Shared concerns</h3><ul class="agree">${dossier.sharedConcerns.map((item) => `<li><p>${escapeHtml(item.text)}</p><span class="who-names">${escapeHtml(item.providerIds.map(providerName).join(', '))} · ${escapeHtml(item.evidenceStatus)}</span></li>`).join('')}</ul>`
    : '<h3>Shared concerns</h3><p class="muted">None recorded.</p>';
  const unique = dossier.uniqueSupportedInsights.length
    ? `<h3>Unique supported insights</h3><ul class="agree">${dossier.uniqueSupportedInsights.map((item) => `<li><p>${escapeHtml(item.text)}</p><span class="who-names">${escapeHtml(providerName(item.providerId))} · ${escapeHtml(item.verificationStatus)}</span></li>`).join('')}</ul>`
    : '<h3>Unique supported insights</h3><p class="muted">None recorded.</p>';

  const coverage = dossierTable(
    ['Dimension', 'Status', 'Related claims'],
    dossier.coverage.map((item) => [item.label, item.status, readerClaimRefs(report, item.claimIds)]),
  );
  const sensitivity = dossierTable(
    ['Fact', 'Sensitivity', 'If false', 'What would change it', 'Linked claims'],
    dossier.sensitivity.map((item) => [item.fact, item.sensitivity, item.impactIfFalse, item.whatWouldChangeIt, readerClaimRefs(report, item.linkedClaimIds)]),
  );
  const experiments = `${dossierWarning(report, ['plan_fallback', 'plan_skipped'])}${dossier.experiments.status === 'DEGRADED' ? `<div class="warns"><span class="warn">⚑ DEGRADED: ${escapeHtml(dossier.experiments.note)}</span></div>` : ''}${dossier.experiments.actions.length ? `<div class="experiment-list">${dossier.experiments.actions.map((action) => `<article class="experiment-card"><div class="experiment-head"><span>${String(action.order).padStart(2, '0')}</span><h4>${escapeHtml(action.action)}</h4><strong>${escapeHtml(action.effort)}</strong></div><p>${escapeHtml(action.why)}</p><dl><div><dt>Validates</dt><dd>${escapeHtml(readerClaimLabel(report, action.validates))}</dd></div><div><dt>Stop if</dt><dd>${escapeHtml(action.killSignal)}</dd></div></dl></article>`).join('')}</div><p class="lede">${escapeHtml(dossier.experiments.note)}</p>` : '<p class="muted">No executable experiment was produced.</p>'}`;
  const missingDeliverables = (dossier.missingRequestedOutputs ?? []).length
    ? `<div class="warns"><span class="warn">⚑ DEGRADED: requested output missing: ${escapeHtml(dossier.missingRequestedOutputs.join(', '))}</span></div>`
    : '';
  const backlog = dossier.featureBacklog;
  const featurePriorities = backlog ? `<h3>Feature priorities</h3><div class="feature-groups">${([
    ['MUST', 'Build for the first usable release', backlog.must],
    ['SHOULD', 'Add after the core path is stable', backlog.should],
    ['LATER', 'Keep out of the current build', backlog.later],
  ] as const).filter(([, , items]) => items.length).map(([priority, description, items]) => `<section class="feature-group priority-${priority.toLowerCase()}"><header><div><span>${priority}</span><h4>${escapeHtml(description)}</h4></div><strong>${items.length}</strong></header><ul>${items.map((item) => `<li><div class="feature-title"><strong>${escapeHtml(item.feature)}</strong><span>${escapeHtml(item.effort)}</span></div><p>${escapeHtml(item.user_value)}</p><small>${escapeHtml(item.rationale)}</small></li>`).join('')}</ul></section>`).join('')}</div>${backlog.wont.length ? `<details class="inline-fold"><summary>Not in this scope (${backlog.wont.length})</summary><ul>${backlog.wont.map((item) => `<li><strong>${escapeHtml(item.feature)}</strong> — ${escapeHtml(item.reason)}</li>`).join('')}</ul></details>` : ''}` : '';
  const implementationPlan = dossier.implementationPlan ? `<h3>Implementation plan</h3><ol class="milestone-list">${dossier.implementationPlan.milestones.map((milestone) => `<li><div class="milestone-marker"><span>${String(milestone.order).padStart(2, '0')}</span><small>${escapeHtml(milestone.timebox)}</small></div><article><h4>${escapeHtml(milestone.outcome)}</h4><ul>${milestone.tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join('')}</ul><div class="acceptance"><span>Done when</span><p>${escapeHtml(milestone.acceptance_test)}</p></div></article></li>`).join('')}</ol>` : '';
  const actionPlan = `${missingDeliverables}${featurePriorities}${implementationPlan}<h3>Validation plan</h3>${experiments}`;
  const counterCase = dossier.counterCase.available
    ? `<article class="card risk-card"><p>${escapeHtml(dossier.counterCase.reasoning)}</p><div class="field"><span class="fk">Evidence behind this counter-case</span><p>${escapeHtml(readerClaimRefs(report, dossier.counterCase.claimIds))}</p></div></article>`
    : `<div class="warns"><span class="warn">⚑ DEGRADED: ${escapeHtml(dossier.counterCase.reasoning)}</span></div>`;
  const contributions = `${dossierWarning(report, ['verification_skipped', 'single_model', 'low_diversity'])}<p class="lede">Only unique claims that survived independent verification receive credit.</p>${dossierTable(
    ['Provider', 'Verified unique contributions', 'Count'],
    dossier.contributions.map((item) => [item.name, readerClaimRefs(report, item.verifiedUniqueClaimIds), String(item.verifiedUniqueClaimIds.length)]),
  )}`;
  const receipt = `<div class="receipt">
    <span>mode ${escapeHtml(report.mode)}</span><span>${report.receipt.calls}/${report.receipt.budget} provider calls</span>
    <span>discovery ${report.receipt.categories.discovery}</span><span>verification ${report.receipt.categories.verification}</span>
    <span>repair ${report.receipt.categories.repair}</span><span>planning ${report.receipt.categories.planning}</span>
    <span>by provider ${escapeHtml(Object.entries(report.receipt.byProvider).map(([provider, count]) => `${providerName(provider)} ${count}`).join(', ') || 'none')}</span>
    <span>model time ${(report.receipt.modelTimeMs / 1000).toFixed(1)}s</span>
  </div>${report.flags.length ? `<div class="warns">${report.flags.map((flag) => `<span class="warn">⚑ ${escapeHtml(flag)}</span>`).join('')}</div>` : '<p class="muted">No degradation flags.</p>'}`;
  const shownRisks = report.risks.slice(0, 8);
  const risks = `${dossierTable(
    ['Risk', 'Severity'],
    shownRisks.map((item) => [item.risk, item.severity]),
  )}${report.risks.length > shownRisks.length
    ? `<p class="muted">${report.risks.length - shownRisks.length} lower-severity items — more in the technical audit (full list in the stored JSON).</p>`
    : ''}`;
  const questions = report.openQuestions.length
    ? `<ul class="checks">${report.openQuestions.map((question) => `<li>${escapeHtml(question)}</li>`).join('')}</ul>`
    : '<p class="muted">No verdict-flipping open question was recorded.</p>';
  const runDetails = `<article class="card">
    <div class="field"><span class="fk">Report</span><p><code>${escapeHtml(report.reportId)}</code> · ${escapeHtml(report.generatedAt)}</p></div>
    <details class="inline-fold compact"><summary>View original request</summary><p>${escapeHtml(report.task.original)}</p></details>
    <div class="field"><span class="fk">Normalized question</span><p>${escapeHtml(report.task.normalized)}</p></div>
    <div class="field"><span class="fk">Constraints</span><p>${escapeHtml(report.task.constraints.join('; ') || 'none recorded')}</p></div>
    <div class="field"><span class="fk">Success criteria</span><p>${escapeHtml(report.task.successCriteria.join('; ') || 'none recorded')}</p></div>
    <div class="field"><span class="fk">Models and roles</span><p>${escapeHtml(report.models.map((model) => `${model.name} (${model.roles.join(', ')})`).join(' · ') || 'none recorded')}</p></div>
    <div class="field"><span class="fk">Structural score</span><p>${confidence.score}/100 (${escapeHtml(confidence.label)}) · heuristic, not benchmark-calibrated</p></div>
  </article>${receipt}`;
  const technical = `<details class="fold"><summary>Original submissions and graph events</summary><div class="fold-body">
    <h4 class="fold-h">Original submissions</h4><ul>${dossier.technical.submissions.map((item) => `<li><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.strongestVersion)} <code>${escapeHtml(dossierRefs(item.positionIds))}</code></li>`).join('') || '<li>none</li>'}</ul>
    <h4 class="fold-h">Original positions</h4><ul>${dossier.technical.positions.map((position) => `<li><code>${escapeHtml(position.id)}</code> [${escapeHtml(providerName(position.provider))} ${escapeHtml(position.stance)}] ${escapeHtml(position.proposition)} · evidence <code>${escapeHtml(dossierRefs(position.evidenceIds))}</code></li>`).join('') || '<li>none</li>'}</ul>
    <h4 class="fold-h">Graph edges</h4><ul>${dossier.technical.edges.map((edge) => `<li><code>${escapeHtml(edge.from)} —${escapeHtml(edge.type)}→ ${escapeHtml(edge.to)}</code></li>`).join('') || '<li>none</li>'}</ul>
    <h4 class="fold-h">Position-change events</h4><ul>${dossier.technical.events.map((event) => `<li><code>${escapeHtml(event.eventId)}</code>: ${escapeHtml(providerName(event.responder))} ${escapeHtml(event.response)} <code>${escapeHtml(event.claimId)}</code> — ${escapeHtml(event.reasoning)}</li>`).join('') || '<li>none</li>'}</ul>
  </div></details>`;

  const readerBody = [
    section('01', 'Decision', recommendation, 60),
    section('02', 'Action plan', actionPlan, 100, 'Requested product priorities, implementation milestones, and the smallest decisive validation test.'),
    section('03', 'Why this decision', claimChain, 140, 'The load-bearing claim chain behind the recommendation.'),
    section('04', 'What could change the decision', `<h3>Decision-sensitive facts</h3>${sensitivity}<h3>Strongest counter-case</h3>${counterCase}`, 180),
    section('05', 'Evidence and verification', evidence, 220),
    section('06', 'Risks, gaps, and open questions', `<h3>Risks</h3>${risks}<details class="inline-fold"><summary>View coverage ledger (${dossier.coverage.length})</summary>${coverage}</details><h3>Open questions</h3>${questions}`, 260),
    section('07', 'Disagreement and dissent', disagreement, 300),
    section('08', 'What the council added', `${shared}${unique}<h3>Verified unique contributions</h3>${contributions}`, 340),
    section('09', 'Run details', runDetails, 380),
  ].join('');
  return `${stripReaderClaimIds(readerBody, labelFor)}${section('10', 'Technical audit', technical, 420)}`;
}

function renderReaderBriefIdeaBody(report: DecisionReportJson): string {
  const dossier = report.dossier;
  const projection = buildReaderProjection(report);
  const tone: Tone = dossier.recommendation.status === 'ACCEPTED' ? 'good'
    : dossier.recommendation.status === 'REJECTED' ? 'risk' : 'caution';
  const hero = `<section class="verdict tone-${tone} reveal" style="animation-delay:60ms">
    <span class="pill">Recommendation</span>
    <p class="verdict-text">${escapeHtml(projection.headline)}</p>
    <p class="verdict-detail">${escapeHtml(projection.bottomLine)}</p>
  </section>`;
  const warnings = projection.warnings.length || projection.notices.length
    ? `<div class="warns">${projection.warnings.map((warning) => `<span class="warn">⚑ ${escapeHtml(warning.message)}</span>`).join('')}${projection.notices.map((notice) => `<span class="warn">ⓘ ${escapeHtml(notice.message)}</span>`).join('')}</div>`
    : '';
  const snapshot = projection.snapshot ? section('', 'Decision numbers', `${dossierTable(
    ['Metric', 'Value', 'What it means'],
    projection.snapshot.decisiveNumbers.map((item) => [item.label, item.value, item.meaning]),
  )}${projection.snapshot.payback ? `<div class="action-callout"><span>Payback · ${escapeHtml(projection.snapshot.payback.status.replaceAll('_', ' '))}</span><p>${escapeHtml(projection.snapshot.payback.result)} — ${escapeHtml(projection.snapshot.payback.basis)}</p></div>` : ''}<h3>Options at a glance</h3>${dossierTable(
    ['Path', 'Commitment', 'Basis', 'Trade-off'],
    projection.snapshot.options.map((item) => [item.label, item.commitment, item.commitmentKind.replace('_', ' '), item.tradeoff]),
  )}${projection.snapshot.tripwire ? `<div class="action-callout"><span>Go/no-go tripwire</span><p><strong>${escapeHtml(projection.snapshot.tripwire.metric)}: ${escapeHtml(projection.snapshot.tripwire.threshold)}</strong> — ${escapeHtml(projection.snapshot.tripwire.decisionRule)}</p></div>` : ''}`, 80) : '';
  const editorial = projection.sections.map((item, index) => section(
    String(index + 1).padStart(2, '0'),
    item.heading,
    `<p class="lede">${escapeHtml(item.summary)}</p>${item.bullets.length
      ? `<ul class="reasons">${item.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
      : ''}`,
    100 + index * 40,
  )).join('');

  const backlog = projection.featureBacklog;
  const features = backlog ? section('', 'Feature priorities', `<div class="feature-groups">${([
    ['MUST', 'Build for the first useful release', backlog.must],
    ['SHOULD', 'Add after the golden path is stable', backlog.should],
    ['LATER', 'Keep outside the current build', backlog.later],
  ] as const).filter(([, , items]) => items.length).map(([priority, description, items]) => `<section class="feature-group priority-${priority.toLowerCase()}"><header><div><span>${priority}</span><h4>${description}</h4></div><strong>${items.length}</strong></header><ul>${items.map((item) => `<li><div class="feature-title"><strong>${escapeHtml(item.feature)}</strong><span>${item.effort}</span></div><p>${escapeHtml(item.user_value)}</p><small>${escapeHtml(item.rationale)}</small></li>`).join('')}</ul></section>`).join('')}</div>${backlog.wont.length ? `<h3>Not in this scope</h3><ul class="checks">${backlog.wont.map((item) => `<li><strong>${escapeHtml(item.feature)}</strong> — ${escapeHtml(item.reason)}</li>`).join('')}</ul>` : ''}`, 340) : '';
  const buildPlan = projection.implementationPlan ? section('', 'Build plan', `<ol class="milestone-list">${projection.implementationPlan.milestones.map((milestone) => `<li><div class="milestone-marker"><span>${String(milestone.order).padStart(2, '0')}</span><small>${escapeHtml(milestone.timebox)}</small></div><article><h4>${escapeHtml(milestone.outcome)}</h4><ul>${milestone.tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join('')}</ul><div class="acceptance"><span>Done when</span><p>${escapeHtml(milestone.acceptance_test)}</p></div></article></li>`).join('')}</ol>`, 380) : '';
  const caveats = projection.caveats.length ? section('', 'Top caveats', `<ul class="checks">${projection.caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`, 420) : '';
  const sources = projection.sources.length ? section('', 'Sources', `<ul class="agree">${projection.sources.map((source) => `<li><p>${source.url ? `<a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${escapeHtml(source.label)}</a>` : escapeHtml(source.label)}</p>${source.citedFor.length ? `<small>Cited for: ${source.citedFor.map(escapeHtml).join('; ')}</small>` : ''}</li>`).join('')}</ul>`, 460) : '';
  const nextStep = section('', 'Next step', `<div class="action-callout"><span>Do this now</span><p>${escapeHtml(projection.nextStep)}</p></div>`, 500);
  const audit = `<details class="fold council-audit"><summary>Council audit — reasoning, evidence, dissent, and run receipt</summary><div class="fold-body">${renderDossierIdeaBody(report)}</div></details>`;

  return `${hero}${warnings}${snapshot}${editorial}${features}${buildPlan}${caveats}${sources}${nextStep}${audit}`;
}

function renderLegacyIdeaBody(view: CouncilView): string {
  const risks = view.risks ?? [];
  const agreements = view.agreements ?? [];
  const blindSpots = view.blindSpots ?? [];
  const defended = view.defended ?? [];
  const nextSteps = view.nextSteps ?? [];
  const signal = view.signal ?? { label: 'Reviewed', tone: 'caution' as Tone };

  const glance = `
    <div class="glance">
      <div class="stat good"><span class="n">${agreements.length}</span><span class="k">agreed on</span></div>
      <div class="stat risk"><span class="n">${risks.length}</span><span class="k">risks that stand</span></div>
      <div class="stat caution"><span class="n">${blindSpots.length}</span><span class="k">not examined</span></div>
    </div>`;

  const hero = `
  <section class="verdict tone-${signal.tone} reveal" style="animation-delay:60ms">
    <span class="pill">${escapeHtml(signal.label)}</span>
    <p class="verdict-text">${escapeHtml(view.verdict)}</p>
    ${glance}
  </section>`;

  const bottomLine = (view.biggestRisk || view.bestNextStep)
    ? `<section class="bottomline reveal" style="animation-delay:120ms">
        ${view.biggestRisk ? `<div><span class="tag">Biggest risk</span><p>${escapeHtml(clip(view.biggestRisk, 200))}</p></div>` : ''}
        ${view.bestNextStep ? `<div><span class="tag">Start here</span><p>${escapeHtml(clip(view.bestNextStep, 200))}</p></div>` : ''}
      </section>`
    : '';

  const riskCards = risks.length
    ? risks.map((r) => `
      <article class="card risk-card">
        <div class="card-top"><span class="chip ${sevClass(r.severity)}">${escapeHtml(sevLabel(r.severity))}</span>${providerDots(r.providers)}</div>
        <h3>${escapeHtml(r.assumption)}</h3>
        <div class="field"><span class="fk">The challenge</span>${paras(r.challenge)}</div>
        ${r.reasoning ? `<div class="field"><span class="fk">Why it stands</span><p>${escapeHtml(r.reasoning)}</p></div>` : ''}
      </article>`).join('')
    : '<p class="muted">No assumption failed scrutiny — the council did not sustain any objection.</p>';

  const blindGrid = blindSpots.length
    ? `<ul class="checks">${blindSpots.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '<p class="muted">The council covered the major angles.</p>';

  const agreeList = agreements.length
    ? `<ul class="agree">${agreements.map((a) => `<li><p>${escapeHtml(a.statement)}</p>${providerDots(a.providers)}</li>`).join('')}</ul>`
    : '<p class="muted">No point drew agreement from more than one model.</p>';

  const steps = nextSteps.length
    ? `<ol class="steps">${nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '<p class="muted">No follow-ups derived.</p>';

  const defendedBlock = defended.length
    ? `<details class="fold reveal" style="animation-delay:0ms">
        <summary>Objections the council dismissed (${defended.length}) — your idea held up here</summary>
        <div class="fold-body">${defended.map((d) => `
          <article class="card mini">
            <h3>${escapeHtml(clip(d.assumption, 160))}</h3>
            <div class="field"><span class="fk">Objection</span>${paras(d.challenge)}</div>
            ${d.reasoning ? `<div class="field"><span class="fk">Why it was dismissed</span><p>${escapeHtml(d.reasoning)}</p></div>` : ''}
          </article>`).join('')}</div>
      </details>`
    : '';

  const chairman = view.keyPoints?.length
    ? section('', "Chairman's reasoning", `<ul class="reasons">${view.keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`, 100,
        'How the chair weighed the debate to reach the verdict above.')
    : '';

  const modelCards = view.columns.length
    ? view.columns.map((c) => `
      <article class="card model-card">
        <h3>${escapeHtml(c.title)}</h3>
        ${c.lines.length ? `<ul class="model-lines">${c.lines.slice(0, 10).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '<p class="muted">No output recorded.</p>'}
      </article>`).join('')
    : '<p class="muted">No per-model output recorded.</p>';

  return `
    ${hero}
    ${chairman}
    ${bottomLine}
    ${section('01', 'Risks that held up', riskCards, 180, 'Assumptions your idea depends on that the council challenged — and the challenge stuck.')}
    ${section('02', 'How each model saw it', `<div class="model-grid">${modelCards}</div>`, 220, 'Each model analysed the idea alone, then cross-examined the others. Here is where each one landed.')}
    ${section('03', 'Blind spots — answer these before you build', blindGrid, 260, 'Angles the council did not examine. These are usually where ideas actually fail.')}
    ${section('04', 'Where the models agreed', agreeList, 300, 'Points more than one model independently backed.')}
    ${section('05', 'Recommended next steps', steps, 360, 'Derived from the risks and blind spots above.')}
    ${defendedBlock}
    ${renderTechnical(view)}
  `;
}

function renderIdeaBody(view: CouncilView): string {
  if (!view.recommendation && !view.actionPlan) return renderLegacyIdeaBody(view);

  const risks = view.risks ?? [];
  const agreements = view.agreements ?? [];
  const blindSpots = view.blindSpots ?? [];
  const signal = view.signal ?? { label: 'Reviewed', tone: 'caution' as Tone };
  const tone = recommendationTone(view.recommendation, signal.tone);
  const label = recommendationLabel(view.recommendation, signal.label);
  const conditions = view.conditions?.length
    ? `<div class="conditions"><span class="fk">Conditions</span><ul>${view.conditions.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>`
    : '';

  const glance = `
    <div class="glance">
      <div class="stat good"><span class="n">${agreements.length}</span><span class="k">agreed on</span></div>
      <div class="stat risk"><span class="n">${risks.length}</span><span class="k">risks that stand</span></div>
      <div class="stat caution"><span class="n">${blindSpots.length}</span><span class="k">not examined</span></div>
    </div>`;

  const hero = `
  <section class="verdict tone-${tone} reveal" style="animation-delay:60ms">
    <span class="pill">${escapeHtml(label)}</span>
    <p class="verdict-text">${escapeHtml(view.verdict)}</p>
    ${conditions}
    ${glance}
  </section>`;

  const synthesisWarning = view.flags.includes('synthesis_suspect') ? '<div class="warns"><span class="warn">⚑ synthesis suspect</span></div>' : '';
  const chairman = view.keyPoints?.length
    ? section('01', "Chairman's reasoning", `${synthesisWarning}<ul class="reasons">${view.keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`, 100)
    : synthesisWarning ? section('01', "Chairman's reasoning", `${synthesisWarning}<p class="muted">No reliable chairman reasoning was produced.</p>`, 100) : '';

  const scorecard = view.scorecard?.length
    ? `<div class="score-grid">${view.scorecard.map((s) => `<div class="score ${s.status}"><span>${escapeHtml(s.label)}</span><strong>${escapeHtml(s.status)}</strong></div>`).join('')}</div>`
    : '';

  const audit = view.audit?.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Statement</th><th>Status</th><th>Confidence</th><th>Analysts</th></tr></thead><tbody>
        ${view.audit.map((r) => `<tr><td>${escapeHtml(r.statement)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.confidence)}</td><td>${escapeHtml(r.providers.map(providerName).join(' · '))}</td></tr>`).join('')}
      </tbody></table></div>`
    : '';

  const riskCards = risks.length
    ? risks.map((r) => `
      <article class="card risk-card">
        <div class="card-top"><span class="chip ${sevClass(r.severity)}">${escapeHtml(sevLabel(r.severity))}</span>${providerDots(r.providers)}</div>
        <h3>${escapeHtml(r.assumption)}</h3>
        <div class="field"><span class="fk">The challenge</span>${paras(r.challenge)}</div>
        ${r.reasoning ? `<div class="field"><span class="fk">Why it stands</span><p>${escapeHtml(r.reasoning)}</p></div>` : ''}
      </article>`).join('')
    : '<p class="muted">No assumption failed scrutiny — the council did not sustain any objection.</p>';

  const debate = view.debates?.length
    ? view.debates.map((d) => `
      <article class="card debate-card">
        <p>${providerDots(d.claimantProviders)} <strong>claimed</strong> ${escapeHtml(d.claim)}.</p>
        <div class="field"><span class="fk">Counter</span>${providerDots(d.attackerProviders)}${paras(d.challenge)}</div>
        <div class="field"><span class="fk">Chair</span><p>${escapeHtml(d.chair)}${d.reasoning ? ` — ${escapeHtml(d.reasoning)}` : ''}</p></div>
      </article>`).join('')
    : '<p class="muted">No contradictions reached the chair.</p>';

  const plan = view.actionPlan && 'kind' in view.actionPlan
    ? `<div class="card"><div class="warns"><span class="warn">⚑ ${view.flags.filter((f) => f === 'plan_fallback' || f === 'plan_skipped').map((f) => escapeHtml(f.replaceAll('_', ' '))).join(' · ')}</span></div><p><strong>Planner unavailable: ${escapeHtml(view.actionPlan.reason)}</strong></p><ul class="checks">${view.actionPlan.unresolved_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>`
    : view.actionPlan
    ? `<div class="table-wrap"><table class="data-table plan-table"><thead><tr><th>#</th><th>Action</th><th>Why</th><th>Validates</th><th>Effort</th><th>Kill signal</th></tr></thead><tbody>
        ${view.actionPlan.actions.map((a) => `<tr><td>${a.order}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.why)}</td><td><code>${escapeHtml(a.validates)}</code></td><td>${escapeHtml(a.effort)}</td><td>${escapeHtml(a.kill_signal)}</td></tr>`).join('')}
      </tbody></table><p class="lede">${escapeHtml(view.actionPlan.sequencing_note)}</p></div>`
    : '<p class="muted">No validation plan artifact recorded.</p>';

  const questions = view.openQuestions?.length
    ? `<ul class="checks">${view.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
    : '<p class="muted">No verdict-flipping open questions recorded.</p>';

  const redTeam = `
    <div class="redteam">
      <div><span class="fk">Strongest counter-argument</span><ul>${view.dissent.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul></div>
      <div><span class="fk">Confidence</span><p>${escapeHtml(view.confidence || 'None recorded.')}</p></div>
    </div>`;

  const receipt = view.receipt?.length
    ? `<div class="receipt">${view.receipt.map((r) => `<span>${escapeHtml(r)}</span>`).join('')}</div>`
    : '';

  const modelCards = view.columns.length
    ? view.columns.map((c) => `
      <article class="card model-card">
        <h3>${escapeHtml(c.title)}</h3>
        ${c.lines.length ? `<ul class="model-lines">${c.lines.slice(0, 10).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '<p class="muted">No output recorded.</p>'}
      </article>`).join('')
    : '<p class="muted">No per-model output recorded.</p>';

  return `
    ${hero}
    ${chairman}
    ${scorecard ? section('02', 'Dimension scorecard', scorecard, 140, 'Best-effort keyword coverage across the 12 idea-vetting dimensions.') : ''}
    ${audit ? section('03', 'Assumption audit', audit, 180, 'Held, failed, or unverified assumptions derived from the disagreement map and chair rulings.') : ''}
    ${section('04', 'Risks that held up', riskCards, 220, 'Assumptions your idea depends on that the council challenged — and the challenge stuck.')}
    ${section('05', 'The debate', debate, 260, 'Who claimed what, who objected, and how the chair ruled.')}
    ${section('06', 'Validation plan', plan, 300, 'Ordered checks with kill signals, anchored to risks, blind spots, or open questions.')}
    ${section('07', 'Open questions that flip the verdict', questions, 340)}
    ${section('08', 'Red-team note', redTeam, 380)}
    ${receipt ? section('09', 'Receipt', receipt, 420) : ''}
    ${section('10', 'How each model saw it', `<div class="model-grid">${modelCards}</div>`, 460)}
    ${renderTechnical(view)}
  `;
}

function renderQuickIdeaBody(view: CouncilView): string {
  const tone = recommendationTone(view.recommendation, view.signal?.tone ?? 'caution');
  const label = recommendationLabel(view.recommendation, view.signal?.label ?? 'Quick analysis');
  const conditions = view.conditions?.length
    ? `<div class="conditions"><span class="fk">Conditions</span><ul>${view.conditions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const hero = `<section class="verdict tone-${tone} reveal" style="animation-delay:60ms"><span class="pill">${escapeHtml(label)}</span><p class="verdict-text">${escapeHtml(view.verdict)}</p>${conditions}</section>`;
  const reasoning = view.keyPoints.length
    ? `<ul class="reasons">${view.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>`
    : '<p class="muted">No structured reasoning recorded.</p>';
  const risks = view.risks?.length
    ? `<ul class="checks">${view.risks.map((risk) => `<li>${escapeHtml(risk.assumption)} — ${escapeHtml(risk.challenge)}</li>`).join('')}</ul>`
    : '<p class="muted">No load-bearing risk was supported strongly enough to list.</p>';
  const plan = view.actionPlan && !('kind' in view.actionPlan)
    ? `<ul class="checks">${view.actionPlan.actions.map((action) => `<li><strong>${escapeHtml(action.action)}</strong> — ${escapeHtml(action.kill_signal)}</li>`).join('')}</ul>`
    : '<p class="muted">No executable plan was produced.</p>';
  const analyst = view.columns.map((column) => `<article class="card model-card"><h3>${escapeHtml(column.title)}</h3><ul class="model-lines">${column.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></article>`).join('');
  const receipt = view.receipt?.length ? `<div class="receipt">${view.receipt.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>` : '';
  return `${hero}
    ${section('01', 'Analyst reasoning', reasoning, 100, 'One structured analyst; no council or independent-consensus claim.')}
    ${section('02', 'Load-bearing risks', risks, 180)}
    ${section('03', 'Validation plan', plan, 240)}
    ${receipt ? section('04', 'Receipt', receipt, 300) : ''}
    ${section('05', 'Analyst output', `<div class="model-grid">${analyst}</div>`, 360)}`;
}

/** Serialize a council view to clean Markdown — for the HTML "Copy" button (paste into a coding assistant). */
function councilMarkdown(view: CouncilView): string {
  if (view.decisionReport?.dossier) return renderDecisionDossierMarkdown(view.decisionReport);
  const isIdea = view.workflow !== 'code-review';
  const quick = isIdea && view.mode === 'quick';
  const reportV3 = isIdea && Boolean(view.recommendation || view.actionPlan);
  const L: string[] = [];
  L.push(`# ${isIdea && view.topic ? cleanTopic(view.topic) : isIdea ? 'Idea refinement' : 'Code review'}`, '');
  const panel = view.columns.map((c) => c.title).join(', ');
  if (panel) L.push(quick ? `Analyst: ${panel}` : `Panel: ${panel}${view.moderator ? ` · Chair: ${view.moderator}` : ''}`, '');
  if (view.recommendation) {
    L.push('## Bottom line', '', `**${recommendationLabel(view.recommendation, '')}** — ${view.verdict}`, '');
    if (view.conditions?.length) {
      L.push('Conditions:');
      for (const c of view.conditions) L.push(`- ${c}`);
      L.push('');
    }
  } else {
    L.push('## Verdict', '', view.verdict, '');
  }
  if (view.keyPoints?.length) {
    L.push(quick ? '## Analyst reasoning' : "## Chairman's reasoning", '');
    if (view.flags.includes('synthesis_suspect')) L.push('⚠ synthesis_suspect — the chair output required deterministic repair or degradation handling.', '');
    for (const p of view.keyPoints) L.push(`- ${p}`);
    L.push('');
  } else if (view.flags.includes('synthesis_suspect')) {
    L.push("## Chairman's reasoning", '', '⚠ synthesis_suspect — no reliable chairman reasoning was produced.', '');
  }
  if (isIdea) {
    if (reportV3 && view.scorecard?.length) {
      L.push('## Dimension scorecard (best-effort)', '');
      for (const s of view.scorecard) L.push(`- ${s.label}: ${s.status}`);
      L.push('');
    }
    if (reportV3 && view.audit?.length) {
      L.push('## Assumption audit', '');
      for (const a of view.audit) L.push(`- ${a.status}/${a.confidence}: ${a.statement} (${a.providers.map(providerName).join(', ')})`);
      L.push('');
    }
    if (view.risks?.length) {
      L.push('## Risks that held up', '');
      for (const r of view.risks) {
        L.push(`### ${r.assumption} (${sevLabel(r.severity)})`);
        L.push(`- Challenge: ${r.challenge.replace(/\s*\n+\s*/g, ' ')}`);
        if (r.reasoning) L.push(`- Why it stands: ${r.reasoning}`);
        L.push('');
      }
    }
    if (reportV3 && view.debates?.length) {
      L.push('## The debate', '');
      for (const d of view.debates) {
        L.push(`- ${d.claimantProviders.map(providerName).join(', ')} claimed ${d.claim}. ${d.attackerProviders.map(providerName).join(', ')} countered: ${d.challenge.replace(/\s*\n+\s*/g, ' ')}. Chair: ${d.chair}${d.reasoning ? ` — ${d.reasoning}` : ''}.`);
      }
      L.push('');
    }
    if (reportV3 && view.actionPlan) {
      L.push('## Validation plan', '');
      if ('kind' in view.actionPlan) {
        const planFlags = view.flags.filter((flag) => flag === 'plan_fallback' || flag === 'plan_skipped');
        L.push(`Planner unavailable: ${view.actionPlan.reason}${planFlags.length ? ` (${planFlags.join(', ')})` : ''}.`, '', 'Unresolved questions:');
        for (const question of view.actionPlan.unresolved_questions) L.push(`- ${question}`);
      } else {
        for (const a of view.actionPlan.actions) {
          L.push(`${a.order}. ${a.action}`);
          L.push(`   - Why: ${a.why}`);
          L.push(`   - Validates: ${a.validates}`);
          L.push(`   - Effort: ${a.effort}`);
          L.push(`   - Kill signal: ${a.kill_signal}`);
        }
        L.push('', view.actionPlan.sequencing_note);
      }
      L.push('');
    }
    if (reportV3 && view.openQuestions?.length) {
      L.push('## Open questions that flip the verdict', '');
      for (const q of view.openQuestions) L.push(`- ${q}`);
      L.push('');
    }
    if (view.columns.length) {
      L.push(quick ? '## Analyst output' : '## How each model saw it', '');
      for (const c of view.columns) {
        L.push(`### ${c.title}`);
        for (const l of c.lines.slice(0, 10)) L.push(`- ${l}`);
        L.push('');
      }
    }
    if (view.blindSpots?.length) {
      L.push('## Blind spots to resolve', '');
      for (const b of view.blindSpots) L.push(`- ${b}`);
      L.push('');
    }
    if (view.agreements?.length) {
      L.push('## Where the models agreed', '');
      for (const a of view.agreements) L.push(`- ${a.statement}`);
      L.push('');
    }
    if (!reportV3 && view.nextSteps?.length) {
      L.push('## Recommended next steps', '');
      view.nextSteps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
      L.push('');
    }
    if (reportV3 && view.receipt?.length) {
      L.push('## Receipt', '');
      for (const r of view.receipt) L.push(`- ${r}`);
      L.push('');
    }
  } else if (view.rows.length) {
    L.push('## Findings', '');
    for (const r of view.rows) {
      L.push(`- **${r.title}**${r.ruling ? ` — judge: ${r.ruling}` : ''}`);
      if (r.detail) L.push(`  - ${r.detail}`);
    }
    L.push('');
  }
  if (view.dissent.length) {
    L.push('## Dissent (strongest counter-argument)', '');
    for (const d of view.dissent) L.push(`- ${d}`);
    L.push('');
  }
  if (view.confidence) L.push('## Confidence', '', view.confidence, '');
  L.push('---', `Generated by aiki · ${view.runId} · analysis, not advice — verify before acting.`);
  return L.join('\n');
}

function renderReviewBody(view: CouncilView): string {
  const badge = (k: RowKind): string => {
    const label = k === 'consensus' ? 'Both agreed' : k === 'dispute' ? 'Disputed' : k === 'single' ? 'One reviewer' : k;
    return `<span class="chip k-${k}">${escapeHtml(label)}</span>`;
  };
  const rows = view.rows.map((r) => `
    <article class="card">
      <div class="card-top">${badge(r.kind)}${providerDots(r.providers)}</div>
      <h3>${escapeHtml(r.title)}</h3>
      ${r.detail ? `<div class="field"><span class="fk">Detail</span><p>${escapeHtml(r.detail)}</p></div>` : ''}
      ${r.ruling ? `<div class="field"><span class="fk">Judge</span><p>${escapeHtml(r.ruling)}</p></div>` : ''}
    </article>`).join('');
  const statsRow = view.stats.map((s) => `<span class="mchip">${escapeHtml(s)}</span>`).join('');
  const hero = `
  <section class="verdict tone-caution reveal" style="animation-delay:60ms">
    <span class="pill">Review complete</span>
    <p class="verdict-text">${escapeHtml(view.verdict)}</p>
    <div class="mstrip">${statsRow}</div>
  </section>`;
  return `
    ${hero}
    ${section('01', 'Findings', rows || '<p class="muted">No findings recorded.</p>', 180, 'Every issue the reviewers raised, and where they agreed or disagreed.')}
    ${renderTechnical(view)}
  `;
}

/** Collapsed power-user block: per-model raw output, dissent, confidence notes. */
function renderTechnical(view: CouncilView): string {
  const columns = view.columns.map((c) => `
    <div class="col">
      <h4>${escapeHtml(c.title)}</h4>
      ${c.lines.length ? `<ul>${c.lines.slice(0, 12).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '<p class="muted">No output recorded.</p>'}
    </div>`).join('');
  const dissent = view.dissent.length ? `<ul>${view.dissent.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
  return `
  <details class="fold reveal" style="animation-delay:0ms">
    <summary>${view.mode === 'quick' ? 'Full single-analyst output (technical)' : 'Full council analysis (technical)'}</summary>
    <div class="fold-body">
      <h4 class="fold-h">Each model, in its own words</h4>
      <div class="cols">${columns || '<p class="muted">No model output recorded.</p>'}</div>
      <h4 class="fold-h">The moderator's strongest counter-argument (dissent)</h4>
      ${dissent}
      <h4 class="fold-h">Confidence notes</h4>
      <p>${escapeHtml(view.confidence || 'None recorded.')}</p>
    </div>
  </details>`;
}

export function renderCouncilHtml(view: CouncilView): string {
  const isIdea = view.workflow !== 'code-review';
  const quick = isIdea && view.mode === 'quick';
  const hasReaderBrief = Boolean(view.decisionReport?.dossier.readerBrief);
  const kicker = quick ? 'aiki · quick analysis' : isIdea ? 'aiki · idea refinement' : 'aiki · code review';
  const title = isIdea && view.topic ? cleanTopic(view.topic) : (isIdea ? 'Idea refinement' : 'Code review');
  const panel = view.columns.map((c) => c.title);
  const metaBits = hasReaderBrief ? [] : [
    panel.length ? `${quick ? 'Analyst' : 'Panel'}: ${panel.join(' · ')}` : '',
    !quick && view.moderator ? `Chair: ${view.moderator}` : '',
    view.calls,
  ].filter(Boolean);
  const flags = !hasReaderBrief && view.flags.length
    ? `<div class="warns">${view.flags.map((f) => `<span class="warn">⚑ ${escapeHtml(f.replaceAll('_', ' '))}</span>`).join('')}</div>`
    : '';
  const body = isIdea && view.decisionReport?.dossier
    ? view.decisionReport.dossier.readerBrief
      ? renderReaderBriefIdeaBody(view.decisionReport)
      : renderDossierIdeaBody(view.decisionReport)
    : quick ? renderQuickIdeaBody(view) : isIdea ? renderIdeaBody(view) : renderReviewBody(view);
  // Embed the report as Markdown for the Copy button. Escape "<" so a "</script>" in content can't break out.
  const md = JSON.stringify(councilMarkdown(view)).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(quick ? 'Quick analysis' : isIdea ? 'Idea refinement' : 'Code review')} — aiki</title>
<style>
:root{
  color-scheme: light;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Charter,Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Avenir Next","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
  --paper:#fbfaf7; --panel:#f1efe9; --ink:#171a18; --soft:#59625e; --faint:#8b928e; --line:#dcded8;
  --good:#176b52; --good-bg:#e5f3ed; --risk:#a63a30; --risk-bg:#f8e8e4;
  --caution:#a96813; --caution-bg:#f8eedc; --slate:#4f5e59; --accent:#155f55;
}
*{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;}
main{max-width:940px;margin:0 auto;padding:34px 24px 90px;}
a{color:var(--accent);}
h1{font-family:var(--serif);font-weight:600;letter-spacing:-.025em;}
h2,h3,h4{font-family:var(--sans);font-weight:650;letter-spacing:-.01em;}
p{margin:0 0 .6em;}

/* masthead */
.mast{border-bottom:1px solid var(--ink);padding-bottom:22px;margin-bottom:30px;}
.kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);}
.mast h1{font-size:clamp(32px,5.4vw,50px);line-height:1.05;margin:12px 0 18px;max-width:18ch;}
.mmeta{display:flex;flex-wrap:wrap;gap:7px;}
.mmeta span{font-family:var(--mono);font-size:11.5px;color:var(--soft);border:1px solid var(--line);background:var(--panel);border-radius:100px;padding:3px 10px;}
.warns{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;}
.warn{font-family:var(--mono);font-size:11.5px;color:var(--caution);background:var(--caution-bg);border:1px solid #e6d09b;border-radius:6px;padding:3px 9px;}

/* verdict hero */
.verdict{position:relative;background:#fff;border:1px solid var(--line);border-radius:18px;
  padding:30px 32px 26px;margin-bottom:18px;overflow:hidden;box-shadow:0 18px 50px rgba(32,45,40,.07);}
.verdict::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;}
.tone-good::before{background:var(--good);} .tone-caution::before{background:var(--caution);} .tone-risk::before{background:var(--risk);}
.pill{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.02em;
  padding:5px 13px;border-radius:100px;}
.tone-good .pill{background:var(--good-bg);color:var(--good);} .tone-caution .pill{background:var(--caution-bg);color:var(--caution);}
.tone-risk .pill{background:var(--risk-bg);color:var(--risk);}
.decision-status{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;}
.decision-status>span:last-child{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;color:var(--soft);text-transform:uppercase;}
.verdict-text{font-family:var(--sans);font-weight:700;font-size:clamp(18px,2.3vw,21px);line-height:1.42;color:var(--ink);margin:0;max-width:68ch;letter-spacing:-.012em;}
.verdict-detail{font-size:14.5px;line-height:1.62;color:var(--soft);margin:9px 0 0;max-width:76ch;}
.section-eyebrow{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin-bottom:9px;}
.decision-numbers{margin:0 0 20px;}.snapshot-table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.4;}
.snapshot-table th{padding:8px 10px;text-align:left;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line);}
.snapshot-table td{padding:11px 10px;vertical-align:top;border-bottom:1px solid var(--line);}.snapshot-table tbody tr:last-child td{border-bottom:0;}
.snapshot-table .number-value{font-family:var(--serif);font-size:17px;font-weight:700;color:var(--ink);white-space:nowrap;}
.snapshot-table code,.payback-result code,.tripwire code{font-size:9.5px;color:var(--faint);white-space:nowrap;}
.payback-result{display:grid;grid-template-columns:auto 1fr;gap:3px 16px;align-items:baseline;margin-top:10px;padding:14px 16px;background:var(--paper);border:1px solid var(--line);border-radius:10px;}
.payback-result span{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);}.payback-result strong{font-family:var(--serif);font-size:18px;}.payback-result p{grid-column:1/-1;margin:2px 0 0;font-size:12.5px;color:var(--soft);}
.evidence-coverage{margin:24px 0 18px;padding:14px 16px;background:var(--paper);border:1px solid var(--line);border-radius:12px;}
.evidence-coverage>div:first-child{display:flex;align-items:end;justify-content:space-between;gap:12px;}
.evidence-coverage strong{font-family:var(--mono);font-size:13px;color:var(--ink);}
.coverage-track{height:5px;margin:10px 0;border-radius:99px;background:var(--line);overflow:hidden;}
.coverage-track span{display:block;height:100%;border-radius:inherit;background:var(--accent);}
.evidence-coverage.low .coverage-track span{background:var(--risk);}.evidence-coverage.medium .coverage-track span{background:var(--caution);}
.evidence-coverage p{font-size:13.5px;color:var(--soft);margin:0;}
.decision-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:18px 0;}
.decision-fact{padding:16px;background:var(--paper);border:1px solid var(--line);border-radius:12px;}
.decision-fact span,.action-callout>span{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin-bottom:7px;}
.decision-fact p{margin:0;font-size:14.5px;line-height:1.5;}
.action-callout{position:relative;margin:20px 0;padding:20px 22px 20px 26px;background:var(--ink);color:var(--paper);border-radius:12px;}
.action-callout::before{content:"→";position:absolute;right:20px;top:12px;font-family:var(--serif);font-size:34px;color:#8fc7b9;}
.action-callout>span{color:#8fc7b9;}.action-callout p{font-size:17px;line-height:1.5;margin:0;padding-right:34px;}
.option-comparison{margin:22px 0;}.basis-chip{display:inline-block;padding:3px 7px;border-radius:99px;background:var(--good-bg);color:var(--good);font-family:var(--mono);font-size:9px;letter-spacing:.04em;white-space:nowrap;}
.basis-chip.target_cap{background:var(--caution-bg);color:var(--caution);}.basis-chip.unknown{background:var(--risk-bg);color:var(--risk);}
.tripwire{margin:14px 0;padding:16px 18px;border:1px solid #b9d5cd;border-left:4px solid var(--accent);border-radius:10px;background:#f2f8f6;}
.tripwire .tag{display:block;color:var(--accent);margin-bottom:6px;}.tripwire strong{display:block;font-family:var(--serif);font-size:19px;}.tripwire p{margin:5px 0 0;font-size:13.5px;color:var(--soft);}
.decision-safety{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px;}
.decision-safety article{padding:17px 18px;background:var(--paper);border:1px solid var(--line);border-radius:12px;}
.decision-safety article:first-child{border-left:4px solid var(--risk);}
.decision-safety p{font-size:14px;margin:0;}
.critical-unknowns{margin:0;padding-left:18px;}.critical-unknowns li{font-size:13.5px;margin:0 0 6px;}
.critical-warning{margin-top:12px;padding:14px 16px;background:var(--risk-bg);border:1px solid #e1b8b1;border-radius:10px;}
.critical-warning .tag{color:var(--risk);}.critical-warning p{font-size:13.5px;margin:0;}
.council-read{margin:15px 0 0;font-size:13.5px;color:var(--soft);}
.decision-details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px;}
.decision-details summary{cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--soft);text-transform:uppercase;letter-spacing:.08em;}
.decision-details>div{padding-top:10px;font-size:13.5px;}.decision-details ul{margin:8px 0;padding-left:18px;}
.decision-evidence{margin-top:12px;border-top:1px solid var(--line);padding-top:12px;}
.decision-evidence summary{cursor:pointer;font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.07em;text-transform:uppercase;}
.decision-evidence ul{margin:10px 0 0;padding-left:20px;}.decision-evidence li{font-size:13px;color:var(--soft);margin-bottom:5px;}

/* top action bar + copy */
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 20px;background:var(--panel);border-bottom:1px solid var(--line);}
.bar-label{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft);}
.copy-btn{font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer;color:#fff;background:var(--accent);
  border:0;border-radius:8px;padding:8px 15px;transition:background .15s ease,transform .1s ease;}
.copy-btn:hover{filter:brightness(1.05);} .copy-btn:active{transform:translateY(1px);}
.copy-btn.ok{background:var(--good);}
button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid rgba(21,95,85,.28);outline-offset:3px;}

/* chairman's reasoning */
.reasons{margin:0;padding:0;list-style:none;}
.reasons li{position:relative;padding:11px 0 11px 26px;border-bottom:1px solid var(--line);font-size:15.5px;color:var(--ink);}
.reasons li:last-child{border-bottom:0;}
.reasons li::before{content:"";position:absolute;left:4px;top:18px;width:7px;height:7px;border-radius:50%;background:var(--accent);}

/* per-model grid */
.model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;}
.model-card h3{font-size:15.5px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line);}
.model-lines{margin:0;padding-left:18px;} .model-lines li{font-size:13.5px;color:#3a3f47;margin-bottom:7px;}
.glance{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:22px;}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:14px 12px;text-align:center;}
.stat .n{display:block;font-family:var(--serif);font-size:30px;line-height:1;}
.stat .k{display:block;font-size:12.5px;color:var(--soft);margin-top:6px;}
.stat.good .n{color:var(--good);} .stat.risk .n{color:var(--risk);} .stat.caution .n{color:var(--caution);}

/* bottom line */
.bottomline{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:34px;}
.verdict .bottomline{margin:18px 0 0;}
.bottomline > div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;}
.tag{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:7px;}
.bottomline p{margin:0;font-size:15px;color:var(--ink);}

/* sections */
.block{margin:38px 0;}
.block-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:14px;}
.idx{font-family:var(--mono);font-size:12px;color:var(--faint);letter-spacing:.1em;}
.block h2{font-size:22px;margin:0;}
.lede{color:var(--soft);font-size:14.5px;margin:0 0 16px;max-width:62ch;}

/* cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px;transition:box-shadow .18s ease,transform .18s ease;}
.card:hover{box-shadow:0 6px 22px rgba(34,29,22,.07);transform:translateY(-1px);}
.risk-card{border-left:4px solid var(--risk);}
.card.mini{border-left:4px solid var(--slate);}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
.card h3{font-size:18px;line-height:1.35;margin:0 0 12px;}
.card.mini h3{font-size:15.5px;}
.field{margin-top:10px;}
.fk{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin-bottom:4px;}
.field p{margin:0 0 .5em;font-size:14.5px;color:#3d3629;}
.chip{font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;white-space:nowrap;}
.sev-high{background:var(--risk-bg);color:var(--risk);} .sev-med{background:var(--caution-bg);color:var(--caution);} .sev-low{background:#e7edf0;color:var(--slate);}
.k-consensus{background:var(--good-bg);color:var(--good);} .k-dispute{background:var(--risk-bg);color:var(--risk);} .k-single,.k-unique{background:#e7edf0;color:var(--slate);}

/* provider dots */
.who{display:inline-flex;align-items:center;gap:6px;}
.dot{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:9.5px;font-weight:700;}
.who-names{font-size:12px;color:var(--soft);}

/* blind spots */
.checks{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.checks li{position:relative;background:var(--caution-bg);border:1px solid #e6d09b;border-radius:10px;padding:12px 14px 12px 38px;font-size:14.5px;color:#5f4a15;}
.checks li::before{content:"?";position:absolute;left:12px;top:50%;transform:translateY(-50%);width:18px;height:18px;border-radius:50%;background:var(--caution);color:#fff;font-family:var(--mono);font-size:11px;font-weight:700;display:grid;place-items:center;}

/* agreements */
.agree{list-style:none;margin:0;padding:0;}
.agree li{border-left:4px solid var(--good);background:var(--good-bg);border-radius:0 10px 10px 0;padding:13px 16px;margin-bottom:10px;}
.agree li p{margin:0 0 8px;font-size:15px;}

/* steps */
.steps{margin:0;padding:0;list-style:none;counter-reset:s;}
.steps li{counter-increment:s;position:relative;padding:12px 0 12px 46px;border-bottom:1px solid var(--line);font-size:15px;}
.steps li:last-child{border-bottom:0;}
.steps li::before{content:counter(s);position:absolute;left:0;top:11px;width:28px;height:28px;border-radius:50%;border:1.5px solid var(--accent);color:var(--accent);font-family:var(--mono);font-size:13px;font-weight:600;display:grid;place-items:center;}

/* report v3 */
.conditions{margin-top:16px;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px 14px;}
.conditions ul{margin:4px 0 0;padding-left:18px;}
.conditions li{font-size:14px;margin-bottom:4px;}
.score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;}
.score{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:12px 14px;min-height:74px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;}
.score span{font-size:13.5px;color:var(--ink);}
.score strong{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;}
.score.contested{border-left:4px solid var(--caution);} .score.examined{border-left:4px solid var(--good);} .score.unexamined{border-left:4px solid var(--risk);}
.table-wrap{overflow-x:auto;overscroll-behavior-inline:contain;scrollbar-width:thin;}
.data-table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13.5px;}
.data-table th,.data-table td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:9px 10px;}
.data-table th{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--soft);background:var(--paper);}
.data-table tr:last-child td{border-bottom:0;}
.data-table code{font-family:var(--mono);font-size:12px;color:var(--accent);}
.feature-groups{display:grid;gap:14px;margin-bottom:26px;}
.feature-group{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.feature-group>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--paper);}
.feature-group>header div>span{display:block;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.13em;color:var(--accent);}
.feature-group>header h4{font-size:14px;margin:2px 0 0;}.feature-group>header>strong{font-family:var(--serif);font-size:24px;color:var(--soft);}
.feature-group ul{list-style:none;margin:0;padding:0 18px;}.feature-group li{padding:14px 0;border-bottom:1px solid var(--line);}.feature-group li:last-child{border-bottom:0;}
.feature-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}.feature-title>strong{font-size:15px;}.feature-title>span{font-family:var(--mono);font-size:10px;border:1px solid var(--line);border-radius:99px;padding:1px 7px;color:var(--soft);}
.feature-group p{font-size:13.5px;margin:3px 0;color:var(--ink);}.feature-group small{display:block;font-size:12.5px;line-height:1.45;color:var(--soft);}
.priority-must{border-left:4px solid var(--accent);}.priority-should{border-left:4px solid var(--caution);}.priority-later{border-left:4px solid var(--slate);}
.milestone-list{list-style:none;margin:0 0 28px;padding:0;}.milestone-list>li{display:grid;grid-template-columns:90px 1fr;gap:18px;position:relative;padding-bottom:18px;}
.milestone-list>li:not(:last-child)::before{content:"";position:absolute;left:23px;top:37px;bottom:0;border-left:1px solid var(--line);}
.milestone-marker{position:relative;z-index:1;display:flex;flex-direction:column;align-items:flex-start;}.milestone-marker>span{display:grid;place-items:center;width:47px;height:35px;border-radius:9px;background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:12px;}.milestone-marker small{font-size:11px;color:var(--soft);margin-top:5px;}
.milestone-list article{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;}.milestone-list h4{font-size:16px;margin:0 0 8px;}.milestone-list article ul{margin:0;padding-left:18px;}.milestone-list article li{font-size:13.5px;margin-bottom:4px;}
.acceptance{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);}.acceptance span{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--good);}.acceptance p{font-size:13px;margin:2px 0 0;}
.experiment-list{display:grid;gap:12px;margin-bottom:14px;}.experiment-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;}
.experiment-head{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:10px;}.experiment-head>span{font-family:var(--mono);font-size:11px;color:var(--accent);}.experiment-head h4{font-size:15px;margin:0;}.experiment-head>strong{font-family:var(--mono);font-size:10px;border:1px solid var(--line);border-radius:99px;padding:2px 7px;color:var(--soft);}
.experiment-card>p{font-size:13.5px;color:var(--soft);margin:8px 0 12px 27px;}.experiment-card dl{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 0 27px;}.experiment-card dl>div{background:var(--paper);border-radius:8px;padding:9px 11px;}.experiment-card dt{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);}.experiment-card dd{font-size:12.5px;line-height:1.45;margin:2px 0 0;}
.inline-fold{margin:14px 0;border:1px solid var(--line);border-radius:10px;background:var(--panel);}.inline-fold>summary{cursor:pointer;padding:11px 14px;font-family:var(--mono);font-size:11px;letter-spacing:.05em;color:var(--soft);}.inline-fold>ul,.inline-fold>.table-wrap,.inline-fold>p{margin:0 14px 14px;}.inline-fold.compact{background:var(--paper);}.inline-fold.compact>p{font-size:13.5px;color:var(--soft);}
.debate-card p{margin-bottom:8px;}
.redteam{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.redteam>div{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;}
.redteam ul{margin:4px 0 0;padding-left:18px;}
.receipt{display:flex;flex-wrap:wrap;gap:8px;}
.receipt span{font-family:var(--mono);font-size:11.5px;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 10px;color:var(--soft);}

/* folds */
.fold{margin:24px 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;}
.fold > summary{cursor:pointer;list-style:none;padding:16px 20px;font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);display:flex;align-items:center;gap:10px;}
.fold > summary::-webkit-details-marker{display:none;}
.fold > summary::before{content:"+";font-size:16px;color:var(--accent);}
.fold[open] > summary::before{content:"–";}
.fold[open] > summary{border-bottom:1px solid var(--line);color:var(--ink);}
.fold-body{padding:6px 20px 20px;}
.fold-h{font-size:14px;color:var(--soft);margin:18px 0 8px;text-transform:none;letter-spacing:0;}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;}
.col{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:14px;}
.col h4{margin:0 0 10px;font-size:14px;}
.col ul,.fold-body ul{margin:0;padding-left:18px;}
.col li,.fold-body li{font-size:13px;color:#3d3629;margin-bottom:7px;}
.mstrip{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;}
.mchip{font-family:var(--mono);font-size:12px;color:var(--soft);border:1px solid var(--line);background:var(--paper);border-radius:100px;padding:3px 11px;}

.muted{color:var(--faint);font-style:italic;}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--faint);}

.reveal{opacity:0;transform:translateY(10px);animation:rise .5s cubic-bezier(.2,.7,.2,1) forwards;}
@keyframes rise{to{opacity:1;transform:none;}}
@media (max-width:640px){
  main{padding:34px 16px 60px;}
  .verdict{padding:24px 20px 20px;}
  .glance,.bottomline,.checks,.redteam,.decision-safety{grid-template-columns:1fr;}
  .decision-status{align-items:flex-start;flex-direction:column;gap:8px;}.decision-status>span:last-child{text-align:left;}.pill{white-space:nowrap;}
  .snapshot-table{min-width:0;}.snapshot-table thead{display:none;}.snapshot-table tbody,.snapshot-table tr,.snapshot-table td{display:block;width:100%;}
  .snapshot-table tr{padding:12px 0;border-bottom:1px solid var(--line);}.snapshot-table td{padding:3px 8px;border:0;white-space:normal;}
  .snapshot-table td::before{display:block;font-family:var(--mono);font-size:9px;line-height:1.4;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);}
  .decisive-table td:nth-child(1)::before{content:"Metric";}.decisive-table td:nth-child(2)::before{content:"Value";}.decisive-table td:nth-child(3)::before{content:"What it means";}
  .options-table td:nth-child(1)::before{content:"Path";}.options-table td:nth-child(2)::before{content:"Commitment";}.options-table td:nth-child(3)::before{content:"Basis";}.options-table td:nth-child(4)::before{content:"Trade-off";}
  .payback-result{grid-template-columns:1fr;}.payback-result p{grid-column:1;}
  .milestone-list>li{grid-template-columns:64px 1fr;gap:10px;}.experiment-card dl{grid-template-columns:1fr;}.experiment-card>p,.experiment-card dl{margin-left:0;}
}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;animation:none;}}
@media print{.reveal{opacity:1;transform:none;animation:none;}.fold[open]{break-inside:avoid;}}
</style>
</head>
<body>
<div class="bar">
  <span class="bar-label">${escapeHtml(kicker)}</span>
  <button id="copy-report" class="copy-btn">Copy report (Markdown)</button>
</div>
<main>
  <header class="mast">
    <h1>${escapeHtml(title)}</h1>
    <div class="mmeta">${metaBits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>
    ${flags}
  </header>
  ${body}
  <footer>Generated by aiki · ${escapeHtml(view.runId)} · ${quick ? 'single-model quick analysis' : 'a local model council'}. This is analysis, not advice — verify before acting.</footer>
</main>
<script>
const REPORT_MD = ${md};
async function copyReport(btn){
  var original=btn.textContent;
  try {
    var copied=false;
    if(navigator.clipboard && navigator.clipboard.writeText){
      try{ await navigator.clipboard.writeText(REPORT_MD); copied=true; }catch(error){}
    }
    if(!copied){
      var field=document.createElement('textarea');
      field.value=REPORT_MD; field.setAttribute('readonly','');
      field.style.position='fixed'; field.style.opacity='0';
      document.body.appendChild(field); field.select();
      copied=document.execCommand('copy'); field.remove();
      if(!copied) throw new Error('copy unavailable');
    }
    btn.textContent='✓ Copied'; btn.classList.add('ok');
  }catch(error){
    btn.textContent='Copy failed — select the text manually';
  }
  setTimeout(function(){ btn.textContent=original; btn.classList.remove('ok'); }, 1800);
}
document.getElementById('copy-report').addEventListener('click',function(){ copyReport(this); });
</script>
</body>
</html>`;
}

export async function writeCouncilHtml(runId: string, dir: string): Promise<string | null> {
  const view = await loadCouncilView(runId, dir);
  if (!view) return null;
  const path = join(dir, 'council-view.html');
  await writeFile(path, renderCouncilHtml(view));
  return path;
}
