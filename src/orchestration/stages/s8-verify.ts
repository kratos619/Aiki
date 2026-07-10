// S8 — independently verify only genuine disagreements and load-bearing unique positions. Shared
// concerns are settled context, not manufactured debate. All provider identity stays hidden.

import type { DecisionGraph } from '../decision-graph.js';
import { selectEscalations } from '../decision-graph.js';
import type { VerificationSet as VerificationSetT } from '../../schemas/index.js';
import { VerificationSet } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

const S8_PROMPT = `ROLE: Independent verifier. Check each anonymous decision claim below.
For a disagreement, decide which position the available evidence supports. For a unique load-bearing
claim, try to falsify it independently. Output ONLY JSON:
{"verifications": [{"target_id": "<id>", "verdict": "CONFIRM|REFUTE|UNCERTAIN",
  "evidence": "<your independent evidence/reasoning>", "note": "<≤2 sentences>"}]}
CONFIRM = the challenged concern is supported. REFUTE = it is not supported. UNCERTAIN = evidence
cannot decide. Judge each item independently; no verdict quota. JSON only.
ITEMS: {{ITEMS_JSON}}`;

export function buildVerifierPrompt(graph: DecisionGraph): string {
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
  const items = selectEscalations(graph, { max: 8 }).map((escalation) => {
    const claim = graph.claims.find((item) => item.id === escalation.claim_id)!;
    return {
      id: claim.id,
      kind: escalation.kind,
      proposition: claim.proposition,
      positions: claim.position_ids.map((id) => {
        const position = positionById.get(id)!;
        return { stance: position.stance, reasoning: position.reasoning };
      }),
    };
  });
  return S8_PROMPT.replace('{{ITEMS_JSON}}', JSON.stringify(items, null, 2));
}

export async function s8Verify(ctx: RunCtx, graph: DecisionGraph): Promise<VerificationSetT> {
  const escalations = selectEscalations(graph, { max: 8 });
  if (escalations.length === 0) {
    const empty: VerificationSetT = { verifications: [] };
    await ctx.writer.writeJson('verifications', empty);
    return empty;
  }

  try {
    const result = await jsonCall(ctx, ctx.handle(ctx.roles.verifier), 'S8', buildVerifierPrompt(graph), VerificationSet);
    await ctx.writer.writeJson('verifications', result);
    return result;
  } catch (error) {
    if (isFatal(error)) throw error;
    const unavailable: VerificationSetT = {
      verifications: escalations.map((escalation) => ({
        target_id: escalation.claim_id,
        verdict: 'UNCERTAIN',
        evidence: '(verifier unavailable — unverified)',
        note: '',
      })),
    };
    await ctx.writer.writeJson('verifications', unavailable);
    return unavailable;
  }
}
