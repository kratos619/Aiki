// code-review S8 — mutual cross-exam (§12.2, T10). Each reviewer receives the OTHER reviewer's
// findings ANONYMIZED ("the other reviewer") and rules CONFIRM / REFUTE / UNCERTAIN per finding, with
// its own evidence. Two calls (skip a side whose target has 0 findings, §grill). "Must REFUTE or
// downgrade ≥1, or the run is flagged" is prompt-enforced + soft-checked (raises synthesis_suspect; no
// re-ask). Verdict meaning here is finding-centric: CONFIRM = genuine defect, REFUTE = false positive.

import type { ProviderId } from '../../providers/types.js';
import type { Verification, VerificationSet as VerificationSetT } from '../../schemas/index.js';
import { VerificationSet } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { ReviewerFindings } from './cr-s4-review.js';

const S8_PROMPT = `ROLE: Senior code reviewer performing a peer cross-examination. Below are findings from
ANOTHER reviewer (source withheld). For EACH finding, independently judge whether it is a genuine defect
in the code — investigate the referenced file:lines yourself before deciding.
Output ONLY JSON:
{"verifications": [{"target_id": "<finding id>", "verdict": "CONFIRM|REFUTE|UNCERTAIN",
  "evidence": "<your own independent reasoning about the code>", "note": "<≤2 sentences>"}]}
CONFIRM = a real defect worth reporting. REFUTE = a false positive / not a genuine issue. UNCERTAIN =
cannot determine. Rules: you MUST REFUTE or downgrade at least one finding, OR set
"all_confirmed_justification" explaining why every finding is genuinely valid. JSON only, no prose outside it.
FINDINGS TO EXAMINE: {{FINDINGS_JSON}}`;

/** The other reviewer's cross-exam verdict on a finding, keyed by `${authorProvider}/${finding.id}`. */
export type CrossExam = Map<string, { verdict: Verification['verdict']; note: string; evidence: string; examiner: ProviderId }>;

/** S8 result: the keyed verdict lookup + the flat verifications for the 08 artifact. Cross-exam does
 *  NOT write its own artifact — the workflow writes 07-review-map (built from this) BEFORE
 *  08-verifications so the artifact writer's ascending-order rule holds. */
export interface CrossExamResult {
  byKey: CrossExam;
  verifications: Verification[];
}

/** Anonymized view of a reviewer's findings for the examiner (no provider attribution, no self_confidence). */
function anonymize(author: ReviewerFindings): unknown[] {
  return author.findings.map((f) => ({ id: f.id, file: f.file, line_start: f.line_start, line_end: f.line_end, severity: f.severity, category: f.category, claim: f.claim, evidence: f.evidence }));
}

async function examine(ctx: RunCtx, examiner: ProviderId, author: ReviewerFindings): Promise<VerificationSetT | null> {
  const prompt = S8_PROMPT.replace('{{FINDINGS_JSON}}', JSON.stringify(anonymize(author), null, 2));
  try {
    // Examiner runs at repo-root cwd (default) so it can investigate the code; it's a verified read-only reviewer.
    return await jsonCall(ctx, ctx.handle(examiner), `S8-${examiner}`, prompt, VerificationSet);
  } catch (e) {
    if (isFatal(e)) throw e; // budget/deadline/abort → abort the run
    return null; // examiner down / bad output → treat as "no cross-exam" (findings stay single-reviewer)
  }
}

export async function s8CrossExam(ctx: RunCtx, reviewers: ReviewerFindings[]): Promise<CrossExamResult> {
  const byKey: CrossExam = new Map();
  const all: Verification[] = [];

  // Cross-exam is defined for exactly two reviewers examining each other. With <2 (a single survivor)
  // there is nothing to cross-examine; write an empty artifact and leave every finding single-reviewer.
  if (reviewers.length === 2) {
    const [a, b] = reviewers as [ReviewerFindings, ReviewerFindings];
    for (const [examiner, author] of [[a, b], [b, a]] as Array<[ReviewerFindings, ReviewerFindings]>) {
      if (author.findings.length === 0) continue; // skip-empty (nothing to examine)
      const vset = await examine(ctx, examiner.provider, author);
      if (!vset) continue;
      const known = new Set(author.findings.map((f) => f.id));
      const graded = vset.verifications.filter((v) => known.has(v.target_id));
      // "refute/downgrade ≥1 or flagged": rubber-stamp (all CONFIRM, no justification) → soft flag.
      const rubberStamp = graded.length > 0 && graded.every((v) => v.verdict === 'CONFIRM') && !vset.all_confirmed_justification;
      if (rubberStamp) ctx.addFlag('synthesis_suspect');
      for (const v of graded) {
        byKey.set(`${author.provider}/${v.target_id}`, { verdict: v.verdict, note: v.note, evidence: v.evidence, examiner: examiner.provider });
        all.push({ ...v, target_id: `${author.provider}/${v.target_id}` }); // namespace for the artifact (ids collide across reviewers)
      }
    }
  }

  // NB: the 08-verifications artifact is written by the workflow AFTER 07-review-map (ascending order).
  return { byKey, verifications: all };
}
