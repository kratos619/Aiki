// R5 — one optional, bounded rebuttal round over verdict-flipping graph nodes. Original graph
// objects are never rewritten; validated responses are appended as a separate 08b event artifact.

import type { ProviderId } from '../../providers/types.js';
import type {
  ClaimVerificationSet,
  RebuttalEvent,
  RebuttalEventSet,
  RebuttalResponseSet as RebuttalResponseSetT,
} from '../../schemas/index.js';
import { RebuttalEventSet as RebuttalEventSetSchema, RebuttalResponseSet } from '../../schemas/index.js';
import {
  selectRebuttalEscalations,
  type DecisionGraph,
  type Escalation,
} from '../decision-graph.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { IDEA_MODE_PLANS } from '../modes.js';
import { loadSkill } from '../skills.js';
import type { IdeaMode } from '../../schemas/index.js';

export type RebuttalMode = IdeaMode;

/** Internal protocol caps only. R6 owns exposing modes and changing the surrounding topology. */
export const REBUTTAL_LIMITS: Record<RebuttalMode, { maxNodes: number; optionalCalls: number }> = {
  quick: { maxNodes: 0, optionalCalls: 0 },
  council: { maxNodes: 3, optionalCalls: 2 },
  research: { maxNodes: 3, optionalCalls: 2 },
};

const REBUTTAL_PROMPT = `ROLE: Scout rebuttal. This is the council's only rebuttal round. Respond only
to the anonymous decision nodes assigned below. You may not rewrite any original claim or evidence.

Output ONLY JSON:
{"events":[{"claim_id":"<G-id>","response":"CONCEDE|COUNTER|NARROW|UNRESOLVED",
"reasoning":"<precise reason>","evidence_ids":["<E-id>"],
"narrowed_proposition":"<required only for NARROW>"}]}

CONCEDE = your position changes. COUNTER = retain it using a cited supplied card or a precise logical
rebuttal. NARROW = state the smaller proposition actually supported. UNRESOLVED = evidence cannot decide.
Return exactly one event per assigned claim. Cite only evidence IDs shown for that claim. Do not invent
sources, URLs, claim IDs, or evidence IDs. JSON only.{{SKILL}}
NODES: {{NODES_JSON}}`;

interface Assignment {
  provider: ProviderId;
  claim_ids: string[];
}

interface RebuttalInput {
  prompt: string;
  evidenceRefs: Map<string, string>;
  allowedEvidence: Map<string, Set<string>>;
}

function claimAuthors(graph: DecisionGraph, claimId: string): ProviderId[] {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claim = graph.claims.find((item) => item.id === claimId);
  return [...new Set(claim?.position_ids
    .map((id) => positionById.get(id)?.provider)
    .filter((provider): provider is ProviderId => provider !== undefined) ?? [])];
}

function linkedEvidenceIds(graph: DecisionGraph, claimId: string): string[] {
  const evidenceIds = new Set(graph.evidence.map((item) => item.id));
  const linked = graph.edges
    .filter((edge) => edge.to === claimId && evidenceIds.has(edge.from))
    .map((edge) => edge.from);
  for (const calculation of graph.calculations.filter((item) => item.claim_id === claimId)) {
    for (const input of calculation.inputs) linked.push(...input.evidence_ids);
  }
  return [...new Set(linked)];
}

/** One grouped call per relevant scout; judge-authored nodes never enter the rebuttal/chair path. */
export function planRebuttalCalls(
  graph: DecisionGraph,
  escalations: Escalation[],
  scouts: ProviderId[],
  judge: ProviderId,
): Assignment[] {
  const assigned = new Map<ProviderId, string[]>();
  const add = (provider: ProviderId, claimId: string) => {
    const ids = assigned.get(provider) ?? [];
    if (!ids.includes(claimId)) ids.push(claimId);
    assigned.set(provider, ids);
  };

  for (const escalation of escalations) {
    const authors = claimAuthors(graph, escalation.claim_id);
    if (authors.includes(judge)) continue;
    if (escalation.kind === 'DISAGREEMENT' || escalation.kind === 'EVIDENCE_CONFLICT') {
      for (const scout of scouts) if (authors.includes(scout) && scout !== judge) add(scout, escalation.claim_id);
      continue;
    }
    const challenger = scouts.find((scout) => scout !== judge && !authors.includes(scout));
    if (challenger) add(challenger, escalation.claim_id);
  }

  return scouts.flatMap((provider) => {
    const claim_ids = assigned.get(provider);
    return claim_ids?.length ? [{ provider, claim_ids }] : [];
  });
}

