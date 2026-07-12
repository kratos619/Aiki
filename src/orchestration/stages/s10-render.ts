// S10 — artifact rendering (§9, §12.1, §307). Pure code → `final-report.md`, a DECISION BRIEF, not a
// smoothed essay (§263). Every section is assembled deterministically from prior artifacts; the only
// computed content is the assumption-audit status/confidence, which is DERIVED here (not taken from
// the judge — §624). A truly missing required field is a template bug (fail loudly); degraded-but-valid
// states (S8 skipped, items UNVERIFIED, empty consensus) render normally. User-facing → DISPLAY_NAME.

import type { ActionPlanArtifact, IntentContract, JudgeReport, Recommendation, VerificationSet } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';
import type { RubricItem } from './s7-decision-graph.js';
import type { DecisionGraph } from '../decision-graph.js';

export interface AuditRow {
  id: string;
  statement: string;
  providers: ProviderId[];
  status: 'held' | 'failed' | 'unverified';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Pure graph-backed decision audit. */
export function deriveAudit(graph: DecisionGraph, judgeReport: JudgeReport): AuditRow[] {
  const ruling = new Map(judgeReport.adjudications.map((a) => [a.id, a.ruling]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));

  return graph.claims.map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const providers = [...new Set(positions.map((position) => position.provider))];
    let status: AuditRow['status'];
    let confidence: AuditRow['confidence'];
    if (claim.state === 'UNCERTAIN' || claim.evidence_state !== 'SUPPORTED') {
      [status, confidence] = ['unverified', 'LOW'];
    } else if (claim.state === 'SHARED_CONCERN' || (claim.state === 'UNIQUE' && positions[0]?.stance === 'OPPOSE')) {
      [status, confidence] = ['failed', providers.length >= 2 ? 'HIGH' : 'MEDIUM'];
    } else if (claim.state === 'DISAGREEMENT') {
      const result = ruling.get(claim.id);
      if (result === 'UPHOLD') [status, confidence] = ['failed', 'MEDIUM'];
      else if (result === 'REJECT') [status, confidence] = ['held', 'MEDIUM'];
      else [status, confidence] = ['unverified', 'LOW'];
    } else {
      [status, confidence] = ['held', providers.length >= 2 ? 'HIGH' : 'MEDIUM'];
    }
    return { id: claim.id, statement: claim.proposition, providers, status, confidence };
  });
}

const disp = (id: ProviderId): string => DISPLAY_NAME[id];
const attrib = (ps: ProviderId[]): string => ps.map(disp).join(', ');

/** Union of the seats' decision questions, deduped by lexical similarity (≥0.85), capped. */
export function mergeOpenQuestions(seats: SeatOutput[], cap = 10): string[] {
  const kept: Array<{ q: string; tokens: Set<string> }> = [];
  for (const seat of seats) {
    for (const { question: q } of seat.output.decision_questions) {
      const tokens = tokenize(q);
      if (!kept.some((k) => overlap(k.tokens, tokens) >= 0.85)) kept.push({ q, tokens });
    }
  }
  return kept.slice(0, cap).map((k) => k.q);
}

export interface ScorecardRow {
  id: string;
  label: string;
  status: 'contested' | 'examined' | 'unexamined';
}

/** Exact rubric coverage derived from graph dimension anchors and holes. */
export function deriveScorecard(rubric: RubricItem[], graph: DecisionGraph): ScorecardRow[] {
  const blind = new Set(graph.holes.coverage.map((hole) => hole.dimension_id));
  const claimByPosition = new Map(graph.claims.flatMap((claim) => claim.position_ids.map((id) => [id, claim] as const)));
  return rubric.map((r) => {
    if (blind.has(r.id)) return { id: r.id, label: r.label, status: 'unexamined' as const };
    const contested = graph.positions
      .filter((position) => position.dimension_id === r.id)
      .some((position) => {
        const state = claimByPosition.get(position.id)?.state;
        return state === 'DISAGREEMENT' || state === 'UNCERTAIN';
      });
    return { id: r.id, label: r.label, status: contested ? 'contested' : 'examined' };
  });
}

export interface S10Args {
  contract: IntentContract;
  seats: SeatOutput[];
  graph: DecisionGraph;
  verifications: VerificationSet;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlanArtifact;
  rubric?: RubricItem[];
  original?: string; // raw user input; contract.task (normalized) is the fallback
}

