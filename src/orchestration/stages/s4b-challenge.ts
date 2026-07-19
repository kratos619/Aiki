// v7 Phase D — one auto-only delta challenge over hard-gated claim packets.

import type { ProviderId } from '../../providers/types.js';
import {
  ChallengeDeltaSet as ChallengeDeltaSetSchema,
  type ChallengeDelta,
  type ChallengeDeltaSet,
} from '../../schemas/index.js';
import {
  canProduceNewInformation,
  type AutoEscalationGate,
} from '../auto-profile.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import type { DecisionGraph } from '../decision-graph.js';
import { jsonCall } from '../jsonStage.js';
import { buildClaimPackets } from './s8-verify.js';

const CHALLENGE_PROMPT = `ROLE: Independent delta challenger. You see only the targeted anonymous claim
packets below, not the full task. Confirm, counter, narrow, replace, or leave each claim unresolved.

Output ONLY JSON:
{"deltas":[{"claimId":"<G-id>","response":"CONFIRM|COUNTER|NARROW|REPLACE|UNRESOLVED",
"reasoning":"<precise reason>","newEvidenceIds":["<E-id>"],
"changedDecisionImpact":"<what changes, or why the decision stays stable>"}]}

Return exactly one delta per packet. Cite only evidence IDs shown in that packet. Do not invent a
source, URL, claim ID, or evidence ID. JSON only.
TARGET CLAIM PACKETS: {{PACKETS_JSON}}`;

export function buildChallengePrompt(packets: unknown[]): string {
  return CHALLENGE_PROMPT.replace('{{PACKETS_JSON}}', JSON.stringify(packets, null, 2));
}

function validateAndTranslate(
  result: ChallengeDeltaSet,
  targetIds: string[],
  evidenceRefs: Map<string, string>,
  allowedEvidence: Map<string, Set<string>>,
): ChallengeDeltaSet {
  const expected = new Set(targetIds);
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const delta of result.deltas) {
    if (!expected.has(delta.claimId)) issues.push(`unknown claim id: ${delta.claimId}`);
    if (seen.has(delta.claimId)) issues.push(`duplicate claim delta: ${delta.claimId}`);
    seen.add(delta.claimId);
    const allowed = allowedEvidence.get(delta.claimId) ?? new Set<string>();
    for (const id of delta.newEvidenceIds) if (!allowed.has(id)) issues.push(`invalid evidence id for ${delta.claimId}: ${id}`);
  }
  for (const id of expected) if (!seen.has(id)) issues.push(`missing claim delta: ${id}`);
  if (issues.length) throw new StageError('S4b', 'BAD_OUTPUT', issues.join('; '));
  return {
    deltas: result.deltas.map((delta) => ({
      ...delta,
      newEvidenceIds: delta.newEvidenceIds.map((id) => evidenceRefs.get(id)!),
    })),
  };
}

function challengerProvider(ctx: RunCtx, primaryProvider: ProviderId): ProviderId | undefined {
  return [...new Set([ctx.roles.verifier, ...ctx.roles.s4, ...ctx.available()])]
    .find((provider) => provider !== primaryProvider && ctx.available().includes(provider));
}

/** At most one provider call; no repair call and no work for an information-free target. */
export async function s4bChallenge(
  ctx: RunCtx,
  graph: DecisionGraph,
  gates: AutoEscalationGate[],
  primaryProvider: ProviderId,
): Promise<ChallengeDeltaSet> {
  const byClaim = new Map(gates.map((gate) => [gate.claimId, gate]));
  const targets = [...byClaim.values()]
    .filter((gate) => graph.claims.some((claim) => claim.id === gate.claimId))
    .filter((gate) => canProduceNewInformation(graph, gate.claimId))
    .slice(0, 3);
  const provider = challengerProvider(ctx, primaryProvider);
  if (!targets.length || !provider) return { deltas: [] };

  const packets = buildClaimPackets(graph, targets.map((gate) => ({
    claim_id: gate.claimId,
    kind: gate.kind,
  })));
  try {
    const result = await jsonCall(
      ctx,
      ctx.handle(provider),
      'S4b',
      buildChallengePrompt(packets.packets),
      ChallengeDeltaSetSchema,
      { repair: false },
    );
    const translated = validateAndTranslate(
      result,
      targets.map((gate) => gate.claimId),
      packets.evidenceRefs,
      packets.allowedEvidence,
    );
    await ctx.writer.writeJson('challenge-deltas', translated);
    return translated;
  } catch (error) {
    if (isFatal(error)) throw error;
    const empty: ChallengeDeltaSet = { deltas: [] };
    await ctx.writer.writeJson('challenge-deltas', empty);
    return empty;
  }
}

/** Derived graph overlay; the stored S7 artifact and every non-target claim stay untouched. */
export function overlayChallengeDeltas(graph: DecisionGraph, deltas: ChallengeDelta[]): DecisionGraph {
  if (!deltas.length) return graph;
  const stateById = new Map(deltas.map((delta) => [delta.claimId,
    delta.response === 'CONFIRM' ? 'CONSENSUS' as const
      : delta.response === 'COUNTER' ? 'DISAGREEMENT' as const
        : 'UNCERTAIN' as const]));
  return {
    ...graph,
    claims: graph.claims.map((claim) => {
      const state = stateById.get(claim.id);
      if (!state || (state === 'CONSENSUS' && claim.state === 'DISAGREEMENT')) return claim;
      return { ...claim, state };
    }),
  };
}
