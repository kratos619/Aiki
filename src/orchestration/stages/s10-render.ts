// S10 — artifact rendering (§9, §12.1, §307). Pure code → `final-report.md`, a DECISION BRIEF, not a
// smoothed essay (§263). Every section is assembled deterministically from prior artifacts; audit,
// sensitivity, coverage, contribution, and confidence are DERIVED here rather than invented by the judge.
// A truly missing required field is a template bug (fail loudly); degraded-but-valid
// states (S8 skipped, items UNVERIFIED, empty consensus) render normally. User-facing → DISPLAY_NAME.

import { ReaderBrief as ReaderBriefSchema, readerBriefIssues, type ActionPlanArtifact, type ClaimVerificationSet, type FeatureBacklog, type IdeaMode, type ImplementationPlan, type IntentContract, type JudgeReport, type ReaderBrief, type RebuttalEventSet, type RequestedOutput, type VerificationSet } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';
import type { RubricItem } from './s7-decision-graph.js';
import { interpretClaimOutcome, type DecisionGraph } from '../decision-graph.js';
import { evidenceOrigin } from '../evidence-origin.js';
import { buildReaderProjection, renderDecisionDossierMarkdown, sanitizeReaderText } from '../decision-dossier.js';
import { callCategory } from '../modes.js';

export interface AuditRow {
  id: string;
  statement: string;
  providers: ProviderId[];
  status: 'held' | 'failed' | 'unverified';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Pure graph-backed decision audit. */
export function deriveAudit(graph: DecisionGraph, judgeReport: JudgeReport): AuditRow[] {
  const ruling = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));

  return graph.claims.map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const providers = [...new Set(positions.map((position) => position.provider))];
    const outcome = interpretClaimOutcome(graph, claim, ruling.get(claim.id));
    const status = outcome.decisionEffect === 'HELD' ? 'held'
      : outcome.decisionEffect === 'FAILED' ? 'failed' : 'unverified';
    const confidence: AuditRow['confidence'] = status === 'unverified' ? 'LOW'
      : claim.state === 'DISAGREEMENT' ? 'MEDIUM'
        : providers.length >= 2 ? 'HIGH' : 'MEDIUM';
    return { id: claim.id, statement: claim.proposition, providers, status, confidence };
  });
}

const disp = (id: ProviderId): string => DISPLAY_NAME[id];

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
  verifications: ClaimVerificationSet | VerificationSet;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlanArtifact;
  rebuttals?: RebuttalEventSet;
  rubric?: RubricItem[];
  original?: string; // raw user input; contract.task (normalized) is the fallback
}

function receiptCategories(ctx: RunCtx): { discovery: number; verification: number; repair: number; planning: number } {
  if (typeof ctx.receipt === 'function') return ctx.receipt();
  const categories = { discovery: 0, verification: 0, repair: 0, planning: 0 };
  for (const call of ctx.calls) categories[call.category ?? callCategory(call.stage)]++;
  return categories;
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
  verificationScope?: 'FACTUAL'; // absent preserves legacy/all-load-bearing semantics
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
  const factual = loadBearing.filter((claim) => claim.nature === 'FACTUAL');
  const verificationClaims = factual.length ? factual : loadBearing;
  const verificationCoverage = verificationClaims.length
    ? verificationClaims.filter((claim) => claim.evidence_state === 'SUPPORTED').length / verificationClaims.length : 0;
  const independentConvergence = graph.claims.length
    ? graph.claims.filter((claim) => claim.state === 'CONSENSUS' || claim.state === 'SHARED_CONCERN').length / graph.claims.length : 0;
  // v6: only independent EXTERNAL evidence counts as quality — the user's own material restated
  // as cards inflated f740's coverage to theater (8 of 12 cards were the user's idea-brief).
  const evidenceQuality = graph.evidence.length
    ? graph.evidence.filter((card) => evidenceOrigin(card) === 'EXTERNAL').length / graph.evidence.length : 0;
  const stability = Math.max(0, 1 - 0.25 * DEGRADATION_FLAGS.filter((flag) => flags.has(flag)).length);
  const criticalRiskPenalty = Math.min(20, 5 * loadBearing.filter(
    (claim) => claim.if_false === 'STOP' && claim.evidence_state !== 'SUPPORTED').length);
  let score = Math.round(verificationCoverage * 40 + independentConvergence * 25 + evidenceQuality * 20 + stability * 15 - criticalRiskPenalty);
  if (verificationCoverage < 0.5) score = Math.min(score, 79); // consensus alone never yields High
  score = Math.max(0, Math.min(100, score));
  const label = score >= 80 ? 'High' : score >= 60 ? 'Medium' : 'Low';
  return {
    score,
    label,
    verificationCoverage,
    ...(factual.length ? { verificationScope: 'FACTUAL' as const } : {}),
    independentConvergence,
    evidenceQuality,
    stability,
    criticalRiskPenalty,
  };
}

