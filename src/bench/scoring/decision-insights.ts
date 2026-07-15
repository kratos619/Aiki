import { z } from 'zod';

export const DecisionStance = z.enum(['SUPPORT', 'OPPOSE', 'QUALIFY', 'UNRESOLVED']);
export type DecisionStance = z.infer<typeof DecisionStance>;
export const FactKind = z.enum(['CURRENT_FACT', 'DURABLE_FACT', 'INFERENCE']);
export type FactKind = z.infer<typeof FactKind>;
export const EvidenceStatus = z.enum(['SUPPORTED', 'UNSUPPORTED', 'NOT_REQUIRED']);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

export const ExpectedDecisionClaim = z.object({
  id: z.string().min(1),
  proposition: z.string().min(1),
  acceptable_stances: z.array(DecisionStance).min(1),
  evidence_required: z.boolean(),
});

export const DecisionInsightAdjudication = z.object({
  expected_claims: z.array(ExpectedDecisionClaim),
  report_claims: z.array(z.object({
    id: z.string().min(1),
    stance: DecisionStance,
    fact_kind: FactKind,
    correct: z.boolean(),
    relevant: z.boolean(),
    evidence_status: EvidenceStatus,
  })),
  matches: z.array(z.object({
    expected_claim_id: z.string().min(1),
    report_claim_id: z.string().min(1),
  })),
}).superRefine((input, ctx) => {
  const expectedIds = new Set(input.expected_claims.map((claim) => claim.id));
  const reportIds = new Set(input.report_claims.map((claim) => claim.id));
  if (expectedIds.size !== input.expected_claims.length || reportIds.size !== input.report_claims.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expert and report claim ids must be unique' });
  }
  const expected = new Set<string>();
  const reported = new Set<string>();
  for (const match of input.matches) {
    if (!expectedIds.has(match.expected_claim_id) || !reportIds.has(match.report_claim_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'claim matches must reference declared claim ids' });
    }
    if (expected.has(match.expected_claim_id) || reported.has(match.report_claim_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'claim matches must be one-to-one' });
    }
    expected.add(match.expected_claim_id);
    reported.add(match.report_claim_id);
  }
});
export type DecisionInsightAdjudication = z.infer<typeof DecisionInsightAdjudication>;

export const IdeaV3CaseManifest = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  set: z.enum(['build', 'holdout']),
  provenance: z.enum(['INSPECTED_BUILD', 'AUTHORED_BUILD', 'SEALED_HOLDOUT']),
  tags: z.array(z.string().min(1)).min(1),
  input_file: z.string().min(1),
  critical_claims: z.array(ExpectedDecisionClaim).min(1),
  common_false_claims: z.array(z.object({
    id: z.string().min(1),
    claim: z.string().min(1),
    reason: z.string().min(1),
  })),
  required_dimensions: z.array(z.string().min(1)).length(12),
  source_pack: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    as_of: z.string().min(1),
    url: z.string().url().optional(),
    local_file: z.string().min(1).optional(),
  })),
  acceptable_unresolved_outcomes: z.array(z.object({
    claim_id: z.string().min(1),
    reason: z.string().min(1),
  })),
});
export type IdeaV3CaseManifest = z.infer<typeof IdeaV3CaseManifest>;

export interface DecisionInsightScore {
  expected: number;
  matched: number;
  reported: number;
  true_positive_reports: number;
  recall: number;
  precision: number;
  f1: number;
}

/** Score one blinded, human-adjudicated idea report. */
export function scoreDecisionInsights(input: DecisionInsightAdjudication): DecisionInsightScore {
  input = DecisionInsightAdjudication.parse(input);
  const reportById = new Map(input.report_claims.map((claim) => [claim.id, claim]));
  const isTruePositive = (claim: DecisionInsightAdjudication['report_claims'][number]) =>
    claim.correct && claim.relevant && (claim.fact_kind !== 'CURRENT_FACT' || claim.evidence_status === 'SUPPORTED');
  const truePositiveReports = input.report_claims.filter(isTruePositive).length;
  const matched = input.matches.filter((match) => {
    const expected = input.expected_claims.find((claim) => claim.id === match.expected_claim_id);
    const report = reportById.get(match.report_claim_id);
    return expected && report && isTruePositive(report) && expected.acceptable_stances.includes(report.stance)
      && (!expected.evidence_required || report.evidence_status === 'SUPPORTED');
  }).length;
  const recall = input.expected_claims.length ? matched / input.expected_claims.length : 0;
  const precision = input.report_claims.length ? truePositiveReports / input.report_claims.length : 0;
  return {
    expected: input.expected_claims.length,
    matched,
    reported: input.report_claims.length,
    true_positive_reports: truePositiveReports,
    recall,
    precision,
    f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0,
  };
}

/** Micro-average case scores by summing claim counts before calculating rates. */
export function summarizeDecisionInsights(scores: DecisionInsightScore[]): DecisionInsightScore {
  const sum = (key: 'expected' | 'matched' | 'reported' | 'true_positive_reports') =>
    scores.reduce((total, score) => total + score[key], 0);
  const expected = sum('expected');
  const matched = sum('matched');
  const reported = sum('reported');
  const truePositiveReports = sum('true_positive_reports');
  const recall = expected ? matched / expected : 0;
  const precision = reported ? truePositiveReports / reported : 0;
  return {
    expected,
    matched,
    reported,
    true_positive_reports: truePositiveReports,
    recall,
    precision,
    f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0,
  };
}
