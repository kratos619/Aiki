// S8 — independently verify graph-selected claims from stored evidence/calculation references.
// Provider identity stays hidden; model output is translated back to graph evidence IDs before S9.

import type { DecisionGraph } from '../decision-graph.js';
import { selectEscalations } from '../decision-graph.js';
import type { ClaimVerificationSet as ClaimVerificationSetT } from '../../schemas/index.js';
import { ClaimVerificationSet } from '../../schemas/index.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { loadSkill } from '../skills.js';

const S8_PROMPT = `ROLE: Independent verifier. Check each anonymous decision claim below against the
provided evidence cards and deterministic calculation checks. Output ONLY JSON:
{"verifications": [{"claim_id": "<G-id>", "status": "VERIFIED|PARTIAL|CONTRADICTED|UNVERIFIABLE",
  "reasoning": "<concise reason>", "evidence_ids": ["<E-id>"],
  "calculation_check": "PASS|FAIL|NOT_APPLICABLE", "missing_evidence": ["<gap>"]}]}
VERIFIED = the proposition is supported. CONTRADICTED = it is refuted. PARTIAL = evidence is mixed or
incomplete. UNVERIFIABLE = the supplied sources cannot decide. Cite only supplied evidence IDs. Model
knowledge cannot verify a current, numeric, legal, medical, financial, market, or regulatory fact.
Judge each item independently; no verdict quota. JSON only.{{SKILL}}
ITEMS: {{ITEMS_JSON}}`;

interface VerifierInput {
  prompt: string;
  evidenceRefs: Map<string, string>;
}

export function selectVerificationTargets<T extends { nature?: 'FACTUAL' | 'JUDGMENT' }>(claims: T[], max: number): T[] {
  return claims
    .map((claim, index) => ({ claim, index }))
    .sort((left, right) => Number(right.claim.nature === 'FACTUAL') - Number(left.claim.nature === 'FACTUAL') || left.index - right.index)
    .slice(0, max)
    .map(({ claim }) => claim);
}

export function selectVerificationEscalations(graph: DecisionGraph, max = 8) {
  const candidates = selectEscalations(graph, { max: graph.claims.length });
  const byId = new Map(candidates.map((candidate) => [candidate.claim_id, candidate]));
  const claims = candidates.map((candidate) => graph.claims.find((claim) => claim.id === candidate.claim_id)!);
  return selectVerificationTargets(claims, max).map((claim) => byId.get(claim.id)!);
}

function evidenceIdsForClaim(graph: DecisionGraph, claimId: string): Set<string> {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claim = graph.claims.find((item) => item.id === claimId);
  const positionEvidence = claim?.position_ids.flatMap((id) => {
    const position = positionById.get(id);
    return position?.evidence_ids.map((evidenceId) => `${position.source_id}/${evidenceId}`) ?? [];
  }) ?? [];
  const calculationEvidence = graph.calculations.filter((calculation) => calculation.claim_id === claimId)
    .flatMap((calculation) => calculation.inputs.flatMap((input) => input.evidence_ids));
  return new Set([...positionEvidence, ...calculationEvidence]);
}

function verifierInput(graph: DecisionGraph, skill = ''): VerifierInput {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const evidenceRefs = new Map(graph.evidence.map((evidence, index) => [`E${index + 1}`, evidence.id]));
  const aliasByEvidence = new Map([...evidenceRefs].map(([alias, id]) => [id, alias]));
  const evidenceById = new Map(graph.evidence.map((evidence) => [evidence.id, evidence]));
  const items = selectVerificationEscalations(graph).map((escalation) => {
    const claim = graph.claims.find((item) => item.id === escalation.claim_id)!;
    const linkedEvidenceIds = evidenceIdsForClaim(graph, claim.id);
    return {
      id: claim.id,
      kind: escalation.kind,
      proposition: claim.proposition,
      positions: claim.position_ids.map((id) => {
        const position = positionById.get(id)!;
        return { stance: position.stance, reasoning: position.reasoning };
      }),
      evidence: [...linkedEvidenceIds].flatMap((id) => {
        const evidence = evidenceById.get(id);
        if (!evidence) return [];
        const { provider: _provider, source_id: _sourceId, ...card } = evidence;
        return [{ ...card, id: aliasByEvidence.get(id)! }];
      }),
      calculations: graph.calculations.filter((calculation) => calculation.claim_id === claim.id).map((calculation, index) => ({
        id: `C${index + 1}`,
        inputs: calculation.inputs.map((input) => ({
          ...input,
          evidence_ids: input.evidence_ids.map((id) => aliasByEvidence.get(id)).filter((id): id is string => id !== undefined),
        })),
        steps: calculation.steps,
        result_step: calculation.result_step,
        deterministic_check: (() => {
          const check = graph.calculation_checks.find((item) => item.calculation_id === calculation.id);
          return check ? { status: check.status, issues: check.issues } : undefined;
        })(),
      })),
      evidence_hole: graph.holes.evidence.find((hole) => hole.claim_id === claim.id)?.reason,
    };
  });
  const prompt = S8_PROMPT
    .replace('{{SKILL}}', skill ? `\n\n${skill}` : '')
    .replace('{{ITEMS_JSON}}', JSON.stringify(items, null, 2));
  return { prompt, evidenceRefs };
}