// ── Machine-readable report (level 3) ───────────────────────────────────────

type MapStance = 'AGREE' | 'DISAGREE' | 'CONDITIONAL' | 'UNKNOWN';
type ClaimRuling = 'ACCEPTED' | 'REJECTED' | 'CONDITIONAL' | 'UNRESOLVED';

export interface DecisionDossier {
  recommendation: {
    status: ReportStatus;
    summary: string;
    reason: string;
    claimIds: string[];
    conditions: Array<{ text: string; claimIds: string[] }>;
  };
  claimChain: Array<{ claimId: string; text: string; ruling: ClaimRuling; evidenceStatus: string; dependsOn: string[] }>;
  evidence: Array<{ id: string; source: string; sourceKind: string; title?: string; url?: string; date: string; freshness: string; verificationStatus: string; claimIds: string[] }>;
  positionChanges: Array<{ eventId: string; claimId: string; responder: ProviderId; response: string; reasoning: string; evidenceIds: string[]; narrowedProposition?: string }>;
  sharedConcerns: Array<{ claimId: string; text: string; providerIds: ProviderId[]; evidenceStatus: string }>;
  uniqueSupportedInsights: Array<{ claimId: string; text: string; providerId: ProviderId; verificationStatus: string }>;
  coverage: Array<{ dimensionId: string; label: string; status: 'COVERED' | 'NOT_APPLICABLE' | 'MISSING' | 'MISSING_EVIDENCE'; claimIds: string[] }>;
  sensitivity: Array<{ claimId: string; fact: string; sensitivity: string; impactIfFalse: string; whatWouldChangeIt: string; linkedClaimIds: string[] }>;
  experiments: {
    status: 'AVAILABLE' | 'DEGRADED';
    note: string;
    actions: Array<{ order: number; action: string; why: string; validates: string; effort: string; killSignal: string }>;
  };
  featureBacklog?: FeatureBacklog;
  implementationPlan?: ImplementationPlan;
  readerBrief?: ReaderBrief;
  missingRequestedOutputs: Array<'FEATURE_BACKLOG' | 'IMPLEMENTATION_PLAN'>;
  counterCase: { available: boolean; reasoning: string; claimIds: string[] };
  contributions: Array<{ provider: ProviderId; name: string; verifiedUniqueClaimIds: string[] }>;
  seatStats?: Array<{ provider: string; positions: number; evidenced: number; survivedIntoDecision: number }>;
  technical: {
    submissions: Array<{ provider: ProviderId; name: string; strongestVersion: string; positionIds: string[] }>;
    positions: Array<{ id: string; provider: ProviderId; stance: string; proposition: string; evidenceIds: string[] }>;
    edges: DecisionGraph['edges'];
    events: DecisionDossier['positionChanges'];
  };
}

