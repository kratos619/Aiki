// v6 semantic claim join (plan/AIKI-v6-council-integrity-plan.md T5). The lexical ≥0.8 grouping in
// S7 cannot join cross-provider paraphrases, so "0 consensus · 0 disputes" was structural (run
// f740: codex G3 and agy G13 both said "build `aiki serve`" and sat as two UNIQUE claims). S8 now
// emits `claim_groups`; this module validates them deterministically and OVERLAYS states onto the
// compiled graph — claim ids, propositions, edges, and stored artifacts are never mutated, and the
// state itself is computed by the SAME `classifyClaimState` machine the lexical path uses.

import type { ClaimGroup } from '../schemas/index.js';
import { classifyClaimState, type DecisionGraph } from './decision-graph.js';

/** Drop anything the model got wrong: unknown claim ids, duplicate ids, and groups whose claims
 *  all come from ONE provider — a model agreeing with itself is not consensus. */
export function sanitizeClaimGroups(graph: DecisionGraph, groups: ClaimGroup[] | undefined): ClaimGroup[] {
  if (!groups?.length) return [];
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  return groups.flatMap((group) => {
    const ids = [...new Set(group.ids)].filter((id) => claimById.has(id));
    if (ids.length < 2) return [];
    const providers = new Set(ids.flatMap((id) =>
      claimById.get(id)!.position_ids.map((positionId) => positionById.get(positionId)?.provider)
        .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined)));
    if (providers.size < 2) return [];
    return [{ ids, relation: group.relation }];
  });
}

/** Overlay group-derived states onto a copy of the graph. SAME → the union of the member claims'
 *  positions is re-classified by the existing state machine (CONSENSUS/SHARED_CONCERN/…);
 *  OPPOSES → DISAGREEMENT, which wins over any SAME assignment. Old artifacts (no groups) pass
 *  through unchanged, so every pre-v6 run keeps its exact rendering. */
export function overlayClaimGroups(graph: DecisionGraph, groups: ClaimGroup[] | undefined): DecisionGraph {
  const sane = sanitizeClaimGroups(graph, groups);
  if (!sane.length) return graph;
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const stateById = new Map<string, DecisionGraph['claims'][number]['state']>();
  for (const group of sane) {
    if (group.relation === 'OPPOSES') {
      for (const id of group.ids) stateById.set(id, 'DISAGREEMENT');
      continue;
    }
    const union = group.ids
      .flatMap((id) => claimById.get(id)!.position_ids)
      .map((id) => positionById.get(id))
      .filter((position): position is NonNullable<typeof position> => position !== undefined);
    const state = classifyClaimState(union);
    for (const id of group.ids) if (stateById.get(id) !== 'DISAGREEMENT') stateById.set(id, state);
  }
  return {
    ...graph,
    claims: graph.claims.map((claim) => (stateById.has(claim.id) ? { ...claim, state: stateById.get(claim.id)! } : claim)),
  };
}