export function buildVerifierPrompt(graph: DecisionGraph, skill = ''): string {
  return verifierInput(graph, skill).prompt;
}

/** Validate every S8 claim/evidence reference before the chair can see it. */
export function claimVerificationRefIssues(
  graph: DecisionGraph,
  verifications: ClaimVerificationSetT,
  expectedIds: Iterable<string> = selectVerificationEscalations(graph).map((item) => item.claim_id),
): string[] {
  const expected = new Set(expectedIds);
  const evidence = new Map(graph.evidence.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const verification of verifications.verifications) {
    if (!expected.has(verification.claim_id)) issues.push(`unknown claim id: ${verification.claim_id}`);
    if (seen.has(verification.claim_id)) issues.push(`duplicate claim verification: ${verification.claim_id}`);
    seen.add(verification.claim_id);
    const cards = verification.evidence_ids.map((id) => evidence.get(id));
    for (const [index, card] of cards.entries()) if (!card) issues.push(`unknown evidence id for ${verification.claim_id}: ${verification.evidence_ids[index]}`);
    const linkedEvidence = evidenceIdsForClaim(graph, verification.claim_id);
    for (const id of verification.evidence_ids) if (evidence.has(id) && !linkedEvidence.has(id)) issues.push(`unrelated evidence id for ${verification.claim_id}: ${id}`);
    if (verification.status !== 'UNVERIFIABLE' && verification.evidence_ids.length === 0) {
      issues.push(`${verification.claim_id}: ${verification.status} requires evidence ids`);
    }
    const evidenceHole = graph.holes.evidence.find((hole) => hole.claim_id === verification.claim_id);
    const onlyModelKnowledge = cards.length > 0 && cards.every((card) => card?.source_kind === 'MODEL_KNOWLEDGE');
    if (verification.status === 'VERIFIED' && evidenceHole && onlyModelKnowledge) {
      issues.push(`${verification.claim_id}: model knowledge cannot close its evidence hole`);
    }
    const calculationChecks = graph.calculation_checks.filter((check) => check.claim_id === verification.claim_id);
    if (calculationChecks.some((check) => check.status === 'FAIL')) {
      if (verification.calculation_check !== 'FAIL') issues.push(`${verification.claim_id}: failed deterministic calculation must be reported`);
      if (verification.status === 'VERIFIED') issues.push(`${verification.claim_id}: failed deterministic calculation cannot be verified`);
    }
  }
  for (const id of expected) if (!seen.has(id)) issues.push(`missing claim verification: ${id}`);
  return issues;
}

export async function s8Verify(ctx: RunCtx, graph: DecisionGraph): Promise<ClaimVerificationSetT> {
  const escalations = selectVerificationEscalations(graph);
  if (escalations.length === 0) {
    const empty: ClaimVerificationSetT = { verifications: [] };
    await ctx.writer.writeJson('verifications', empty);
    return empty;
  }

  const unavailable = (): ClaimVerificationSetT => ({
    verifications: escalations.map((escalation) => {
      const checks = graph.calculation_checks.filter((check) => check.claim_id === escalation.claim_id);
      return {
        claim_id: escalation.claim_id,
        status: 'UNVERIFIABLE',
        reasoning: 'Independent verification was unavailable or skipped to preserve required calls.',
        evidence_ids: [],
        calculation_check: checks.length === 0 ? 'NOT_APPLICABLE' as const
          : checks.some((check) => check.status === 'FAIL') ? 'FAIL' as const : 'PASS' as const,
        missing_evidence: ['independent verification'],
      };
    }),
  });
  if (ctx.optionalCallsRemaining() === 0) {
    ctx.addFlag('verification_skipped');
    const skipped = unavailable();
    await ctx.writer.writeJson('verifications', skipped);
    return skipped;
  }

  try {
    const input = verifierInput(graph, loadSkill('idea-refinement', 'verifier'));
    // Optional work gets no model repair: one logical optional call must remain one call.
    const result = await jsonCall(ctx, ctx.handle(ctx.roles.verifier), 'S8', input.prompt, ClaimVerificationSet, { repair: false });
    const translated: ClaimVerificationSetT = {
      verifications: result.verifications.map((verification) => ({
        ...verification,
        evidence_ids: verification.evidence_ids.map((id) => input.evidenceRefs.get(id) ?? id),
      })),
    };
    const issues = claimVerificationRefIssues(graph, translated, escalations.map((item) => item.claim_id));
    if (issues.length) throw new StageError('S8', 'BAD_OUTPUT', issues.join('; '));
    await ctx.writer.writeJson('verifications', translated);
    return translated;
  } catch (error) {
    if (isFatal(error)) throw error;
    const failed = unavailable();
    await ctx.writer.writeJson('verifications', failed);
    return failed;
  }
}