export interface DecisionReportJson {
  reportId: string;
  generatedAt: string;
  mode: IdeaMode;
  task: { original: string; normalized: string; type: string; constraints: string[]; successCriteria: string[]; confirmation?: string };
  verdict: {
    status: ReportStatus;
    summary: string;
    confidence: number; // 0–1
    confidenceLabel: 'High' | 'Medium' | 'Low';
    consensusType: 'single_analyst' | 'unanimous' | 'convergent_with_unresolved_claims' | 'majority_with_dissent' | 'contested';
    conditions: string[];
    primaryReason: string;
    criticalWarning: string | null;
  };
  /** Reader-first findings from the chair, ordered most decision-relevant first. */
  keyFindings: string[];
  /** Highest-priority unanswered questions; a short subset of the full open-question ledger. */
  criticalUnknowns: string[];
  /** Optional graph-anchored numeric summary for financial or threshold-heavy decisions. */
  decisionSnapshot?: {
    decisiveNumbers: Array<{ label: string; value: string; meaning: string; claimIds: string[] }>;
    payback?: { status: 'ACHIEVED' | 'NOT_ACHIEVED' | 'NOT_COMPUTABLE'; result: string; basis: string; claimIds: string[] };
    options: Array<{ label: string; commitment: string; commitmentKind: 'KNOWN' | 'TARGET_CAP' | 'UNKNOWN'; tradeoff: string; claimIds: string[] }>;
    tripwire?: { metric: string; threshold: string; decisionRule: string; claimIds: string[] };
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
  receipt: {
    calls: number;
    budget: number;
    byProvider: Record<string, number>;
    modelTimeMs: number;
    categories: { discovery: number; verification: number; repair: number; planning: number };
  };
  dossier: DecisionDossier;
}

const STANCE_MAP: Record<string, MapStance> = { SUPPORT: 'AGREE', OPPOSE: 'DISAGREE', MIXED: 'CONDITIONAL', UNKNOWN: 'UNKNOWN' };
const VERIFICATION_MAP = { SUPPORTED: 'VERIFIED', CONFLICTED: 'PARTIAL', UNVERIFIED: 'UNVERIFIED' } as const;
const SEVERITY_MAP: Record<string, 'High' | 'Medium' | 'Low'> = { DECISIVE: 'High', MATERIAL: 'Medium', LOW: 'Low' };

function claimRuling(
  graph: DecisionGraph,
  claim: DecisionGraph['claims'][number],
  adjudication?: JudgeReport['adjudications'][number],
): ClaimRuling {
  const truth = interpretClaimOutcome(graph, claim, adjudication).propositionTruth;
  return truth === 'HOLDS' ? 'ACCEPTED' : truth === 'FAILS' ? 'REJECTED' : 'UNRESOLVED';
}

function fallbackReaderBrief(args: {
  graph: DecisionGraph;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlanArtifact;
  openQuestions: string[];
  missingRequestedOutputs: Array<'FEATURE_BACKLOG' | 'IMPLEMENTATION_PLAN'>;
  flags: ReadonlySet<string>;
}): ReaderBrief {
  const labelFor = (id: string) => args.graph.claims.find((claim) => claim.id === id)?.proposition ?? null;
  const clean = (value: string, max: number) => {
    const text = sanitizeReaderText(value, labelFor);
    if (text.length <= max) return text;
    const clipped = text.slice(0, max - 1);
    const boundary = clipped.lastIndexOf(' ');
    return `${clipped.slice(0, boundary > max * 0.6 ? boundary : max - 1).trimEnd()}…`;
  };
  const keyPoints = args.judgeReport.key_points ?? [];
  const missing = args.missingRequestedOutputs.length
    ? `Requested deliverables unavailable: ${args.missingRequestedOutputs.join(', ')}.`
    : 'No additional requested deliverable was synthesized.';
  const firstAction = args.actionPlan && !('kind' in args.actionPlan) ? args.actionPlan.actions[0]?.action : undefined;
  const nextStep = firstAction
    ?? args.openQuestions[0]
    ?? args.judgeReport.strongest_counter_case?.reasoning
    ?? 'Review the unresolved decision evidence before committing.';
  const adjudicationById = new Map(args.judgeReport.adjudications.map((item) => [item.id, item]));
  const acceptedClaims = new Set(args.graph.claims
    .filter((claim) => claim.evidence_state === 'SUPPORTED'
      && interpretClaimOutcome(args.graph, claim, adjudicationById.get(claim.id)).propositionTruth === 'HOLDS')
    .map((claim) => claim.id));
  const sourceIds = args.graph.evidence
    .filter((evidence) => {
      if (evidence.source_kind !== 'PRIMARY' && evidence.source_kind !== 'SECONDARY') return false;
      try {
        const url = new URL(evidence.url ?? '');
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      } catch {
        return false;
      }
      return args.graph.edges.some((edge) => edge.from === evidence.id && edge.type === 'SUPPORTS' && acceptedClaims.has(edge.to));
    })
    .map((evidence) => evidence.id)
    .slice(0, 8);
  const raw = {
    headline: clean(args.judgeReport.verdict, 160),
    bottom_line: clean(args.judgeReport.verdict, 1200),
    sections: [
      {
        heading: 'Why',
        summary: clean(keyPoints[0] ?? args.judgeReport.verdict, 1000),
        bullets: [...keyPoints.slice(1, 3), ...(args.judgeReport.conditions ?? []).slice(0, 2)].map((item) => clean(item, 500)),
      },
      {
        heading: 'What remains',
        summary: missing,
        bullets: [args.openQuestions[0], args.judgeReport.strongest_counter_case?.reasoning]
          .filter((item): item is string => Boolean(item)).map((item) => clean(item, 500)),
      },
    ],
    next_step: clean(nextStep, 600),
    caveats: [
      ...(args.missingRequestedOutputs.length ? [missing] : []),
      ...(args.flags.has('plan_skipped') || args.flags.has('plan_fallback')
        ? ['The requested synthesis was unavailable; this concise summary uses the recorded chair decision only.'] : []),
    ],
    source_ids: sourceIds,
  };
  const brief = ReaderBriefSchema.parse(raw);
  const issues = readerBriefIssues(brief, args.graph.claims.map((claim) => claim.id));
  if (issues.length) throw new Error(`fallback reader brief leaked graph ids: ${issues.join(', ')}`);
  return brief;
}

function verificationStatusByClaim(verifications: ClaimVerificationSet | VerificationSet): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const item of verifications.verifications) {
    if ('claim_id' in item) statuses.set(item.claim_id, item.status);
    else statuses.set(item.target_id, item.verdict === 'CONFIRM' ? 'VERIFIED' : item.verdict === 'REFUTE' ? 'CONTRADICTED' : 'PARTIAL');
  }
  return statuses;
}

