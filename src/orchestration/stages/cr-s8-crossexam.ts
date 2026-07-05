// code-review S8 — mutual cross-exam (§12.2, T10; teeth added V1). Each reviewer receives the OTHER
// reviewer's findings ANONYMIZED ("the other reviewer") and rules CONFIRM / REFUTE / UNCERTAIN per
// finding, with its own evidence. The prompt forces an adversarial pass: rank weakest-first, actively
// try to refute the weakest with file:line evidence, REFUTE only with evidence else UNCERTAIN. A
// rubber stamp (all CONFIRM, no weakest-first justification) triggers ONE sharper re-ask (mirrors S9);
// if it still rubber-stamps, raise synthesis_suspect. Two exams (skip a side whose target has 0
// findings, §grill). Verdict is finding-centric: CONFIRM = genuine defect, REFUTE = false positive.

import type { ProviderId } from '../../providers/types.js';
import type { Verification, VerificationSet as VerificationSetT } from '../../schemas/index.js';
import { VerificationSet } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import type { ReviewerFindings } from './cr-s4-review.js';

const S8_PROMPT = `ROLE: Senior code reviewer performing a peer cross-examination. Below are findings from
ANOTHER reviewer (source withheld). Your job is to CHALLENGE them, not rubber-stamp them.

Do ALL of the following, in order:
1. Rank the findings from WEAKEST (most likely a false positive) to strongest.
2. Take the weakest finding — and any other you doubt — and actively try to REFUTE it: open the
   referenced file:lines yourself and look for a concrete reason the reported defect is NOT real
   (guarded upstream, unreachable path, misread line, wrong category, already-correct code).
3. Decide each verdict:
   - REFUTE only when you have concrete file:line evidence it is a false positive.
   - If you doubt a finding but cannot prove it false, use UNCERTAIN and state the specific doubt.
   - CONFIRM only a finding you genuinely could not weaken.

Output ONLY JSON:
{"verifications": [{"target_id": "<finding id>", "verdict": "CONFIRM|REFUTE|UNCERTAIN",
  "evidence": "<your own file:line reasoning>", "note": "<≤2 sentences>"}]}
CONFIRM = a real defect worth reporting. REFUTE = a false positive / not a genuine issue. UNCERTAIN =
cannot determine. If — and ONLY if — every finding survives your attack and you CONFIRM them all, you
MUST set "all_confirmed_justification" naming the single weakest finding and the file:line reason it
still holds. JSON only, no prose outside it.
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

async function callExam(ctx: RunCtx, examiner: ProviderId, label: string, prompt: string): Promise<VerificationSetT | null> {
  try {
    // Examiner runs at repo-root cwd (default) so it can investigate the code; it's a verified read-only reviewer.
    return await jsonCall(ctx, ctx.handle(examiner), label, prompt, VerificationSet);
  } catch (e) {
    if (isFatal(e)) throw e; // budget/deadline/abort → abort the run
    return null; // examiner down / bad output → treat as "no cross-exam" (findings stay single-reviewer)
  }
}

/** Rubber stamp = confirmed everything without the mandatory weakest-first justification. The teeth we
 *  want are a REFUTE/UNCERTAIN (a genuine pushback) OR, if all really do hold, the justification. */
function isRubberStamp(graded: Verification[], vset: VerificationSetT): boolean {
  return graded.length > 0 && graded.every((v) => v.verdict === 'CONFIRM') && !vset.all_confirmed_justification;
}

/** One cross-exam: initial call, then — on a rubber stamp — one sharper re-ask (mirrors S9's retry).
 *  Returns the accepted verification set (the pushed-back re-ask if it improved, else the original) and
 *  whether it is STILL a rubber stamp so the caller can flag `synthesis_suspect`. */
async function examine(
  ctx: RunCtx,
  examiner: ProviderId,
  author: ReviewerFindings,
): Promise<{ vset: VerificationSetT; graded: Verification[]; rubberStamp: boolean } | null> {
  const prompt = S8_PROMPT.replace('{{FINDINGS_JSON}}', JSON.stringify(anonymize(author), null, 2));
  const vset = await callExam(ctx, examiner, `S8-${examiner}`, prompt);
  if (!vset) return null;

  const known = new Set(author.findings.map((f) => f.id));
  const graded = vset.verifications.filter((v) => known.has(v.target_id));
  if (!isRubberStamp(graded, vset)) return { vset, graded, rubberStamp: false };

  // Rubber stamp → one sharper re-ask. Accept it only if it actually pushed back (a non-CONFIRM verdict)
  // or supplied the missing weakest-first justification; otherwise keep the original and flag.
  const fix =
    `${prompt}\n\n---\nYour previous cross-examination CONFIRMED every finding and gave no weakest-first ` +
    `justification — that reads as a rubber stamp, not a peer cross-examination. Re-examine: rank the ` +
    `findings weakest-first, open the file:lines of the single weakest, and either REFUTE it with concrete ` +
    `evidence or mark it UNCERTAIN with the specific doubt. If every finding truly survives, set ` +
    `"all_confirmed_justification" naming the weakest and the file:line reason it holds. Output ONLY the corrected JSON.`;
  const retry = await callExam(ctx, examiner, `S8-${examiner}-repair`, fix);
  if (retry) {
    const rg = retry.verifications.filter((v) => known.has(v.target_id));
    if (!isRubberStamp(rg, retry)) return { vset: retry, graded: rg, rubberStamp: false };
  }
  return { vset, graded, rubberStamp: true };
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
      const result = await examine(ctx, examiner.provider, author);
      if (!result) continue;
      const { graded, rubberStamp } = result;
      // A rubber stamp that survived the sharper re-ask stays flagged (still no pushback, no justification).
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
