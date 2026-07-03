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
CONFIRM = the argument holds (the claim is genuinely doubtful). REFUTE = the argument fails (the claim
stands). Rules: you MUST issue at least one REFUTE, or set "all_confirmed_justification" explaining why
every claim survives. JSON only, no prose outside it.
ITEMS: {{DISPUTED_ITEMS_JSON}}`;

export async function s8Verify(ctx: RunCtx, map: DisagreementMap): Promise<VerificationSetT> {
  const disputes = map.contradictions;
  if (disputes.length === 0) {
    const empty: VerificationSetT = { verifications: [] };
    await ctx.writer.writeJson('verifications', empty);
    return empty;
  }

  // Anonymized disputed items: claim text + argument text only, no provider attribution.
  const claimById = new Map<string, string>();
  for (const c of [...map.consensus, ...map.unique]) claimById.set(c.id, c.statement);
  const items = disputes.map((d) => ({
    id: d.id,
    claim: d.claim_ids.map((cid) => claimById.get(cid) ?? cid).join(' / '),
    arguments_against: d.attacks.map((a) => a.argument),
  }));
  const prompt = S8_PROMPT.replace('{{DISPUTED_ITEMS_JSON}}', JSON.stringify(items, null, 2));

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