function mdCell(s: string): string {
  return s.replaceAll('\n', ' ').replaceAll('|', '\\|');
}

function rulingPhrase(ruling: string | undefined): string {
  if (ruling === 'UPHOLD') return 'the objection stands';
  if (ruling === 'REJECT') return 'the idea holds here';
  return 'left to you';
}

// ── Report status + structural confidence (three-level report v4) ───────────

/** BLOCKED (missing access/inputs) never reaches S10 — failed runs render through the error path. */
export type ReportStatus = 'ACCEPTED' | 'ACCEPTED_WITH_CONDITIONS' | 'INCONCLUSIVE' | 'REJECTED';

export function statusFrom(judgeReport: JudgeReport): ReportStatus {
  switch (judgeReport.recommendation) {
    case 'PROCEED': return 'ACCEPTED';
    case 'PROCEED_WITH_CONDITIONS': return 'ACCEPTED_WITH_CONDITIONS';
    case 'PIVOT':
    case 'STOP': return 'REJECTED';
    default: return 'INCONCLUSIVE';
  }
}

export interface ConfidenceBreakdown {
  score: number; // 0–100
  label: 'High' | 'Medium' | 'Low';
  verificationCoverage: number; // 0–1: SUPPORTED load-bearing claims
  independentConvergence: number; // 0–1: multi-model agreement (CONSENSUS + SHARED_CONCERN)
  evidenceQuality: number; // 0–1: evidence cards beyond model memory
  stability: number; // 0–1: 1 minus degradation-flag penalty
  criticalRiskPenalty: number; // points subtracted for unsupported if_false=STOP claims
}

const DEGRADATION_FLAGS = ['low_diversity', 'synthesis_suspect', 'plan_fallback', 'plan_skipped'];

/** Structural confidence — 40% verification coverage + 25% convergence + 20% evidence quality +
 *  15% stability − critical-risk penalty. A starting heuristic, NOT a calibrated probability; model
 *  self-confidence never enters it, and consensus alone can never reach the High band. */
export function computeConfidence(graph: DecisionGraph, flags: ReadonlySet<string>): ConfidenceBreakdown {
  const loadBearing = graph.claims.filter((claim) => claim.load_bearing);
  const verificationCoverage = loadBearing.length
    ? loadBearing.filter((claim) => claim.evidence_state === 'SUPPORTED').length / loadBearing.length : 0;
  const independentConvergence = graph.claims.length
    ? graph.claims.filter((claim) => claim.state === 'CONSENSUS' || claim.state === 'SHARED_CONCERN').length / graph.claims.length : 0;
  const evidenceQuality = graph.evidence.length
    ? graph.evidence.filter((card) => card.source_kind !== 'MODEL_KNOWLEDGE').length / graph.evidence.length : 0;
  const stability = Math.max(0, 1 - 0.25 * DEGRADATION_FLAGS.filter((flag) => flags.has(flag)).length);
  const criticalRiskPenalty = Math.min(20, 5 * loadBearing.filter(
    (claim) => claim.if_false === 'STOP' && claim.evidence_state !== 'SUPPORTED').length);
  let score = Math.round(verificationCoverage * 40 + independentConvergence * 25 + evidenceQuality * 20 + stability * 15 - criticalRiskPenalty);
  if (verificationCoverage < 0.5) score = Math.min(score, 79); // consensus alone never yields High
  score = Math.max(0, Math.min(100, score));
  const label = score >= 80 ? 'High' : score >= 60 ? 'Medium' : 'Low';
  return { score, label, verificationCoverage, independentConvergence, evidenceQuality, stability, criticalRiskPenalty };
}

// ── Machine-readable report (level 3) ───────────────────────────────────────

type MapStance = 'AGREE' | 'DISAGREE' | 'CONDITIONAL' | 'UNKNOWN';
type ClaimRuling = 'ACCEPTED' | 'REJECTED' | 'CONDITIONAL' | 'UNRESOLVED';