function rebuttalInput(
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  escalationById: Map<string, Escalation>,
  assignment: Assignment,
  skill = '',
): RebuttalInput {
  const claimIds = new Set(assignment.claim_ids);
  const positionRefs = new Map<string, string>();
  const evidenceRefs = new Map<string, string>();
  const aliasPosition = (id: string): string => {
    const found = [...positionRefs].find(([, value]) => value === id)?.[0];
    if (found) return found;
    const alias = `P${positionRefs.size + 1}`;
    positionRefs.set(alias, id);
    return alias;
  };
  const aliasEvidence = (id: string): string => {
    const found = [...evidenceRefs].find(([, value]) => value === id)?.[0];
    if (found) return found;
    const alias = `E${evidenceRefs.size + 1}`;
    evidenceRefs.set(alias, id);
    return alias;
  };
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const evidenceById = new Map(graph.evidence.map((evidence) => [evidence.id, evidence]));
  const verificationById = new Map(verifications.verifications.map((item) => [item.claim_id, item]));
  const allowedEvidence = new Map<string, Set<string>>();

  const nodes = graph.claims.filter((claim) => claimIds.has(claim.id)).map((claim) => {
    const evidenceIds = linkedEvidenceIds(graph, claim.id);
    const aliases = new Set(evidenceIds.map(aliasEvidence));
    allowedEvidence.set(claim.id, aliases);
    const positions = claim.position_ids.map((id) => positionById.get(id)!).map((position) => ({
      id: aliasPosition(position.id),
      proposition: position.proposition,
      stance: position.stance,
      reasoning: position.reasoning,
    }));
    const verification = verificationById.get(claim.id);
    return {
      claim_id: claim.id,
      escalation_kind: escalationById.get(claim.id)?.kind,
      proposition: claim.proposition,
      consequence_if_false: claim.if_false,
      your_positions: claim.position_ids
        .filter((id) => positionById.get(id)?.provider === assignment.provider)
        .map((id) => positions.find((position) => position.id === aliasPosition(id))!),
      opposing_positions: claim.position_ids
        .filter((id) => positionById.get(id)?.provider !== assignment.provider)
        .map((id) => positions.find((position) => position.id === aliasPosition(id))!),
      evidence: evidenceIds.flatMap((id) => {
        const evidence = evidenceById.get(id);
        if (!evidence) return [];
        const { provider: _provider, source_id: _sourceId, ...card } = evidence;
        return [{ ...card, id: aliasEvidence(id) }];
      }),
      verification: verification ? {
        ...verification,
        evidence_ids: verification.evidence_ids.map(aliasEvidence),
      } : undefined,
    };
  });

  return {
    prompt: buildRebuttalPrompt(nodes, skill),
    evidenceRefs,
    allowedEvidence,
  };
}

export function buildRebuttalPrompt(nodes: unknown, skill = ''): string {
  return REBUTTAL_PROMPT
    .replace('{{SKILL}}', skill ? `\n\n${skill}` : '')
    .replace('{{NODES_JSON}}', JSON.stringify(nodes, null, 2));
}

function translateEvents(
  graph: DecisionGraph,
  assignment: Assignment,
  input: RebuttalInput,
  output: RebuttalResponseSetT,
  startIndex: number,
): RebuttalEvent[] {
  const expected = new Set(assignment.claim_ids);
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const event of output.events) {
    if (!expected.has(event.claim_id)) issues.push(`unknown claim id: ${event.claim_id}`);
    if (seen.has(event.claim_id)) issues.push(`duplicate claim response: ${event.claim_id}`);
    seen.add(event.claim_id);
    const allowed = input.allowedEvidence.get(event.claim_id) ?? new Set<string>();
    for (const id of event.evidence_ids) if (!allowed.has(id)) issues.push(`invalid evidence id for ${event.claim_id}: ${id}`);
  }
  for (const id of expected) if (!seen.has(id)) issues.push(`missing claim response: ${id}`);
  if (issues.length) throw new StageError('S8b', 'BAD_OUTPUT', issues.join('; '));

  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  return output.events.map((event, index) => ({
    ...event,
    id: `R${startIndex + index + 1}`,
    round: 1 as const,
    responder: assignment.provider,
    target_position_ids: claimById.get(event.claim_id)?.position_ids
      .filter((id) => positionById.get(id)?.provider === assignment.provider) ?? [],
    evidence_ids: event.evidence_ids.map((id) => input.evidenceRefs.get(id)!),
  }));
}

export async function s8bRebuttal(
  ctx: RunCtx,
  graph: DecisionGraph,
  verifications: ClaimVerificationSet,
  mode: RebuttalMode = ctx.mode,
): Promise<RebuttalEventSet> {
  const limits = REBUTTAL_LIMITS[mode];
  const escalations = selectRebuttalEscalations(graph, verifications, { maxNodes: limits.maxNodes });
  const selected_claim_ids = escalations.map((item) => item.claim_id);
  const finish = async (events: RebuttalEvent[], stop_reason: RebuttalEventSet['stop_reason']) => {
    const result = RebuttalEventSetSchema.parse({ round: 1, selected_claim_ids, events, stop_reason });
    await ctx.writer.writeJson('rebuttals', result);
    return result;
  };
  if (escalations.length === 0) return finish([], 'NO_ESCALATIONS');

  const planned = planRebuttalCalls(graph, escalations, ctx.roles.s4, ctx.roles.judge);
  if (planned.length === 0) return finish([], 'NO_ELIGIBLE_SCOUT');
  const optionalCalls = Math.min(limits.optionalCalls, ctx.optionalCallsRemaining());
  if (optionalCalls === 0) {
    const budgetRoom = ctx.budget.limit - ctx.budget.used - IDEA_MODE_PLANS[mode].reservedCalls;
    return finish([], budgetRoom <= 0 ? 'BUDGET_RESERVED' : 'CALL_CAP_REACHED');
  }
  const assignments = planned.slice(0, optionalCalls);
  const escalationById = new Map(escalations.map((item) => [item.claim_id, item]));
  const events: RebuttalEvent[] = [];
  const skill = loadSkill('idea-refinement', 'rebuttal');

  for (const assignment of assignments) {
    const input = rebuttalInput(graph, verifications, escalationById, assignment, skill);
    try {
      const output = await jsonCall(
        ctx,
        ctx.handle(assignment.provider),
        `S8b-${assignment.provider}`,
        input.prompt,
        RebuttalResponseSet,
        { repair: false },
      );
      events.push(...translateEvents(graph, assignment, input, output, events.length));
    } catch (error) {
      if (isFatal(error)) throw error;
    }
  }

  if (planned.length > optionalCalls) return finish(events, 'CALL_CAP_REACHED');
  if (events.length > 0 && events.every((event) => event.evidence_ids.length === 0)) return finish(events, 'NO_NEW_EVIDENCE');
  return finish(events, 'ROUND_COMPLETE');
}
