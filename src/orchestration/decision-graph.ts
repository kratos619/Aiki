import type { ProviderId } from '../providers/types.js';
import type {
  ClaimPosition as ClaimPositionT,
  CalculationLedger as CalculationLedgerT,
  CoverageEntry as CoverageEntryT,
  DecisionGraph as DecisionGraphT,
  DecisionQuestion as DecisionQuestionT,
  EvidenceCard as EvidenceCardT,
  IdeaRoleOutput,
  ClaimVerificationSet,
} from '../schemas/index.js';
import { evaluateCalculation } from './calculations.js';

export type ClaimPosition = ClaimPositionT;
export type EvidenceCard = EvidenceCardT;
export type CalculationLedger = CalculationLedgerT;
export type CoverageEntry = CoverageEntryT;
export type DecisionQuestion = DecisionQuestionT;
export type AnalystSubmission = Omit<IdeaRoleOutput, 'workflow' | 'calculations'> & { calculations?: CalculationLedger[] };
export type Stance = ClaimPosition['stance'];
export type Basis = ClaimPosition['basis'];
export type IfFalse = ClaimPosition['if_false'];

export interface ProviderSubmission {
  provider: ProviderId;
  source_id?: string;
  submission: AnalystSubmission;
}

export type DecisionGraph = DecisionGraphT;
export type GraphPosition = DecisionGraph['positions'][number];
export type GraphEvidence = DecisionGraph['evidence'][number];
export type GraphCalculation = DecisionGraph['calculations'][number];
export type DecisionClaim = DecisionGraph['claims'][number];
export type ClaimState = DecisionClaim['state'];
export type EvidenceState = DecisionClaim['evidence_state'];
export type Sensitivity = DecisionClaim['sensitivity'];

export interface ClaimOutcome {
  propositionTruth: 'HOLDS' | 'FAILS' | 'UNRESOLVED';
  decisionEffect: 'HELD' | 'FAILED' | 'UNVERIFIED';
}

/** Decode the persisted legacy ruling once, keeping proposition truth separate from decision effect. */
export function interpretClaimOutcome(
  graph: DecisionGraph,
  claim: DecisionClaim,
  adjudication?: { ruling: 'UPHOLD' | 'REJECT' | 'UNRESOLVED' },
): ClaimOutcome {
  const first = graph.positions.find((position) => claim.position_ids.includes(position.id));
  let propositionTruth: ClaimOutcome['propositionTruth'];
  if (!adjudication || adjudication.ruling === 'UNRESOLVED') {
    propositionTruth = claim.state === 'DISAGREEMENT' || claim.state === 'UNCERTAIN' || claim.evidence_state !== 'SUPPORTED'
      ? 'UNRESOLVED' : 'HOLDS';
  } else if (claim.state === 'DISAGREEMENT') {
    propositionTruth = adjudication.ruling === 'UPHOLD' ? 'FAILS' : 'HOLDS';
  } else {
    const propositionIsObjection = first?.stance === 'OPPOSE';
    propositionTruth = adjudication.ruling === 'UPHOLD'
      ? (propositionIsObjection ? 'HOLDS' : 'FAILS')
      : (propositionIsObjection ? 'FAILS' : 'HOLDS');
  }

  let decisionEffect: ClaimOutcome['decisionEffect'];
  if (claim.state === 'UNCERTAIN' || claim.evidence_state !== 'SUPPORTED') decisionEffect = 'UNVERIFIED';
  else if (claim.state === 'SHARED_CONCERN' || (claim.state === 'UNIQUE' && first?.stance === 'OPPOSE')) decisionEffect = 'FAILED';
  else if (claim.state === 'DISAGREEMENT') {
    decisionEffect = adjudication?.ruling === 'UPHOLD' ? 'FAILED'
      : adjudication?.ruling === 'REJECT' ? 'HELD' : 'UNVERIFIED';
  } else decisionEffect = 'HELD';
  return { propositionTruth, decisionEffect };
}

export interface Escalation {
  claim_id: string;
  reason: string;
  kind: 'DISAGREEMENT' | 'EVIDENCE_CONFLICT' | 'INDEPENDENT_CHALLENGE' | 'EVIDENCE_HOLE';
}

export interface CoverageHole {
  dimension_id: string;
  label: string;
}