export interface DecisionReportJson {
  reportId: string;
  generatedAt: string;
  task: { original: string; normalized: string; type: string; constraints: string[]; successCriteria: string[] };
  verdict: {
    status: ReportStatus;
    summary: string;
    confidence: number; // 0–1
    confidenceLabel: 'High' | 'Medium' | 'Low';
    consensusType: 'unanimous' | 'convergent_with_unresolved_claims' | 'majority_with_dissent' | 'contested';
    conditions: string[];
    primaryReason: string;
    criticalWarning: string | null;
  };
  confidenceBreakdown: ConfidenceBreakdown;
  models: Array<{ provider: ProviderId; name: string; roles: string[] }>;
  positions: Array<{ provider: ProviderId; name: string; initialConclusion: string; mainArgument: string; keyRisk: string; finalPosition: 'Support' | 'Oppose' | 'Conditional' }>;
  claims: Array<{ id: string; text: string; stances: Partial<Record<ProviderId, MapStance>>; verification: 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED'; ruling: ClaimRuling; loadBearing: boolean; sensitivity: string }>;
  consensusSummary: { unanimous: number; accepted: number; conditional: number; unresolved: number; rejected: number };
  disagreements: Array<{ id: string; topic: string; sides: Array<{ stance: string; providers: string[]; reasoning: string[] }>; ruling: string; reasoning: string | null; status: 'RESOLVED' | 'UNRESOLVED' }>;
  minority: { dissent: string[]; uniqueOppositions: Array<{ provider: string; proposition: string }>; blocksDecision: 'YES' | 'NO' | 'ONLY_IF_CONDITION' };
  verification: { results: Array<{ claimId: string; claim: string; method: string; verdict: 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN'; evidence: string; note: string }>; confirmed: number; refuted: number; uncertain: number };
  risks: Array<{ risk: string; severity: 'High' | 'Medium' | 'Low' }>;
  recommendedActions: Array<{ order: number; action: string; why: string; effort: string; killSignal: string }>;
  openQuestions: string[];
  flags: string[];
  receipt: { calls: number; budget: number; byProvider: Record<string, number>; modelTimeMs: number };
}

const STANCE_MAP: Record<string, MapStance> = { SUPPORT: 'AGREE', OPPOSE: 'DISAGREE', MIXED: 'CONDITIONAL', UNKNOWN: 'UNKNOWN' };
const VERIFICATION_MAP = { SUPPORTED: 'VERIFIED', CONFLICTED: 'PARTIAL', UNVERIFIED: 'UNVERIFIED' } as const;
const SEVERITY_MAP: Record<string, 'High' | 'Medium' | 'Low'> = { DECISIVE: 'High', MATERIAL: 'Medium', LOW: 'Low' };

function claimRuling(claim: DecisionGraph['claims'][number], adjudication?: { ruling: string }): ClaimRuling {
  // UPHOLD/REJECT inverts ONLY on a disagreement (the ruling is on the objection); for every other
  // state the ruling is evidence-based, matching deriveAudit's semantics.
  if (claim.state === 'DISAGREEMENT') {
    if (!adjudication || adjudication.ruling === 'UNRESOLVED') return 'UNRESOLVED';
    return adjudication.ruling === 'UPHOLD' ? 'REJECTED' : 'ACCEPTED';
  }
  if (claim.state === 'UNCERTAIN') return 'UNRESOLVED';
  return claim.evidence_state === 'SUPPORTED' ? 'ACCEPTED' : 'CONDITIONAL';
}

/** Assemble the machine-readable report deterministically from the run's persisted artifacts. */
export function buildDecisionReport(ctx: RunCtx, args: S10Args): DecisionReportJson {
  const { contract, seats, graph, verifications, judgeReport, actionPlan } = args;
  const flags = new Set(ctx.flags);
  const confidence = computeConfidence(graph, flags);
  const status = statusFrom(judgeReport);
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));

  const claims = graph.claims.map((claim) => {
    const stances: Partial<Record<ProviderId, MapStance>> = {};
    for (const id of claim.position_ids) {
      const position = positionById.get(id)!;
      stances[position.provider] ??= STANCE_MAP[position.stance] ?? 'UNKNOWN';
    }
    return {
      id: claim.id,
      text: claim.proposition,
      stances,
      verification: VERIFICATION_MAP[claim.evidence_state],
      ruling: claimRuling(claim, rulingById.get(claim.id)),
      loadBearing: claim.load_bearing,
      sensitivity: claim.sensitivity,
    };
  });

  const disagreements = graph.claims.filter((claim) => claim.state === 'DISAGREEMENT').map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const sides = ['SUPPORT', 'OPPOSE', 'MIXED'].flatMap((stance) => {
      const inStance = positions.filter((position) => position.stance === stance);
      return inStance.length
        ? [{ stance, providers: inStance.map((position) => disp(position.provider)), reasoning: inStance.map((position) => position.reasoning) }]
        : [];
    });
    const adjudication = rulingById.get(claim.id);
    return {
      id: claim.id,
      topic: claim.proposition,
      sides,
      ruling: rulingPhrase(adjudication?.ruling),
      reasoning: adjudication?.reasoning ?? null,
      status: (adjudication && adjudication.ruling !== 'UNRESOLVED' ? 'RESOLVED' : 'UNRESOLVED') as 'RESOLVED' | 'UNRESOLVED',
    };
  });

  const uniqueOppositions = graph.claims
    .filter((claim) => claim.state === 'UNIQUE')
    .flatMap((claim) => claim.position_ids.map((id) => positionById.get(id)!))
    .filter((position) => position.stance === 'OPPOSE')
    .map((position) => ({ provider: disp(position.provider), proposition: position.proposition }));

  const unresolvedDecisive = disagreements.some((d) => d.status === 'UNRESOLVED' && claimById.get(d.id)?.sensitivity === 'DECISIVE');
  const consensusType = disagreements.length === 0
    ? (claims.some((claim) => claim.ruling === 'UNRESOLVED') ? 'convergent_with_unresolved_claims' as const : 'unanimous' as const)
    : disagreements.every((d) => d.status === 'RESOLVED') ? 'majority_with_dissent' as const : 'contested' as const;

  const risks = graph.claims
    .filter((claim) => claim.load_bearing && claim.evidence_state !== 'SUPPORTED')
    .map((claim) => ({ risk: claim.proposition, severity: SEVERITY_MAP[claim.sensitivity] ?? 'Medium' }));

  const criticalWarning = graph.claims.find(
    (claim) => claim.load_bearing && claim.if_false === 'STOP' && claim.evidence_state !== 'SUPPORTED')?.proposition ?? null;

  const verificationResults = verifications.verifications.map((v) => ({
    claimId: v.target_id,
    claim: claimById.get(v.target_id)?.proposition ?? v.target_id,
    method: 'independent verifier model',
    verdict: (v.verdict === 'CONFIRM' ? 'CONFIRMED' : v.verdict === 'REFUTE' ? 'REFUTED' : 'UNCERTAIN') as 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN',
    evidence: v.evidence,
    note: v.note,
  }));

  const byProvider: Record<string, number> = {};
  let modelTimeMs = 0;
  for (const call of ctx.calls) {
    byProvider[call.provider] = (byProvider[call.provider] ?? 0) + 1;
    modelTimeMs += call.durationMs;
  }

  const roles = ctx.roles;
  const models = ctx.available().map((provider) => ({
    provider,
    name: disp(provider),
    roles: [
      ...(roles.analyst === provider ? ['analyst'] : []),
      ...(roles.judge === provider ? ['judge'] : []),
      ...(roles.verifier === provider ? ['verifier'] : []),
      ...(roles.s4.includes(provider) ? ['scout'] : []),
    ],
  }));

  const positions = seats.map((seat) => {
    const seatPositions = seat.output.positions;
    const oppose = seatPositions.filter((position) => position.stance === 'OPPOSE').length;
    const support = seatPositions.filter((position) => position.stance === 'SUPPORT').length;
    return {
      provider: seat.provider,
      name: disp(seat.provider),
      initialConclusion: seat.output.strongest_version,
      mainArgument: seatPositions.find((position) => position.load_bearing)?.reasoning ?? seatPositions[0]?.reasoning ?? '—',
      keyRisk: seatPositions.find((position) => position.stance === 'OPPOSE')?.proposition ?? '—',
      finalPosition: (oppose > support ? 'Oppose' : oppose > 0 || status === 'ACCEPTED_WITH_CONDITIONS' ? 'Conditional' : 'Support') as 'Support' | 'Oppose' | 'Conditional',
    };
  });

  return {
    reportId: ctx.runId,
    generatedAt: new Date().toISOString(),
    task: {
      original: args.original ?? contract.task,
      normalized: contract.task,
      type: contract.task_type,
      constraints: contract.constraints,
      successCriteria: contract.success_criteria,
    },
    verdict: {
      status,
      summary: judgeReport.verdict,
      confidence: confidence.score / 100,
      confidenceLabel: confidence.label,
      consensusType,
      conditions: judgeReport.conditions ?? [],
      primaryReason: judgeReport.key_points?.[0] ?? judgeReport.verdict,
      criticalWarning,
    },
    confidenceBreakdown: confidence,
    models,
    positions,
    claims,
    consensusSummary: {
      unanimous: graph.claims.filter((claim) => claim.state === 'CONSENSUS').length,
      accepted: claims.filter((claim) => claim.ruling === 'ACCEPTED').length,
      conditional: claims.filter((claim) => claim.ruling === 'CONDITIONAL').length,
      unresolved: claims.filter((claim) => claim.ruling === 'UNRESOLVED').length,
      rejected: claims.filter((claim) => claim.ruling === 'REJECTED').length,
    },
    disagreements,
    minority: {
      dissent: judgeReport.dissent,
      uniqueOppositions,
      blocksDecision: unresolvedDecisive ? 'YES' : (judgeReport.conditions?.length ? 'ONLY_IF_CONDITION' : 'NO'),
    },
    verification: {
      results: verificationResults,
      confirmed: verificationResults.filter((result) => result.verdict === 'CONFIRMED').length,
      refuted: verificationResults.filter((result) => result.verdict === 'REFUTED').length,
      uncertain: verificationResults.filter((result) => result.verdict === 'UNCERTAIN').length,
    },
    risks,
    recommendedActions: actionPlan && !('kind' in actionPlan)
      ? actionPlan.actions.map((action) => ({ order: action.order, action: action.action, why: action.why, effort: action.effort, killSignal: action.kill_signal }))
      : [],
    openQuestions: mergeOpenQuestions(seats),
    flags: [...ctx.flags],
    receipt: { calls: ctx.calls.length, budget: ctx.budget.limit, byProvider, modelTimeMs },
  };
}