function buildDossier(args: {
  status: ReportStatus;
  summary: string;
  reason: string;
  claims: DecisionReportJson['claims'];
  models: DecisionReportJson['models'];
  seats: SeatOutput[];
  graph: DecisionGraph;
  verifications: ClaimVerificationSet | VerificationSet;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlanArtifact;
  rebuttals?: RebuttalEventSet;
  rubric: RubricItem[];
  requestedOutputs: RequestedOutput[];
  newDecisionContract: boolean;
  flags: ReadonlySet<string>;
}): DecisionDossier {
  const { graph, judgeReport, actionPlan, rebuttals, seats } = args;
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const reportClaimById = new Map(args.claims.map((claim) => [claim.id, claim]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const verificationById = verificationStatusByClaim(args.verifications);
  const verifiedClaimIds = new Set([...verificationById].filter(([, status]) => status === 'VERIFIED').map(([id]) => id));

  const dependencies = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type !== 'DEPENDS_ON' || !claimById.has(edge.from) || !claimById.has(edge.to)) continue;
    const ids = dependencies.get(edge.from) ?? [];
    if (!ids.includes(edge.to)) ids.push(edge.to);
    dependencies.set(edge.from, ids);
  }
  const recommendationIds = (judgeReport.recommendation_claim_ids ?? [])
    .filter((id) => claimById.has(id));
  const recommendationPositionIds = new Set(recommendationIds.flatMap((id) => claimById.get(id)?.position_ids ?? []));
  const seatStats = [...graph.positions.reduce((stats, position) => {
    const provider = position.id.split('/')[0]!.replace(/-coverage-fill$/, '');
    const entry = stats.get(provider) ?? { provider, positions: 0, evidenced: 0, survivedIntoDecision: 0 };
    entry.positions += 1;
    if (position.evidence_ids.length) entry.evidenced += 1;
    if (recommendationPositionIds.has(position.id)) entry.survivedIntoDecision += 1;
    stats.set(provider, entry);
    return stats;
  }, new Map<string, NonNullable<DecisionDossier['seatStats']>[number]>()).values()];
  const anchors = recommendationIds.length
    ? recommendationIds
    : graph.claims.filter((claim) => claim.load_bearing).slice(0, 8).map((claim) => claim.id);
  const chainIds: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    chainIds.push(id);
  };
  anchors.forEach(visit);
  const claimChain = chainIds.flatMap((id) => {
    const claim = reportClaimById.get(id);
    return claim ? [{
      claimId: id,
      text: claim.text,
      ruling: claim.ruling,
      evidenceStatus: verificationById.get(id) ?? claim.verification,
      dependsOn: dependencies.get(id) ?? [],
    }] : [];
  });

  const evidence = graph.evidence.map((item) => {
    const claimIds = graph.edges
      .filter((edge) => edge.from === item.id && (edge.type === 'SUPPORTS' || edge.type === 'ATTACKS') && claimById.has(edge.to))
      .map((edge) => edge.to);
    const statuses = claimIds.map((id) => verificationById.get(id)).filter((status): status is string => Boolean(status));
    const verificationStatus = statuses.includes('CONTRADICTED') ? 'CONTRADICTED'
      : statuses.length > 0 && statuses.every((status) => status === 'VERIFIED') ? 'VERIFIED'
        : statuses.includes('UNVERIFIABLE') ? 'UNVERIFIABLE'
          : statuses.length ? 'PARTIAL' : 'NOT_CHECKED';
    return {
      id: item.id,
      source: item.locator ?? (item.source_kind === 'MODEL_KNOWLEDGE' ? `${disp(item.provider)} model knowledge` : item.source_kind),
      sourceKind: item.source_kind,
      ...(item.title ? { title: item.title } : {}),
      ...(item.url ? { url: item.url } : {}),
      date: item.accessed_at ?? 'Not recorded',
      freshness: item.freshness,
      verificationStatus,
      claimIds,
    };
  });

  const positionChanges = (rebuttals?.events ?? []).map((event) => ({
    eventId: event.id,
    claimId: event.claim_id,
    responder: event.responder,
    response: event.response,
    reasoning: event.reasoning,
    evidenceIds: event.evidence_ids,
    ...(event.narrowed_proposition ? { narrowedProposition: event.narrowed_proposition } : {}),
  }));

  const claimProviders = (claimId: string): ProviderId[] => {
    const claim = claimById.get(claimId);
    if (!claim) return [];
    return [...new Set(claim.position_ids.map((id) => positionById.get(id)!.provider))];
  };
  const sharedConcerns = graph.claims.filter((claim) => claim.state === 'SHARED_CONCERN').map((claim) => ({
    claimId: claim.id,
    text: claim.proposition,
    providerIds: claimProviders(claim.id),
    evidenceStatus: verificationById.get(claim.id) ?? VERIFICATION_MAP[claim.evidence_state],
  }));
  const uniqueSupportedInsights = graph.claims.filter((claim) => claim.state === 'UNIQUE' && claim.evidence_state === 'SUPPORTED').flatMap((claim) => {
    const providerId = claimProviders(claim.id)[0];
    return providerId ? [{
      claimId: claim.id,
      text: claim.proposition,
      providerId,
      verificationStatus: verificationById.get(claim.id) ?? 'NOT_CHECKED',
    }] : [];
  });

  const claimByPosition = new Map(graph.claims.flatMap((claim) => claim.position_ids.map((id) => [id, claim.id] as const)));
  const missingCoverage = new Set(graph.holes.coverage.map((hole) => hole.dimension_id));
  const missingEvidence = new Set(graph.holes.evidence.map((hole) => hole.claim_id));
  const coverage = args.rubric.map((dimension) => {
    const claimIds = [...new Set(graph.positions
      .filter((position) => position.dimension_id === dimension.id)
      .map((position) => claimByPosition.get(position.id))
      .filter((id): id is string => Boolean(id)))];
    const notApplicable = seats.some((seat) =>
      seat.output.coverage.find((entry) => entry.dimension_id === dimension.id)?.status === 'NOT_APPLICABLE');
    const status: DecisionDossier['coverage'][number]['status'] = missingCoverage.has(dimension.id) ? 'MISSING'
      : claimIds.some((id) => missingEvidence.has(id)) ? 'MISSING_EVIDENCE'
        : notApplicable && claimIds.length === 0 ? 'NOT_APPLICABLE' : 'COVERED';
    return { dimensionId: dimension.id, label: dimension.label, status, claimIds };
  });

  const adjudicationById = new Map(judgeReport.adjudications.map((item) => [item.id, item]));
  const sensitivity = graph.claims
    .filter((claim) => claim.load_bearing && claim.sensitivity !== 'LOW')
    .sort((a, b) => (a.sensitivity === 'DECISIVE' ? 0 : 1) - (b.sensitivity === 'DECISIVE' ? 0 : 1))
    .map((claim) => {
      const related = graph.edges
        .filter((edge) => (edge.from === claim.id || edge.to === claim.id) && claimById.has(edge.from) && claimById.has(edge.to))
        .map((edge) => edge.from === claim.id ? edge.to : edge.from);
      const experiment = actionPlan && !('kind' in actionPlan)
        ? actionPlan.actions.find((action) => action.validates === claim.id) : undefined;
      const evidenceHole = graph.holes.evidence.find((hole) => hole.claim_id === claim.id);
      return {
        claimId: claim.id,
        fact: claim.proposition,
        sensitivity: claim.sensitivity,
        impactIfFalse: claim.if_false,
        whatWouldChangeIt: adjudicationById.get(claim.id)?.what_would_change_it
          ?? experiment?.kill_signal
          ?? evidenceHole?.reason
          ?? `Resolve the evidence status for ${claim.id}.`,
        linkedClaimIds: [...new Set(related)],
      };
    });

  const experiments: DecisionDossier['experiments'] = actionPlan && !('kind' in actionPlan) && actionPlan.actions.length > 0
    ? {
        status: 'AVAILABLE',
        note: actionPlan.sequencing_note,
        actions: actionPlan.actions.map((action) => ({
          order: action.order,
          action: action.action,
          why: action.why,
          validates: action.validates,
          effort: action.effort,
          killSignal: action.kill_signal,
        })),
      }
    : {
        status: 'DEGRADED',
        note: actionPlan && !('kind' in actionPlan)
          ? 'The answer is available, but no validation action survived anchor checks.'
          : actionPlan && 'kind' in actionPlan
            ? `Planner unavailable: ${actionPlan.reason}. Unresolved: ${actionPlan.unresolved_questions.join('; ')}`
            : 'No planner artifact was recorded.',
        actions: [],
      };
  const featureBacklog = actionPlan && !('kind' in actionPlan) ? actionPlan.feature_backlog : undefined;
  const implementationPlan = actionPlan && !('kind' in actionPlan) ? actionPlan.implementation_plan : undefined;
  const missingRequestedOutputs: DecisionDossier['missingRequestedOutputs'] = [
    ...(args.requestedOutputs.includes('FEATURE_BACKLOG') && !featureBacklog ? ['FEATURE_BACKLOG' as const] : []),
    ...(args.requestedOutputs.includes('IMPLEMENTATION_PLAN') && !implementationPlan ? ['IMPLEMENTATION_PLAN' as const] : []),
  ];
  const persistedReaderBrief = actionPlan && !('kind' in actionPlan) ? actionPlan.reader_brief : undefined;
  const readerBrief = persistedReaderBrief ?? (args.newDecisionContract ? fallbackReaderBrief({
    graph,
    judgeReport,
    actionPlan,
    openQuestions: mergeOpenQuestions(seats),
    missingRequestedOutputs,
    flags: args.flags,
  }) : undefined);

  const counter = judgeReport.strongest_counter_case;
  const contributions = args.models.map((model) => ({
    provider: model.provider,
    name: model.name,
    verifiedUniqueClaimIds: graph.claims
      .filter((claim) => claim.state === 'UNIQUE' && verifiedClaimIds.has(claim.id) && claimProviders(claim.id).includes(model.provider))
      .map((claim) => claim.id),
  }));
  const technicalPositions = graph.positions.map((position) => ({
    id: position.id,
    provider: position.provider,
    stance: position.stance,
    proposition: position.proposition,
    evidenceIds: graph.evidence
      .filter((evidence) => evidence.provider === position.provider
        && evidence.source_id === position.source_id
        && position.evidence_ids.some((id) => id === evidence.id || evidence.id.endsWith(`/${id}`)))
      .map((evidence) => evidence.id),
  }));

  return {
    recommendation: {
      status: args.status,
      summary: args.summary,
      reason: args.reason,
      claimIds: recommendationIds,
      conditions: (judgeReport.conditions ?? []).map((text) => ({
        text,
        claimIds: (judgeReport.condition_claim_ids ?? []).filter((id) => claimById.has(id)),
      })),
    },
    claimChain,
    evidence,
    positionChanges,
    sharedConcerns,
    uniqueSupportedInsights,
    coverage,
    sensitivity,
    experiments,
    ...(featureBacklog ? { featureBacklog } : {}),
    ...(implementationPlan ? { implementationPlan } : {}),
    ...(readerBrief ? { readerBrief } : {}),
    missingRequestedOutputs,
    counterCase: counter
      ? { available: true, reasoning: counter.reasoning, claimIds: counter.claim_ids.filter((id) => claimById.has(id)) }
      : { available: false, reasoning: 'No graph-anchored counter-case was recorded.', claimIds: [] },
    contributions,
    seatStats,
    technical: {
      submissions: seats.map((seat) => ({
        provider: seat.provider,
        name: disp(seat.provider),
        strongestVersion: seat.output.strongest_version,
        positionIds: graph.positions.filter((position) => position.provider === seat.provider).map((position) => position.id),
      })),
      positions: technicalPositions,
      edges: graph.edges,
      events: positionChanges,
    },
  };
}

