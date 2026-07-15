// Seeded-bug scoring for code-review (§17, BENCHMARK.md §3, T11). A seeded bug is ground truth: a
// known defect at a file + line range + category. A reported finding counts as FOUND iff it matches on
// same file + overlapping lines + same category — which is exactly `sameFinding` (the §487 matcher).
// Recall is fully automatic; precision needs FP adjudication (resolve-CR), so it lives elsewhere.

import { z } from 'zod';
import { FindingCategory, type Finding } from '../../schemas/index.js';
import { sameFinding } from '../../orchestration/stages/cr-map.js';

/** One ground-truth seeded bug. `category` is the frozen match key; `class` is a fine, doc-only label. */
export const SeededBug = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  category: FindingCategory,
  class: z.string().optional(), // "off-by-one" | "race" | ... (documentation only)
});
export type SeededBug = z.infer<typeof SeededBug>;

/** The bugs.json in each build case: the seeded defects for its diff. */
export const BugManifest = z.object({ bugs: z.array(SeededBug) });
export type BugManifest = z.infer<typeof BugManifest>;

export interface ScoreResult {
  seeded: number; // total seeded bugs
  matched: number; // seeded bugs found by ≥1 finding
  recall: number; // matched / seeded (0 when seeded === 0)
  matchedRelaxed: number; // same file + overlapping lines, category ignored (L1 diagnostic)
  recallRelaxed: number;
  reported: number; // findings reported by the arm
  unmatched: number; // findings matching no seeded bug — candidate FPs (UNADJUDICATED, not precision)
  matchedBugIds: string[];
}

/** Score one arm's findings against a case's seeded bugs (BENCHMARK.md §3). Pure. */
export function scoreRun(findings: Finding[], bugs: SeededBug[]): ScoreResult {
  const matchedBugIds = bugs.filter((bug) => findings.some((f) => sameFinding(f, bug))).map((b) => b.id);
  const sameLocation = (finding: Finding, bug: SeededBug) =>
    finding.file === bug.file && finding.line_start <= bug.line_end && bug.line_start <= finding.line_end;
  const matchedRelaxed = bugs.filter((bug) => findings.some((finding) => sameLocation(finding, bug))).length;
  const unmatched = findings.filter((f) => !bugs.some((bug) => sameFinding(f, bug))).length;
  return {
    seeded: bugs.length,
    matched: matchedBugIds.length,
    recall: bugs.length === 0 ? 0 : matchedBugIds.length / bugs.length,
    matchedRelaxed,
    recallRelaxed: bugs.length === 0 ? 0 : matchedRelaxed / bugs.length,
    reported: findings.length,
    unmatched,
    matchedBugIds,
  };
}
