// v7 Phase B — `--mode auto`: a deterministic quick-vs-council routing decision made in the CLI
// BEFORE the engine runs. No model call, no learned routing (§22 forbids that). The rules err toward
// council: a false council only costs more calls, a false quick under-scrutinizes a risky decision.

import type { RequestedOutput } from '../schemas/index.js';
import type { DecisionGraph } from './decision-graph.js';

export interface TaskProfile {
  wordCount: number;
  urlCount: number;
  hasEvidencePack: boolean;
  deliverablesBeyondDecision: boolean;
  hasSensitiveKeyword: boolean; // regulated / financial / security / medical topic
  hasResearchWording: boolean; // asks to investigate / find current sources
  hasDecisionIntent: boolean; // Phase C: reads as a direct decision question (LOW ambiguity)
}

export interface AutoEscalationGate {
  claimId: string;
  kind:
    | 'NO_INDEPENDENT_EVIDENCE'
    | 'MODEL_KNOWLEDGE_DECISION'
    | 'FAILED_CALCULATION'
    | 'SUPPLIED_SOURCE_CONTRADICTION'
    | 'LOAD_BEARING_DISAGREEMENT';
  reason: string;
}

// ponytail: v1 keyword heuristics, not NLP. Upgrade path = a scored intent matcher if precision matters.
const SENSITIVE =
  /\b(?:regulat|complian|legal|lawsuit|licens|liabilit|hipaa|gdpr|pci|soc\s?2|financ|fintech|invest|tax(?:es|ation)?|loan|mortgage|insuran|securities|security|vulnerab|exploit|breach|malware|phishing|credential|medical|patient|clinical|diagnos)\w*/i;
const RESEARCH =
  /\b(?:research|investigat|competitive analysis|market size|find (?:sources|evidence|data)|look up|up[- ]to[- ]date|latest data|current (?:data|figures|numbers|pricing)|cite sources?)\w*/i;
// ponytail: v1 decision-question heuristic; upgrade path = the same scored matcher as SENSITIVE/RESEARCH.
const DECISION_INTENT =
  /\b(?:should (?:i|we|you)|is it worth|worth (?:it|building|doing|switching|the)|do i (?:need|use)|(?:choose|pick|decide|select) (?:between|whether)|go with|switch(?:ing)? (?:to|from)|migrate (?:to|from)|which\b[^.?!]*\bor\b)/i;

export function buildTaskProfile(
  input: string,
  opts: { urlCount: number; hasEvidencePack: boolean; requestedOutputs: RequestedOutput[] },
): TaskProfile {
  const wordCount = input.trim().split(/\s+/).filter(Boolean).length;
  return {
    wordCount,
    urlCount: opts.urlCount,
    hasEvidencePack: opts.hasEvidencePack,
    deliverablesBeyondDecision: opts.requestedOutputs.some((o) => o !== 'DECISION'),
    hasSensitiveKeyword: SENSITIVE.test(input),
    hasResearchWording: RESEARCH.test(input),
    hasDecisionIntent: wordCount >= 4 && DECISION_INTENT.test(input),
  };
}

/** Ordered deterministic rules: council if ANY signal fires, else quick. `fastPath` (Phase C, quick-only)
 *  is the 1-call single-pass path — eligible when quick AND the input reads as a direct decision question. */
export function resolveAutoMode(profile: TaskProfile): { mode: 'quick' | 'council'; reasons: string[]; fastPath: boolean } {
  const reasons: string[] = [];
  if (profile.urlCount > 0) reasons.push('URLs supplied');
  if (profile.hasEvidencePack) reasons.push('evidence pack supplied');
  if (profile.hasSensitiveKeyword) reasons.push('regulated/financial/security topic');
  if (profile.deliverablesBeyondDecision) reasons.push('deliverables beyond a decision requested');
  if (profile.hasResearchWording) reasons.push('research wording detected');
  if (profile.wordCount > 120) reasons.push('long or complex input (>120 words)');
  if (reasons.length > 0) return { mode: 'council', reasons, fastPath: false };
  return { mode: 'quick', reasons: ['plain single-decision prompt'], fastPath: profile.hasDecisionIntent };
}

function evidenceForClaim(graph: DecisionGraph, claimId: string): DecisionGraph['evidence'] {
  const ids = new Set(graph.edges
    .filter((edge) => edge.to === claimId && (edge.type === 'SUPPORTS' || edge.type === 'ATTACKS'))
    .map((edge) => edge.from));
  return graph.evidence.filter((evidence) => ids.has(evidence.id));
}

/** Phase D hard gates over validated graph structure; ordered for stable receipts and fixtures. */
export function structuralEscalationGates(graph: DecisionGraph): AutoEscalationGate[] {
  const gates: AutoEscalationGate[] = [];
  const seen = new Set<string>();
  const add = (claimId: string, kind: AutoEscalationGate['kind'], reason: string) => {
    const key = `${claimId}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    gates.push({ claimId, kind, reason });
  };

  for (const claim of graph.claims) {
    const evidence = evidenceForClaim(graph, claim.id);
    if (claim.sensitivity === 'DECISIVE'
      && !evidence.some((item) => item.source_kind === 'PRIMARY' || item.source_kind === 'SECONDARY')) {
      add(claim.id, 'NO_INDEPENDENT_EVIDENCE', 'decisive claim has no independent evidence');
    }
  }
  for (const claim of graph.claims) {
    const evidence = evidenceForClaim(graph, claim.id);
    if ((claim.if_false === 'STOP' || claim.if_false === 'PIVOT')
      && evidence.length > 0
      && evidence.every((item) => item.source_kind === 'MODEL_KNOWLEDGE')) {
      add(claim.id, 'MODEL_KNOWLEDGE_DECISION', 'STOP/PIVOT claim rests on model knowledge');
    }
  }
  for (const check of graph.calculation_checks) {
    if (check.status === 'FAIL') add(check.claim_id, 'FAILED_CALCULATION', 'deterministic calculation failed');
  }
  for (const claim of graph.claims) {
    if (claim.load_bearing && evidenceForClaim(graph, claim.id)
      .some((item) => item.source_kind === 'USER' && item.support === 'CONTRADICTS')) {
      add(claim.id, 'SUPPLIED_SOURCE_CONTRADICTION', 'user-supplied evidence contradicts a load-bearing claim');
    }
  }
  for (const claim of graph.claims) {
    if (claim.load_bearing && claim.state === 'DISAGREEMENT') {
      add(claim.id, 'LOAD_BEARING_DISAGREEMENT', 'load-bearing claims are mutually inconsistent');
    }
  }
  return gates;
}

/** One challenge call is useful only when the stored graph contains something new to inspect. */
export function canProduceNewInformation(graph: DecisionGraph, claimId: string): boolean {
  if (!graph.claims.some((claim) => claim.id === claimId)) return false;
  return evidenceForClaim(graph, claimId).some((item) => item.source_kind !== 'MODEL_KNOWLEDGE')
    || graph.calculation_checks.some((check) => check.claim_id === claimId && check.status === 'FAIL')
    || graph.edges.some((edge) => edge.type === 'DEPENDS_ON' && (edge.from === claimId || edge.to === claimId));
}
