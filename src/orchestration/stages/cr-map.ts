// code-review disagreement map (§12.2, T10) — the deterministic analog of idea's S6/S7. Pure.
//
// Two consensus paths (grilled 2026-07-04):
//   1. §487 matcher — both reviewers INDEPENDENTLY flagged the same defect (same file + overlapping
//      lines + same category). Line-anchored, so tractable where idea's prose consensus wasn't.
//   2. cross-exam CONFIRM — the other reviewer agreed a single-authored finding is a genuine defect.
// A cross-exam REFUTE → disputed (adjudicated by S9). UNCERTAIN / unexamined → single-reviewer.
// Findings are reindexed to stable global ids (G1..) because per-reviewer ids ("F1") collide.

import type { AnnotatedFinding, Finding, ReviewMap } from '../../schemas/index.js';
import type { ReviewerFindings } from './cr-s4-review.js';
import type { CrossExam } from './cr-s8-crossexam.js';

const SEV_RANK: Record<Finding['severity'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** §487 matcher: two findings describe the same defect iff same file, overlapping lines, same category. */
export function sameFinding(a: Finding, b: Finding): boolean {
  return a.file === b.file && a.category === b.category && a.line_start <= b.line_end && b.line_start <= a.line_end;
}

export function buildReviewMap(reviewers: ReviewerFindings[], cross: CrossExam): ReviewMap {
  const consensus: AnnotatedFinding[] = [];
  const disputed: AnnotatedFinding[] = [];
  const single: AnnotatedFinding[] = [];

  const [a, b] = reviewers;
  const mergedA = new Set<Finding>();
  const mergedB = new Set<Finding>();

  // Path 1 — §487 independent-consensus merge.
  if (a && b) {
    for (const fa of a.findings) {
      const match = b.findings.find((fb) => !mergedB.has(fb) && sameFinding(fa, fb));
      if (!match) continue;
      mergedA.add(fa);
      mergedB.add(match);
      const rep = SEV_RANK[match.severity] < SEV_RANK[fa.severity] ? match : fa; // keep the higher-severity representative
      consensus.push({ finding: rep, reviewers: [a.provider, b.provider], cross_verdict: 'NONE' });
    }
  }

  // Path 2 — single-authored findings, classified by the OTHER reviewer's cross-exam verdict.
  const classify = (author: ReviewerFindings, skip: Set<Finding>): void => {
    for (const f of author.findings) {
      if (skip.has(f)) continue;
      const cv = cross.get(`${author.provider}/${f.id}`);
      const anno: AnnotatedFinding = { finding: f, reviewers: [author.provider], cross_verdict: cv?.verdict ?? 'NONE' };
      if (cv?.verdict === 'CONFIRM') consensus.push(anno);
      else if (cv?.verdict === 'REFUTE') disputed.push({ ...anno, refutation: cv.note || cv.evidence });
      else single.push(anno); // UNCERTAIN or never examined
    }
  };
  if (a) classify(a, mergedA);
  if (b) classify(b, mergedB);

  // Reindex to stable, unique global ids so S9 can reference disputed items and S10 can match them.
  let n = 0;
  const reindex = (arr: AnnotatedFinding[]): AnnotatedFinding[] => arr.map((af) => ({ ...af, finding: { ...af.finding, id: `G${++n}` } }));

  return {
    consensus: reindex(consensus),
    disputed: reindex(disputed),
    single_reviewer: reindex(single),
    per_reviewer: reviewers.map((r) => ({ provider: r.provider, raised: r.raised, kept: r.findings.length, dropped: r.dropped.length })),
  };
}
