// S8 — verifier loop (§9, §13). The verifier (codex) independently checks each dispute before the
// judge sees it. Idea-refinement runs a SINGLE pass (the "max 2 iterations" cap is the code-review
// reviewer cross-exam, §313, landing at T10). Disputed items are ANONYMIZED — the verifier sees the
// claim + the argument(s) against it with NO provider labels (§313/§624 anti-self-preference), since
// codex authored some S4 claims. Zero disputes → skip the call entirely. A verifier failure is
// graceful: every item is marked UNCERTAIN ("unverified") and passed to the judge, never an abort (§259).

import type { DisagreementMap, VerificationSet as VerificationSetT } from '../../schemas/index.js';
import { VerificationSet } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

const S8_PROMPT = `ROLE: Verifier. Below are disputed claims, each with the argument(s) against it, from
anonymous sources. For EACH item, independently judge whether the argument defeats the claim.
Output ONLY JSON:
{"verifications": [{"target_id": "<id>", "verdict": "CONFIRM|REFUTE|UNCERTAIN",
  "evidence": "<your own independent reasoning>", "note": "<≤2 sentences>"}]}
CONFIRM = the argument against the claim is supported (the claim is genuinely doubtful).
REFUTE = the argument against the claim is not supported (the claim survives this objection).
UNCERTAIN = the available evidence cannot decide whether the argument holds. Judge each item independently;
do not target any verdict distribution. JSON only, no prose outside it.
ITEMS: {{DISPUTED_ITEMS_JSON}}`;

export function buildVerifierPrompt(map: DisagreementMap): string {
  const claimById = new Map([...map.consensus, ...map.unique].map((claim) => [claim.id, claim.statement]));
  const items = map.contradictions.map((dispute) => ({
    id: dispute.id,
    claim: dispute.claim_ids.map((id) => claimById.get(id) ?? id).join(' / '),
    arguments_against: dispute.attacks.map((attack) => attack.argument),
  }));
  return S8_PROMPT.replace('{{DISPUTED_ITEMS_JSON}}', JSON.stringify(items, null, 2));
}

export async function s8Verify(ctx: RunCtx, map: DisagreementMap): Promise<VerificationSetT> {
  const disputes = map.contradictions;
  if (disputes.length === 0) {
    const empty: VerificationSetT = { verifications: [] };
    await ctx.writer.writeJson('verifications', empty);
    return empty;
  }

  const prompt = buildVerifierPrompt(map);

  try {
    const vset = await jsonCall(ctx, ctx.handle(ctx.roles.verifier), 'S8', prompt, VerificationSet);
    await ctx.writer.writeJson('verifications', vset);
    return vset;
  } catch (e) {
    if (isFatal(e)) throw e; // budget/deadline/abort → abort the run
    // Verifier down / bad output: mark every dispute unverified, pass to the judge as low-confidence.
    const vset: VerificationSetT = {
      verifications: disputes.map((d) => ({
        target_id: d.id,
        verdict: 'UNCERTAIN',
        evidence: '(verifier unavailable — unverified)',
        note: '',
      })),
    };
    await ctx.writer.writeJson('verifications', vset);
    return vset;
  }
}
