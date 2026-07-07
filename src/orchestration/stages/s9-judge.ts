// S9 — judge synthesis (§9, §13). The judge (claude) adjudicates DISPUTED items only; consensus is
// already settled (S7 grouping) and passes through untouched. Two guards beyond the schema:
//   1. Anti-blending (§260, the §602 acceptance test): the judge may reference ONLY disputed ids in
//      `adjudications` — never a consensus id. `adjudicationScopeViolations` (pure) detects this; the
//      stage re-asks once, then filters any still-invalid adjudications out and flags the run.
//   2. Mandatory dissent (§260): empty dissent → re-ask once → else flag `synthesis_suspect` and
//      inject a placeholder so the report still renders (continue, not abort).
// Confidence is NOT taken from the judge here — the held/failed/unverified audit + HIGH/MED/LOW labels
// are derived deterministically at S10 (§624: confidence from cross-model confirmation, not self-report).

import type { DisagreementMap, IntentContract, JudgeReport as JudgeReportT, VerificationSet } from '../../schemas/index.js';
import { JudgeReportModel } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { RubricItem } from './s7-disagreement.js';

type Adjudication = JudgeReportT['adjudications'][number];

const S9_PROMPT = `ROLE: Judge. You adjudicate ONLY the disputed items below. Consensus items are already
settled; do not restate, edit, re-litigate, or reference them in your adjudications.
Apply this rubric strictly: {{RUBRIC_JSON}}

You are the CHAIRMAN of the panel. Write for a decision-maker who did not see the debate — be clear,
specific, and professional. No hedging mush, no restating the question back.

Output ONLY JSON matching the judge schema:
- adjudications: for EACH disputed id → {id, ruling: UPHOLD|REJECT|UNRESOLVED, reasoning ≤3 sentences, evidence_cited}.
  UPHOLD = the argument defeats the claim; REJECT = the claim survives; UNRESOLVED = genuinely undecided.
- verdict: 2-5 sentences — your clear recommendation (proceed / proceed-if / don't) and the single most
  important reason. Grounded ONLY in adjudicated + consensus claims.
- key_points: 4-8 bullets — the reasoning a decision-maker needs, in plain language. Cover: what decided
  it, the decisive trade-offs, where the analysts DISAGREED and whose side you took and why, and the one
  thing that would most change the verdict. Each bullet a full standalone point, not a fragment.
- dissent: ≥1 item — the strongest argument AGAINST your own verdict. Empty dissent is invalid.
- confidence_notes: which conclusions are HIGH/MEDIUM/LOW and why.
DISPUTED ITEMS + VERIFICATION: {{DISPUTES_JSON}}
CONSENSUS (context only, read-only): {{CONSENSUS_JSON}}`;

/** Pure anti-blending validator: adjudication ids that are NOT disputed items (the judge trying to
 *  touch consensus). Empty = clean. This is the heart of the §602 "rejects consensus edits" test. */
export function adjudicationScopeViolations(report: { adjudications: Array<{ id: string }> }, disputeIds: Iterable<string>): string[] {
  const allowed = new Set(disputeIds);
  return report.adjudications.map((a) => a.id).filter((id) => !allowed.has(id));
}

/** §272 2-provider demotion (pure). When the judge is also an S4 author (only happens with 2
 *  providers), any adjudication on a dispute whose contested claim was authored SOLELY by the judge's
 *  provider is forced to `UNRESOLVED` — the judge may not confirm its own claim; it stays for the
 *  human. A no-op with 3 providers, where the judge (claude) authored no S4 claim. */
export function demoteSelfAuthored(adjudications: Adjudication[], map: DisagreementMap, judgeProvider: ProviderId): Adjudication[] {
  const claimProviders = new Map<string, ProviderId[]>();
  for (const c of [...map.consensus, ...map.unique]) claimProviders.set(c.id, c.providers);
  const disputeClaims = new Map(map.contradictions.map((d) => [d.id, d.claim_ids]));
  return adjudications.map((a) => {
    const cids = disputeClaims.get(a.id) ?? [];
    const soleJudge = cids.length > 0 && cids.every((cid) => {
      const ps = claimProviders.get(cid) ?? [];
      return ps.length === 1 && ps[0] === judgeProvider;
    });
    return soleJudge && a.ruling !== 'UNRESOLVED' ? { ...a, ruling: 'UNRESOLVED' as const } : a;
  });
}

export async function s9Judge(
  ctx: RunCtx,
  contract: IntentContract,
  map: DisagreementMap,
  verifications: VerificationSet,
  rubric: RubricItem[],
): Promise<JudgeReportT> {
  const claimById = new Map<string, string>();
  for (const c of [...map.consensus, ...map.unique]) claimById.set(c.id, c.statement);
  const verdictById = new Map(verifications.verifications.map((v) => [v.target_id, v.verdict]));

  const disputes = map.contradictions.map((d) => ({
    id: d.id,
    claim: d.claim_ids.map((cid) => claimById.get(cid) ?? cid).join(' / '),
    arguments_against: d.attacks.map((a) => a.argument),
    verifier_verdict: verdictById.get(d.id) ?? 'UNVERIFIED',
  }));
  const consensus = map.consensus.map((c) => ({ id: c.id, statement: c.statement }));
  const disputeIds = map.contradictions.map((d) => d.id);

  const basePrompt = S9_PROMPT.replace('{{RUBRIC_JSON}}', JSON.stringify(rubric.map((r) => r.label)))
    .replace('{{DISPUTES_JSON}}', JSON.stringify(disputes, null, 2))
    .replace('{{CONSENSUS_JSON}}', JSON.stringify(consensus, null, 2))
    // reference the contract task so the verdict stays anchored to what the user asked
    .concat(`\nTASK: ${contract.task}`);

  const judge = ctx.handle(ctx.roles.judge);
  let report = await jsonCall(ctx, judge, 'S9', basePrompt, JudgeReportModel);

  // Semantic guards beyond the schema → one targeted re-ask.
  let violations = adjudicationScopeViolations(report, disputeIds);
  if (violations.length || report.dissent.length === 0) {
    const fix =
      `${basePrompt}\n\n---\nYour previous output had problems:\n` +
      (violations.length ? `- adjudications must reference ONLY these disputed ids [${disputeIds.join(', ')}]; not: ${violations.join(', ')}\n` : '') +
      (report.dissent.length === 0 ? `- dissent must contain at least one item.\n` : '') +
      `Output ONLY the corrected JSON.`;
    try {
      report = await jsonCall(ctx, judge, 'S9-repair', fix, JudgeReportModel);
      violations = adjudicationScopeViolations(report, disputeIds);
    } catch (e) {
      if (isFatal(e)) throw e; // keep the first report on a non-fatal repair failure
    }
  }

  // Enforce after the re-ask: drop any still-out-of-scope adjudications; guarantee non-empty dissent.
  const inScope = report.adjudications.filter((a) => new Set(disputeIds).has(a.id));
  if (inScope.length !== report.adjudications.length) ctx.addFlag('synthesis_suspect');
  // §272: if the judge authored a contested claim (2-provider only), it can't confirm it → UNRESOLVED.
  const adjudications = demoteSelfAuthored(inScope, map, ctx.roles.judge);
  let dissent = report.dissent;
  if (dissent.length === 0) {
    ctx.addFlag('synthesis_suspect');
    dissent = ['(none produced — flagged synthesis_suspect)'];
  }

  const final: JudgeReportT = { ...report, adjudications, dissent };
  await ctx.writer.writeJson('judge-report', final);
  return final;
}