function receiptLines(ctx: RunCtx): string[] {
  const byProvider = new Map<ProviderId, number>();
  let ms = 0;
  for (const c of ctx.calls) {
    byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
    ms += c.durationMs;
  }
  const providerCounts = [...byProvider.entries()].map(([p, n]) => `${disp(p)} ${n}`).join(', ') || 'none';
  return [
    `- Calls: ${ctx.calls.length}/${ctx.budget.limit}`,
    `- By provider: ${providerCounts}`,
    `- Recorded model time: ${(ms / 1000).toFixed(1)}s`,
  ];
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Level-2 report: the 12-section Multi-Model Decision Report markdown, rendered from the same
 *  machine-readable object (level 3) so the two can never disagree. */
export function renderReport(ctx: RunCtx, args: S10Args): string {
  const report = buildDecisionReport(ctx, args);
  const { seats, graph, judgeReport, actionPlan } = args;
  const scorecard = args.rubric ? deriveScorecard(args.rubric, graph) : [];
  const L: string[] = [];

  L.push('# Multi-Model Decision Report', '');

  // 1 ────────────────────────────────────────────────────────────────────────
  L.push('## 1. Report Metadata', '');
  L.push(`- Report ID: ${report.reportId}`);
  L.push(`- Generated at: ${report.generatedAt}`);
  L.push(`- User task: ${mdCell(report.task.original)}`);
  L.push(`- Workflow: ${report.task.type}`);
  L.push('- Models used:');
  for (const model of report.models) L.push(`  - ${model.name} — ${model.roles.join(', ') || 'scout'}`);
  L.push('- Debate protocol: independent analysis → anonymized cross-examination → verification → adjudication');
  L.push(`- Provider calls: ${report.receipt.calls}/${report.receipt.budget} · recorded model time ${(report.receipt.modelTimeMs / 1000).toFixed(1)}s`);
  L.push(`- Final status: ${report.verdict.status}`);
  if (report.flags.length) L.push(`- ⚠ Degradation flags: ${report.flags.join(', ')}`);
  L.push('');

  // 2 ────────────────────────────────────────────────────────────────────────
  L.push('## 2. Executive Verdict', '');
  L.push('### Final conclusion', '', report.verdict.summary, '');
  L.push('### Decision status', '', report.verdict.status, '');
  if (report.verdict.conditions.length) {
    L.push('Conditions:');
    for (const condition of report.verdict.conditions) L.push(`- ${condition}`);
    L.push('');
  }
  const c = report.confidenceBreakdown;
  L.push('### Confidence', '', `**Confidence: ${c.score}/100 — ${c.label.toUpperCase()}**`, '');
  L.push('Confidence is structural (never model self-confidence), based on:');
  L.push(`- Verification coverage of load-bearing claims: ${pct(c.verificationCoverage)} (weight 40)`);
  L.push(`- Independent convergence: ${pct(c.independentConvergence)} (weight 25)`);
  L.push(`- Evidence quality beyond model memory: ${pct(c.evidenceQuality)} (weight 20)`);
  L.push(`- Result stability: ${pct(c.stability)} (weight 15)`);
  L.push(`- Critical-risk penalty: −${c.criticalRiskPenalty}`);
  L.push('', '> Heuristic, not a calibrated probability. Consensus alone never yields HIGH.', '');
  L.push('### Most important reason', '', report.verdict.primaryReason, '');
  L.push('### Critical warning', '', report.verdict.criticalWarning ?? 'None identified.', '');

  // 3 ────────────────────────────────────────────────────────────────────────
  L.push('## 3. Problem Interpretation', '');
  L.push('### Original request', '', `> ${report.task.original.replaceAll('\n', '\n> ')}`, '');
  L.push('### Normalized question', '', report.task.normalized, '');
  if (report.task.successCriteria.length) {
    L.push('### Expected deliverable', '');
    for (const item of report.task.successCriteria) L.push(`- ${item}`);
    L.push('');
  }
  if (report.task.constraints.length) {
    L.push('### Constraints', '');
    for (const item of report.task.constraints) L.push(`- ${item}`);
    L.push('');
  }
  const assumptions = seats.flatMap((seat) => seat.output.positions.filter((position) => position.basis === 'ASSUMPTION')
    .map((position) => ({ seat: disp(seat.provider), position })));
  if (assumptions.length) {
    L.push('### Assumptions', '', '| # | Assumption | Source | Impact if incorrect |', '|---|---|---|---|');
    assumptions.forEach(({ seat, position }, index) => {
      const impact = position.if_false === 'STOP' ? 'High' : position.if_false === 'MINOR' ? 'Low' : 'Medium';
      L.push(`| A${index + 1} | ${mdCell(position.proposition)} | ${seat} | ${impact} |`);
    });
    L.push('');
  }

  // 4 ────────────────────────────────────────────────────────────────────────
  L.push('## 4. Individual Model Positions', '');
  L.push('| Model | Initial conclusion | Main argument | Key risk identified | Final position |', '|---|---|---|---|---|');
  for (const position of report.positions) {
    L.push(`| ${position.name} | ${mdCell(position.initialConclusion)} | ${mdCell(position.mainArgument)} | ${mdCell(position.keyRisk)} | ${position.finalPosition} |`);
  }
  L.push('', '_Positions were produced blind (no seat saw another) and anonymized during adjudication._', '');

  // 5 ────────────────────────────────────────────────────────────────────────
  const providers = report.models.map((model) => model.provider);
  L.push('## 5. Consensus Map', '');
  L.push('Legend: AGREE · DISAGREE · CONDITIONAL · UNKNOWN (model did not address the claim)', '');
  L.push(`| Claim | ${providers.map(disp).join(' | ')} | Verification | Final ruling |`, `|---|${providers.map(() => '---|').join('')}---|---|`);
  for (const claim of report.claims) {
    const stanceCells = providers.map((provider) => claim.stances[provider] ?? 'UNKNOWN');
    L.push(`| ${claim.id}: ${mdCell(claim.text)} | ${stanceCells.join(' | ')} | ${claim.verification} | ${claim.ruling} |`);
  }
  const summary = report.consensusSummary;
  L.push('', '### Consensus summary', '');
  L.push(`- Unanimous claims: ${summary.unanimous}`);
  L.push(`- Accepted claims: ${summary.accepted}`);
  L.push(`- Conditional claims: ${summary.conditional}`);
  L.push(`- Unresolved claims: ${summary.unresolved}`);
  L.push(`- Rejected claims: ${summary.rejected}`);
  L.push('');
  if (scorecard.length) {
    L.push('### Dimension coverage', '', '| Dimension | Status |', '|---|---|');
    for (const row of scorecard) L.push(`| ${mdCell(row.label)} | ${row.status} |`);
    L.push('');
  }

  // 6 ────────────────────────────────────────────────────────────────────────
  L.push('## 6. Key Agreements', '');
  const agreements = report.claims.filter((claim) => {
    const state = graph.claims.find((item) => item.id === claim.id)?.state;
    return state === 'CONSENSUS' || state === 'SHARED_CONCERN';
  });
  if (agreements.length === 0) L.push('No multi-model agreements were reached.', '');
  agreements.slice(0, 6).forEach((claim, index) => {
    L.push(`### Agreement ${index + 1}: ${mdCell(claim.text)}`, '');
    L.push(`- Models: ${Object.keys(claim.stances).map((provider) => disp(provider as ProviderId)).join(', ')}`);
    L.push(`- Verification: ${claim.verification} · Sensitivity: ${claim.sensitivity} · Ruling: ${claim.ruling}`);
    L.push('');
  });

  // 7 ────────────────────────────────────────────────────────────────────────
  L.push('## 7. Key Disagreements', '');
  if (report.disagreements.length === 0) L.push('No genuine cross-model disagreements survived claim grouping.', '');
  report.disagreements.forEach((disagreement, index) => {
    L.push(`### Disagreement ${index + 1}: ${mdCell(disagreement.topic)}`, '');
    for (const side of disagreement.sides) {
      L.push(`#### ${side.stance} — ${side.providers.join(', ')}`, '');
      for (const reason of side.reasoning) L.push(`- ${reason}`);
      L.push('');
    }
    L.push(`#### Adjudicator ruling`, '', `${disagreement.ruling}${disagreement.reasoning ? ` — ${disagreement.reasoning}` : ''}`, '');
    L.push(`#### Resolution status`, '', disagreement.status, '');
  });

  // 8 ────────────────────────────────────────────────────────────────────────
  L.push('## 8. Minority Report', '');
  L.push('### Preserved dissent', '');
  for (const dissent of report.minority.dissent) L.push(`- ${dissent}`);
  L.push('');
  if (report.minority.uniqueOppositions.length) {
    L.push('### Unique objections (single model)', '');
    for (const objection of report.minority.uniqueOppositions) L.push(`- **${objection.provider}:** ${objection.proposition}`);
    L.push('');
  }
  L.push('### Should this dissent block the decision?', '', report.minority.blocksDecision, '');
  L.push(`_${judgeReport.confidence_notes}_`, '');

  // 9 ────────────────────────────────────────────────────────────────────────
  L.push('## 9. Verification Results', '');
  if (report.verification.results.length) {
    L.push('| Claim tested | Method | Result | Evidence |', '|---|---|---|---|');
    for (const result of report.verification.results) {
      L.push(`| ${mdCell(result.claim)} | ${result.method} | ${result.verdict} | ${mdCell(result.evidence)} |`);
    }
    L.push('', `Summary: ${report.verification.confirmed} confirmed · ${report.verification.refuted} refuted · ${report.verification.uncertain} uncertain`, '');
  } else {
    L.push('No claims escalated to the independent verifier in this run.', '');
  }
  if (graph.holes.evidence.length) {
    L.push('### Unverifiable claims', '');
    for (const hole of graph.holes.evidence) {
      const claim = graph.claims.find((item) => item.id === hole.claim_id);
      L.push(`- ${claim?.proposition ?? hole.claim_id} — ${hole.reason}`);
    }
    L.push('');
  }

  // 10 ───────────────────────────────────────────────────────────────────────
  L.push('## 10. Final Synthesis', '');
  L.push('### Recommended answer', '', report.verdict.summary, '');
  if (judgeReport.key_points?.length) {
    L.push('### Why this answer was selected', '');
    if (report.flags.includes('synthesis_suspect')) {
      L.push('> ⚠ synthesis_suspect — the chair output required deterministic repair or degradation handling.', '');
    }
    judgeReport.key_points.forEach((point, index) => L.push(`${index + 1}. ${point}`));
    L.push('');
  } else if (report.flags.includes('synthesis_suspect')) {
    L.push('### Why this answer was selected', '', '> ⚠ synthesis_suspect — no reliable chairman reasoning was produced.', '');
  }
  L.push('### Strongest version per model (alternatives considered)', '');
  for (const position of report.positions) L.push(`- **${position.name}:** ${position.initialConclusion}`);
  L.push('');
  if (report.recommendedActions.length) {
    L.push('### Implementation / next steps', '', '| # | Action | Why | Effort | Kill signal |', '|---|---|---|---|---|');
    for (const action of report.recommendedActions) {
      L.push(`| ${action.order} | ${mdCell(action.action)} | ${mdCell(action.why)} | ${action.effort} | ${mdCell(action.killSignal)} |`);
    }
    if (actionPlan && !('kind' in actionPlan)) L.push('', actionPlan.sequencing_note);
    L.push('');
  } else if (actionPlan && 'kind' in actionPlan) {
    const planFlags = report.flags.filter((flag) => flag === 'plan_fallback' || flag === 'plan_skipped');
    L.push(`> ⚠ Planner unavailable: ${actionPlan.reason}${planFlags.length ? ` (${planFlags.join(', ')})` : ''}. Unresolved questions:`, '');
    for (const question of actionPlan.unresolved_questions) L.push(`- ${question}`);
    L.push('');
  }

  // 11 ───────────────────────────────────────────────────────────────────────
  L.push('## 11. Risks and Unresolved Questions', '');
  if (report.risks.length) {
    L.push('| Risk | Severity |', '|---|---|');
    for (const risk of report.risks) L.push(`| ${mdCell(risk.risk)} | ${risk.severity} |`);
    L.push('');
  } else {
    L.push('No unsupported load-bearing risks remain.', '');
  }
  if (report.openQuestions.length) {
    L.push('### Information still required', '');
    for (const question of report.openQuestions) L.push(`- ${question}`);
    L.push('');
  }
  if (graph.holes.coverage.length) {
    L.push('### Dimensions never examined', '');
    for (const hole of graph.holes.coverage) L.push(`- ${hole.label}`);
    L.push('');
  }

  // 12 ───────────────────────────────────────────────────────────────────────
  L.push('## 12. Audit Information', '');
  L.push('### Agent activity', '', '| Model | Roles | Calls |', '|---|---|---|');
  for (const model of report.models) {
    L.push(`| ${model.name} | ${model.roles.join(', ') || 'scout'} | ${report.receipt.byProvider[model.provider] ?? 0} |`);
  }
  L.push('');
  L.push('### Report-generation policy', '');
  L.push('- Initial answers were generated independently — no seat saw another before claim extraction.');
  L.push('- Provider identities were hidden during verification and adjudication.');
  L.push('- Claims were judged individually, never by whole-answer voting.');
  L.push('- Verified evidence had priority over model confidence.');
  L.push('- Meaningful minority opinions were preserved above.');
  L.push('');
  L.push('### Raw artifacts', '', ...receiptLines(ctx));
  L.push(`- Run directory: ${'writer' in ctx && ctx.writer ? ctx.writer.dir : '.aiki/runs/' + ctx.runId}`);
  L.push('');

  return L.join('\n');
}

// ── Terminal summary (level 1) ───────────────────────────────────────────────

const RULE = '─'.repeat(52);

export function renderTerminalSummary(report: DecisionReportJson, paths: { markdownPath: string; jsonPath: string }): string {
  const summary = report.consensusSummary;
  const c = report.confidenceBreakdown;
  const checks: string[] = [
    `[${c.verificationCoverage >= 0.5 ? 'PASS' : 'WARN'}] Verification coverage ${pct(c.verificationCoverage)} of load-bearing claims`,
    `[PASS] Minority opinion preserved (${report.minority.dissent.length} dissent item(s))`,
    `[${report.verification.refuted === 0 ? 'PASS' : 'WARN'}] Verifier refutations: ${report.verification.refuted}`,
    ...(report.flags.length ? [`[WARN] Degradation flags: ${report.flags.join(', ')}`] : []),
    '[WARN] Confidence score is heuristic — not yet benchmark-calibrated',
  ];
  return [
    'MULTI-MODEL DECISION REPORT',
    RULE,
    `Verdict: ${report.verdict.summary}`,
    `Status: ${report.verdict.status}`,
    `Confidence: ${c.score}/100 (${c.label})`,
    `Consensus: ${report.verdict.consensusType.replaceAll('_', ' ')} — ${summary.accepted} accepted · ${summary.rejected} rejected · ${summary.unresolved} unresolved`,
    '',
    'Primary reason:',
    report.verdict.primaryReason,
    '',
    ...(report.verdict.criticalWarning ? ['Critical warning:', report.verdict.criticalWarning, ''] : []),
    ...(report.minority.dissent[0] ? ['Critical dissent:', report.minority.dissent[0], ''] : []),
    'Verification:',
    ...checks,
    '',
    ...(report.recommendedActions[0] ? ['Recommended action:', report.recommendedActions[0].action, ''] : []),
    `Full report: ${paths.markdownPath}`,
    `Audit JSON:  ${paths.jsonPath}`,
  ].join('\n');
}

export async function s10Render(ctx: RunCtx, args: S10Args): Promise<void> {
  await ctx.writer.writeJson('decision-report', buildDecisionReport(ctx, args));
  await ctx.writer.writeText('final-report', renderReport(ctx, args));
}
