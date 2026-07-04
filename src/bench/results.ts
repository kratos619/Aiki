// Bench result schema (§17, BENCHMARK.md §5, T11). Per-case per-arm scores + a summary, written to
// bench/results/<suite>-<date>.json. Precision is nullable — it needs FP adjudication (resolve-CR), which
// happens after the run; recall/calls/wall-clock are automatic. Aggregate recall is MICRO (grill 2026-07-04).

import { z } from 'zod';

export const ArmScore = z.object({
  arm: z.enum(['A', 'B', 'C', 'D']),
  status: z.enum(['scored', 'skipped', 'error']),
  reason: z.string().optional(), // why skipped / the error message
  runId: z.string().optional(),
  seeded: z.number().int().nonnegative().optional(),
  matched: z.number().int().nonnegative().optional(),
  recall: z.number().optional(),
  reported: z.number().int().nonnegative().optional(),
  unmatched: z.number().int().nonnegative().optional(), // candidate FPs, UNADJUDICATED
  precision: z.number().nullable().optional(), // null until FP-labelled via resolve
  calls: z.number().int().nonnegative().optional(),
  wallMs: z.number().nonnegative().optional(),
});
export type ArmScore = z.infer<typeof ArmScore>;

export const CaseResult = z.object({
  case: z.string(),
  seeded: z.number().int().nonnegative(),
  arms: z.array(ArmScore),
});
export type CaseResult = z.infer<typeof CaseResult>;

/** Per-arm rollup across all cases. `recall` = micro (total matched / total seeded); `recallMacro` = mean of per-case. */
export const SummaryRow = z.object({
  arm: z.enum(['A', 'B', 'C', 'D']),
  cases: z.number().int().nonnegative(), // scored cases
  seeded: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  recall: z.number(), // micro
  recallMacro: z.number(),
  reported: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  precision: z.number().nullable(), // micro precision if any labels, else null
  calls: z.number().int().nonnegative(),
  wallMs: z.number().nonnegative(),
});
export type SummaryRow = z.infer<typeof SummaryRow>;

export const BenchResult = z.object({
  suite: z.string(),
  set: z.string(),
  at: z.string(),
  arms: z.array(z.enum(['A', 'B', 'C', 'D'])),
  cases: z.array(CaseResult),
  summary: z.array(SummaryRow),
});
export type BenchResult = z.infer<typeof BenchResult>;

/** Roll per-case arm scores up into the per-arm summary (micro recall, macro shown alongside). */
export function summarize(cases: CaseResult[], arms: BenchResult['arms']): SummaryRow[] {
  return arms.map((arm) => {
    const scored = cases.flatMap((c) => c.arms.filter((a) => a.arm === arm && a.status === 'scored'));
    const sum = (pick: (a: ArmScore) => number) => scored.reduce((s, a) => s + pick(a), 0);
    const seeded = sum((a) => a.seeded ?? 0);
    const matched = sum((a) => a.matched ?? 0);
    const reported = sum((a) => a.reported ?? 0);
    const recallMacro = scored.length ? scored.reduce((s, a) => s + (a.recall ?? 0), 0) / scored.length : 0;
    const precisions = scored.map((a) => a.precision).filter((p): p is number => typeof p === 'number');
    return {
      arm,
      cases: scored.length,
      seeded,
      matched,
      recall: seeded ? matched / seeded : 0,
      recallMacro,
      reported,
      unmatched: sum((a) => a.unmatched ?? 0),
      precision: precisions.length ? precisions.reduce((s, p) => s + p, 0) / precisions.length : null,
      calls: sum((a) => a.calls ?? 0),
      wallMs: sum((a) => a.wallMs ?? 0),
    };
  });
}