export function positionId(provider: ProviderId, localId: string, sourceId: string = provider): string {
  return `${sourceId}/${localId}`;
}

function classify(positions: GraphPosition[]): ClaimState {
  const providers = new Set(positions.map((position) => position.provider));
  const stances = new Set(positions.map((position) => position.stance));
  const supporters = positions.filter((position) => position.stance === 'SUPPORT').map((position) => position.provider);
  const opponents = positions.filter((position) => position.stance === 'OPPOSE').map((position) => position.provider);
  if (supporters.some((supporter) => opponents.some((opponent) => opponent !== supporter))) return 'DISAGREEMENT';
  if (stances.has('SUPPORT') && stances.has('OPPOSE')) return 'UNCERTAIN';
  if (providers.size >= 2 && stances.size === 1 && stances.has('OPPOSE')) return 'SHARED_CONCERN';
  if (providers.size >= 2 && stances.size === 1 && !stances.has('UNKNOWN')) return 'CONSENSUS';
  if ([...stances].every((stance) => stance === 'UNKNOWN' || stance === 'MIXED')) return 'UNCERTAIN';
  if (providers.size === 1) return 'UNIQUE';
  return 'UNCERTAIN';
}

const restrictedClaim = /\b(current|today|latest|now|law|legal|regulat\w*|medic\w*|health\w*|financ\w*|market\w*|prices?|costs?|revenue|fees?|percent(?:age)?)\b|\d/i;

function needsIndependentEvidence(positions: GraphPosition[], evidenceById: Map<string, GraphEvidence>): boolean {
  const evidence = positions.flatMap((position) => position.evidence_ids
    .map((id) => evidenceById.get(positionId(position.provider, id, position.source_id)))
    .filter((item): item is GraphEvidence => item !== undefined));
  return positions.some((position) => restrictedClaim.test(`${position.dimension_id} ${position.proposition}`))
    || evidence.some((item) => item.freshness === 'CURRENT');
}

function evidenceState(positions: GraphPosition[], evidenceById: Map<string, GraphEvidence>): EvidenceState {
  const requiresIndependent = needsIndependentEvidence(positions, evidenceById);
  let unresolved = false;
  for (const position of positions) {
    const allowed = position.evidence_ids
      .map((id) => evidenceById.get(positionId(position.provider, id, position.source_id)))
      .filter((item): item is GraphEvidence => item !== undefined)
      .filter((item) => !requiresIndependent || item.source_kind !== 'MODEL_KNOWLEDGE');
    const directions = new Set(allowed.map((item) => item.support));
    const expected = position.stance === 'SUPPORT' ? 'SUPPORTS' : position.stance === 'OPPOSE' ? 'CONTRADICTS' : undefined;
    if (!expected || !directions.has(expected)) unresolved = true;
    const opposite = expected === 'SUPPORTS' ? 'CONTRADICTS' : expected === 'CONTRADICTS' ? 'SUPPORTS' : undefined;
    if (opposite && directions.has(opposite)) return 'CONFLICTED';
  }
  return unresolved ? 'UNVERIFIED' : 'SUPPORTED';
}

const ifFalseRank: Record<IfFalse, number> = { STOP: 0, PIVOT: 1, CONDITION: 2, MINOR: 3 };

function sensitivity(positions: GraphPosition[]): Sensitivity {
  if (!positions.some((position) => position.load_bearing)) return 'LOW';
  const consequence = positions.map((position) => position.if_false).sort((a, b) => ifFalseRank[a] - ifFalseRank[b])[0];
  return consequence === 'STOP' || consequence === 'PIVOT' ? 'DECISIVE' : consequence === 'CONDITION' ? 'MATERIAL' : 'LOW';
}

/** Required dimensions without an explicit anchored COVERED or reasoned NOT_APPLICABLE entry. */
export function coverageHoleQueue(
  submissions: ProviderSubmission[],
  rubric: Array<{ id: string; label: string }>,
): CoverageHole[] {
  const covered = new Set<string>();
  for (const { submission } of submissions) {
    const positions = new Map(submission.positions.map((position) => [position.local_id, position]));
    for (const entry of submission.coverage) {
      if (entry.status === 'NOT_APPLICABLE' && entry.rationale?.trim()) covered.add(entry.dimension_id);
      if (entry.status === 'COVERED' && entry.position_ids.some((id) => positions.get(id)?.dimension_id === entry.dimension_id)) {
        covered.add(entry.dimension_id);
      }
    }
  }
  return rubric.filter((item) => !covered.has(item.id)).map(({ id, label }) => ({ dimension_id: id, label }));
}