/** Assemble the machine-readable report deterministically from the run's persisted artifacts. */
export function buildDecisionReport(ctx: RunCtx, args: S10Args): DecisionReportJson {
  const { contract, seats, graph, verifications, judgeReport, actionPlan } = args;
  const mode = ctx.mode ?? 'council';
  const flags = new Set(ctx.flags);
  const newDecisionContract = 'success_bar' in contract;
  const hasReaderBrief = Boolean(actionPlan && !('kind' in actionPlan) && actionPlan.reader_brief);
  if (newDecisionContract && !hasReaderBrief && !flags.has('plan_skipped') && !flags.has('plan_fallback')) {
    flags.add('plan_fallback');
  }
  const confidence = computeConfidence(graph, flags);
  const status = statusFrom(judgeReport);
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const openQuestions = mergeOpenQuestions(seats);
  const requestedOutputs: RequestedOutput[] = (contract as IntentContract & { requested_outputs?: RequestedOutput[] }).requested_outputs
    ?? ['DECISION'];

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
      ruling: claimRuling(graph, claim, rulingById.get(claim.id)),
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
  const consensusType = mode === 'quick' ? 'single_analyst' as const : disagreements.length === 0
    ? (claims.some((claim) => claim.ruling === 'UNRESOLVED') ? 'convergent_with_unresolved_claims' as const : 'unanimous' as const)
    : disagreements.every((d) => d.status === 'RESOLVED') ? 'majority_with_dissent' as const : 'contested' as const;

  // Frame the slot as what it is — a decisive assumption that is NOT proven. Echoing the bare
  // proposition inverts the meaning when the claim is phrased affirmatively (run 20260714-2321:
  // "a cutover can preserve compliance" read as reassurance, the opposite of the verdict).
  const criticalClaim = graph.claims.find(
    (claim) => claim.load_bearing && claim.if_false === 'STOP' && claim.evidence_state !== 'SUPPORTED');
  const criticalWarning = criticalClaim
    ? `Unverified decisive assumption (if false, STOP): ${criticalClaim.proposition} — evidence ${criticalClaim.evidence_state}.`
    : null;

  // Same framing problem as the critical warning above: an unsettled load-bearing claim rendered as
  // its bare (often affirmatively-phrased) proposition reads as an endorsement, not a risk. Frame
  // each explicitly, sort worst-first, and skip the claim already surfaced as the critical warning
  // so it isn't double-counted.
  const severityRank: Record<'High' | 'Medium' | 'Low', number> = { High: 0, Medium: 1, Low: 2 };
  const risks = graph.claims
    .filter((claim) => claim.load_bearing && claim.evidence_state !== 'SUPPORTED' && claim.id !== criticalClaim?.id)
    .map((claim) => ({
      risk: `Rests on unsettled claim: ${claim.proposition} (evidence ${claim.evidence_state}).`,
      severity: SEVERITY_MAP[claim.sensitivity] ?? 'Medium',
    }))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const verificationResults = verifications.verifications.map((v) => {
    if ('claim_id' in v) {
      return {
        claimId: v.claim_id,
        claim: claimById.get(v.claim_id)?.proposition ?? v.claim_id,
        method: 'independent verifier model',
        verdict: (v.status === 'VERIFIED' ? 'CONFIRMED' : v.status === 'CONTRADICTED' ? 'REFUTED' : 'UNCERTAIN') as 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN',
        evidence: v.evidence_ids.length ? v.evidence_ids.join(', ') : v.missing_evidence.join('; '),
        note: v.reasoning,
      };
    }
    return {
      claimId: v.target_id,
      claim: claimById.get(v.target_id)?.proposition ?? v.target_id,
      method: 'independent verifier model',
      verdict: (v.verdict === 'CONFIRM' ? 'CONFIRMED' : v.verdict === 'REFUTE' ? 'REFUTED' : 'UNCERTAIN') as 'CONFIRMED' | 'REFUTED' | 'UNCERTAIN',
      evidence: v.evidence,
      note: v.note,
    };
  });

  const byProvider: Record<string, number> = {};
  let modelTimeMs = 0;
  for (const call of ctx.calls) {
    byProvider[call.provider] = (byProvider[call.provider] ?? 0) + 1;
    modelTimeMs += call.durationMs;
  }

  const roles = ctx.roles;
  const reportProviders = mode === 'quick' ? [...new Set(seats.map((seat) => seat.provider))] : ctx.available();
  const models = reportProviders.map((provider) => ({
    provider,
    name: disp(provider),
    roles: mode === 'quick' ? ['single analyst'] : [
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
  const dossier = buildDossier({
    status,
    summary: judgeReport.verdict,
    reason: judgeReport.key_points?.[0] ?? judgeReport.verdict,
    claims,
    models,
    seats,
    graph,
    verifications,
    judgeReport,
    actionPlan,
    rebuttals: args.rebuttals,
    rubric: args.rubric ?? [],
    requestedOutputs,
    newDecisionContract,
    flags,
  });
  const decisionSnapshot = judgeReport.decision_snapshot ? {
    decisiveNumbers: judgeReport.decision_snapshot.decisive_numbers.map((item) => ({
      label: item.label,
      value: item.value,
      meaning: item.meaning,
      claimIds: item.claim_ids,
    })),
    ...(judgeReport.decision_snapshot.payback ? {
      payback: {
        status: judgeReport.decision_snapshot.payback.status,
        result: judgeReport.decision_snapshot.payback.result,
        basis: judgeReport.decision_snapshot.payback.basis,
        claimIds: judgeReport.decision_snapshot.payback.claim_ids,
      },
    } : {}),
    options: judgeReport.decision_snapshot.options.map((option) => ({
      label: option.label,
      commitment: option.commitment,
      commitmentKind: option.commitment_kind,
      tradeoff: option.tradeoff,
      claimIds: option.claim_ids,
    })),
    ...(judgeReport.decision_snapshot.tripwire ? {
      tripwire: {
        metric: judgeReport.decision_snapshot.tripwire.metric,
        threshold: judgeReport.decision_snapshot.tripwire.threshold,
        decisionRule: judgeReport.decision_snapshot.tripwire.decision_rule,
        claimIds: judgeReport.decision_snapshot.tripwire.claim_ids,
      },
    } : {}),
  } : undefined;

  return {
    reportId: ctx.runId,
    generatedAt: new Date().toISOString(),
    mode,
    task: {
      original: args.original ?? contract.task,
      normalized: contract.task,
      type: contract.task_type,
      constraints: contract.constraints,
      successCriteria: contract.success_criteria,
      ...('confirmation' in contract && typeof contract.confirmation === 'string' ? { confirmation: contract.confirmation } : {}),
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
    keyFindings: (judgeReport.key_points?.length ? judgeReport.key_points : [judgeReport.verdict]).slice(0, 4),
    criticalUnknowns: openQuestions.slice(0, 3),
    ...(decisionSnapshot ? { decisionSnapshot } : {}),
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
    openQuestions,
    flags: [...flags],
    receipt: { calls: ctx.calls.length, budget: ctx.budget.limit, byProvider, modelTimeMs, categories: receiptCategories(ctx) },
    dossier,
  };
}

export { renderDecisionDossierMarkdown };

export function renderReport(ctx: RunCtx, args: S10Args): string {
  return renderDecisionDossierMarkdown(buildDecisionReport(ctx, args));
}
// ── Terminal summary (level 1) ───────────────────────────────────────────────

const RULE = '─'.repeat(48);

function terminalLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function renderTerminalSummary(report: DecisionReportJson, paths: { markdownPath: string; jsonPath: string }): string {
  const projection = report.dossier.readerBrief ? buildReaderProjection(report) : undefined;
  const candidates = projection
    ? [...projection.sections.flatMap((section) => [section.summary, ...section.bullets]), ...projection.caveats, projection.nextStep]
    : [...(report.keyFindings ?? []), ...report.verdict.conditions, report.verdict.primaryReason];
  const takeaways = [...new Set(candidates.map(terminalLine).filter(Boolean))].slice(0, 3);
  const nextStep = projection?.nextStep ?? report.recommendedActions[0]?.action ?? 'Open the report and choose the smallest decisive next action.';
  return [
    report.mode === 'quick' ? 'AIKI · SINGLE-MODEL DECISION' : 'AIKI · COUNCIL DECISION',
    RULE,
    `Verdict: ${terminalLine(projection?.headline ?? report.verdict.summary)}`,
    terminalLine(projection?.bottomLine ?? report.verdict.primaryReason),
    ...(projection?.warnings[0] ? [`Warning: ${projection.warnings[0].message}`] : []),
    '',
    'Key takeaways:',
    ...takeaways.map((item) => `- ${item}`),
    '',
    `Next step: ${terminalLine(nextStep)}`,
    `Report: ${paths.markdownPath}`,
  ].join('\n');
}

export async function s10Render(ctx: RunCtx, args: S10Args): Promise<void> {
  const report = buildDecisionReport(ctx, args);
  await ctx.writer.writeJson('decision-report', report);
  await ctx.writer.writeText('final-report', renderDecisionDossierMarkdown(report));
}