/** Compile validated analyst positions into stance-aware claims without rewriting proposition text. */
export function compileDecisionGraph(
  submissions: ProviderSubmission[],
  rubric: Array<{ id: string; label: string }>,
  semanticGroups: string[][] = [],
): DecisionGraph {
  const positions = submissions.flatMap(({ provider, source_id = provider, submission }) => submission.positions.map((position) => ({
    ...position,
    id: positionId(provider, position.local_id, source_id),
    provider,
    source_id,
  })));
  const evidence = submissions.flatMap(({ provider, source_id = provider, submission }) => submission.evidence.map((item) => ({
    ...item,
    id: positionId(provider, item.id, source_id),
    provider,
    source_id,
  })));
  const byId = new Map(positions.map((position) => [position.id, position]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const grouped = new Set<string>();
  const groups = semanticGroups.flatMap((group) => {
    const valid = group.filter((id) => byId.has(id) && !grouped.has(id));
    if (valid.length < 2) return [];
    valid.forEach((id) => grouped.add(id));
    return [valid];
  });
  for (const position of positions) if (!grouped.has(position.id)) groups.push([position.id]);
  const evidenceHoles: DecisionGraph['holes']['evidence'] = [];
  let claims = groups.map((ids, index) => {
    const members = ids.map((id) => byId.get(id)!);
    const evidence_state = evidenceState(members, evidenceById);
    const id = `G${index + 1}`;
    if (members.some((member) => member.load_bearing) && evidence_state !== 'SUPPORTED') {
      const reason = evidence_state === 'CONFLICTED'
        ? 'load-bearing claim has conflicting evidence'
        : needsIndependentEvidence(members, evidenceById)
          ? 'claim requires independently checkable evidence'
          : 'load-bearing claim has no settling evidence';
      evidenceHoles.push({ claim_id: id, reason });
    }
    const baseState = classify(members);
    return {
      id,
      proposition: members[0]!.proposition,
      position_ids: ids,
      state: evidence_state === 'UNVERIFIED' || evidence_state === 'CONFLICTED' ? 'UNCERTAIN' as const : baseState,
      evidence_state,
      nature: members.some((member) => member.nature === 'FACTUAL') ? 'FACTUAL' as const : 'JUDGMENT' as const,
      load_bearing: members.some((member) => member.load_bearing),
      if_false: members.map((member) => member.if_false).sort((a, b) => ifFalseRank[a] - ifFalseRank[b])[0]!,
      sensitivity: sensitivity(members),
    };
  });
  const claimByPosition = new Map(claims.flatMap((claim) => claim.position_ids.map((id) => [id, claim.id] as const)));
  const calculations = submissions.flatMap(({ provider, source_id = provider, submission }) =>
    (submission.calculations ?? []).flatMap((calculation) => {
      const claim_id = claimByPosition.get(positionId(provider, calculation.claim_id, source_id));
      if (!claim_id) return [];
      return [{
        ...calculation,
        id: positionId(provider, calculation.id, source_id),
        claim_id,
        inputs: calculation.inputs.map((input) => ({
          ...input,
          evidence_ids: input.evidence_ids.map((id) => positionId(provider, id, source_id)),
        })),
        provider,
        source_id,
      }];
    }));
  const calculationChecks = calculations.map(evaluateCalculation);
  const failedCalculationClaims = new Set(calculationChecks.filter((check) => check.status === 'FAIL').map((check) => check.claim_id));
  for (const claimId of failedCalculationClaims) {
    const existing = evidenceHoles.find((hole) => hole.claim_id === claimId);
    if (existing) existing.reason += '; deterministic calculation failed';
    else evidenceHoles.push({ claim_id: claimId, reason: 'deterministic calculation failed' });
  }
  claims = claims.map((claim) => failedCalculationClaims.has(claim.id)
    ? { ...claim, state: 'UNCERTAIN' as const, evidence_state: 'UNVERIFIED' as const }
    : claim);
  const edges: DecisionGraph['edges'] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: DecisionGraph['edges'][number]) => {
    const key = `${edge.from}:${edge.to}:${edge.type}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };
  for (const position of positions) {
    const from = claimByPosition.get(position.id)!;
    for (const dependency of position.depends_on) {
      const to = claimByPosition.get(dependency.includes('/') ? dependency : positionId(position.provider, dependency, position.source_id));
      if (to && to !== from) addEdge({ from, to, type: 'DEPENDS_ON' });
    }
    for (const evidenceId of position.evidence_ids) {
      const item = evidenceById.get(positionId(position.provider, evidenceId, position.source_id));
      if (!item) continue;
      addEdge({ from: item.id, to: from, type: item.support === 'CONTRADICTS' ? 'ATTACKS' : 'SUPPORTS' });
    }
  }
  const coverageHoles = coverageHoleQueue(submissions, rubric);
  return {
    positions,
    evidence,
    calculations,
    calculation_checks: calculationChecks,
    claims,
    edges,
    holes: { coverage: coverageHoles, evidence: evidenceHoles },
  };
}

function decisionCritical(claim: DecisionClaim): boolean {
  return claim.if_false !== 'MINOR' && claim.sensitivity !== 'LOW';
}

/** Select graph nodes that warrant independent verification, ordered by decision value. */
export function selectEscalations(graph: DecisionGraph, limits: { max: number }): Escalation[] {
  const selected: Escalation[] = [];
  const seen = new Set<string>();
  const add = (claim: DecisionClaim, reason: string, kind: Escalation['kind']) => {
    if (seen.has(claim.id) || selected.length >= limits.max) return;
    seen.add(claim.id);
    selected.push({ claim_id: claim.id, reason, kind });
  };

  for (const claim of graph.claims) {
    if (claim.state === 'DISAGREEMENT' && decisionCritical(claim)) {
      add(claim, 'opposing provider stances', 'DISAGREEMENT');
    }
  }
  for (const claim of graph.claims) {
    if (claim.load_bearing && decisionCritical(claim) && claim.evidence_state === 'CONFLICTED') {
      add(claim, 'conflicting evidence on a load-bearing claim', 'EVIDENCE_CONFLICT');
    }
  }
  for (const claim of graph.claims) {
    if (claim.state === 'UNIQUE' && claim.load_bearing && decisionCritical(claim)) {
      add(claim, 'load-bearing unique claim', 'INDEPENDENT_CHALLENGE');
    }
  }
  for (const hole of graph.holes.evidence) {
    const claim = graph.claims.find((item) => item.id === hole.claim_id);
    if (claim?.load_bearing && decisionCritical(claim)) {
      add(claim, hole.reason, 'EVIDENCE_HOLE');
    }
  }
  return selected;
}

/** R5's stricter queue: only verdict-flipping nodes may spend an optional rebuttal call. */
export function selectRebuttalEscalations(
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  limits: { maxNodes: number },
): Escalation[] {
  const selected: Escalation[] = [];
  const seen = new Set<string>();
  const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
  const add = (claim: DecisionClaim, reason: string, kind: Escalation['kind']) => {
    if (seen.has(claim.id) || selected.length >= limits.maxNodes) return;
    seen.add(claim.id);
    selected.push({ claim_id: claim.id, reason, kind });
  };

  for (const claim of graph.claims) {
    if (claim.state === 'DISAGREEMENT' && decisionCritical(claim)) {
      add(claim, 'opposing provider stances on a decision-critical claim', 'DISAGREEMENT');
    }
  }
  for (const claim of graph.claims) {
    if (claim.load_bearing && decisionCritical(claim) && verificationById.get(claim.id)?.status === 'CONTRADICTED') {
      add(claim, 'independent verification contradicted a load-bearing claim', 'EVIDENCE_CONFLICT');
    }
  }
  for (const claim of graph.claims) {
    if (claim.state === 'UNIQUE' && claim.load_bearing && decisionCritical(claim)) {
      add(claim, 'load-bearing unique claim needs an independent challenge', 'INDEPENDENT_CHALLENGE');
    }
  }
  for (const hole of graph.holes.evidence) {
    const claim = graph.claims.find((item) => item.id === hole.claim_id);
    if (claim?.load_bearing && decisionCritical(claim)) {
      add(claim, `decision-critical evidence hole: ${hole.reason}`, 'EVIDENCE_HOLE');
    }
  }
  return selected;
}
