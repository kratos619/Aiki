import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import type { ProviderId } from '../providers/types.js';
import {
  DecisionInsightAdjudication,
  scoreDecisionInsights,
  summarizeDecisionInsights,
} from './scoring/decision-insights.js';
import {
  assertIdeaV3Set,
  findLatestIdeaV3Campaign,
  IDEA_V3_ARM_IDS,
  IDEA_V3_CALLS_PER_CASE,
  IdeaV3Campaign,
  IdeaV3Protocol,
  ideaV3FreezeHashes,
  loadIdeaV3Cases,
  type IdeaV3Arm,
  type IdeaV3BenchCase,
} from './idea-v3-bench.js';

const RaterReportTemplate = z.object({
  report_id: z.string().min(1),
  claim_ratings: z.array(z.object({
    report_claim_id: z.string().min(1),
    claim_text: z.string().min(1),
    load_bearing: z.boolean(),
    correct: z.boolean(),
    relevant: z.boolean(),
    fact_kind: z.enum(['CURRENT_FACT', 'DURABLE_FACT', 'INFERENCE']),
    evidence_status: z.enum(['SUPPORTED', 'UNSUPPORTED', 'NOT_REQUIRED']),
    stance: z.enum(['SUPPORT', 'OPPOSE', 'QUALIFY', 'UNRESOLVED']),
    matched_expected_claim_id: z.string().min(1).nullable(),
  }).strict()),
  action_ratings: z.array(z.object({
    action_index: z.number().int().positive(),
    complete: z.boolean(),
    actionability_1_to_5: z.number().int().min(1).max(5),
  }).strict()),
  citation_checks: z.array(z.object({ citation: z.string().min(1), supports_exact_claim: z.boolean() }).strict()),
  coverage: z.array(z.object({ dimension: z.string().min(1), status: z.enum(['ASSESSED', 'NOT_APPLICABLE', 'MISSING_EVIDENCE', 'MISSING']) }).strict()),
  disagreement_checks: z.array(z.object({ item: z.string().min(1), genuine_same_proposition_opposition: z.boolean() }).strict()),
  honesty_violations: z.array(z.string().min(1)),
  preference_rank: z.number().int().positive().nullable(),
}).strict();

export const IdeaV3RaterFile = z.object({
  benchmark: z.literal('idea-v3'),
  set: z.enum(['build', 'holdout']),
  rater_id: z.string().min(1),
  locked: z.boolean(),
  cases: z.array(z.object({
    case_id: z.string().min(1),
    reports: z.array(RaterReportTemplate),
  }).strict()),
}).strict();

const BlindMapping = z.object({
  campaign: z.string().min(1),
  private: z.literal(true),
  mapping: z.array(z.object({
    rater_id: z.string().min(1),
    case_id: z.string().min(1),
    report_id: z.string().min(1),
    arm: z.enum(IDEA_V3_ARM_IDS),
    run_id: z.string().min(1),
    order: z.number().int().positive(),
  }).strict()),
}).strict();

const SecondaryGateCounts = z.object({
  factual_claims: z.object({ eligible: z.number().int().nonnegative(), honest_or_supported: z.number().int().nonnegative() }).strict(),
  citations: z.object({ total: z.number().int().nonnegative(), exact_support: z.number().int().nonnegative() }).strict(),
  coverage: z.object({ required: z.number().int().nonnegative(), accounted: z.number().int().nonnegative() }).strict(),
  disagreements: z.object({ labeled: z.number().int().nonnegative(), genuine: z.number().int().nonnegative() }).strict(),
  actions: z.object({ total: z.number().int().nonnegative(), complete: z.number().int().nonnegative(), score_4_or_5: z.number().int().nonnegative() }).strict(),
  honesty_violations: z.number().int().nonnegative(),
}).strict().superRefine((counts, ctx) => {
  const pairs: Array<[number, number, string]> = [
    [counts.factual_claims.honest_or_supported, counts.factual_claims.eligible, 'factual_claims'],
    [counts.citations.exact_support, counts.citations.total, 'citations'],
    [counts.coverage.accounted, counts.coverage.required, 'coverage'],
    [counts.disagreements.genuine, counts.disagreements.labeled, 'disagreements'],
    [counts.actions.complete, counts.actions.total, 'actions.complete'],
    [counts.actions.score_4_or_5, counts.actions.total, 'actions.score_4_or_5'],
  ];
  for (const [part, total, path] of pairs) {
    if (part > total) ctx.addIssue({ code: z.ZodIssueCode.custom, path: path.split('.'), message: 'count cannot exceed total' });
  }
});

export const IdeaV3RatingResolution = z.object({
  benchmark: z.literal('idea-v3'),
  set: z.enum(['build', 'holdout']),
  mapping_file: z.string().min(1),
  raw_rating_files: z.array(z.string().min(1)).min(3),
  reports: z.array(z.object({
    case_id: z.string().min(1),
    arm: z.enum(IDEA_V3_ARM_IDS),
    adjudication: DecisionInsightAdjudication,
    secondary: SecondaryGateCounts,
  }).strict()),
}).strict();

const DecisionInsightScoreSchema = z.object({
  expected: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  reported: z.number().int().nonnegative(),
  true_positive_reports: z.number().int().nonnegative(),
  recall: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
}).strict();

export const IdeaV3ScoredCampaign = z.object({
  version: z.literal(1),
  at: z.string().min(1),
  campaign: z.string().min(1),
  set: z.enum(['build', 'holdout']),
  raw_ratings: z.array(z.object({ rater_id: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(3),
  reports: z.array(z.object({
    case_id: z.string().min(1),
    arm: z.enum(IDEA_V3_ARM_IDS),
    score: DecisionInsightScoreSchema,
    secondary: SecondaryGateCounts,
  }).strict()),
  summary: z.array(z.object({ arm: z.enum(IDEA_V3_ARM_IDS), score: DecisionInsightScoreSchema }).strict()),
  pairwise_preferences: z.array(z.object({
    case_id: z.string().min(1),
    left: z.enum(IDEA_V3_ARM_IDS),
    right: z.enum(IDEA_V3_ARM_IDS),
    left_votes: z.number().int().nonnegative(),
    right_votes: z.number().int().nonnegative(),
    winner: z.enum(IDEA_V3_ARM_IDS).nullable(),
  }).strict()),
}).strict();
export type IdeaV3ScoredCampaign = z.infer<typeof IdeaV3ScoredCampaign>;

function blindId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase();
}

/** Remove the explicit identifiers forbidden by BENCHMARK-IDEA-V3.md §4 before human rating. §4 bars
 *  provider/model names, run ids, arm labels, AND costs — so the dossier's "Run details" cost
 *  block (mode, call counts, categories, per-provider calls, model time, degradation flags) and the
 *  inline `> ⚠ DEGRADED: <flag tokens>` callouts are redacted too; the DEGRADED marker and any prose
 *  note stay, since those are quality self-assessments raters legitimately read. */
export function blindIdeaV3Report(report: string, runId: string, caseDir?: string): string {
  const withoutCasePath = caseDir ? report.replaceAll(caseDir, '[case-source]') : report;
  return withoutCasePath
    .replaceAll(runId, '[redacted-run]')
    .replace(/\bClaude\b|\bclaude\b/g, 'Model Alpha')
    .replace(/\bCodex\b|\bcodex\b/g, 'Model Beta')
    .replace(/\bGemini\b|\bagy\b/g, 'Model Gamma')
    .replace(/^(- Report ID:).*$/gm, '$1 [redacted]')
    .replace(/^(- Generated:).*$/gm, '$1 [redacted]')
    .replace(/^(- Models and roles:).*$/gm, '$1 [redacted]')
    .replace(/^(- (?:Mode|Provider calls|Categories|By provider|Recorded model time|Tokens|Degradation flags):).*$/gm, '$1 [redacted]')
    .replace(/^(> ⚠ DEGRADED): [a-z0-9_]+(?:, [a-z0-9_]+)*\.?$/gm, '$1 [redacted]');
}

async function renderCasePacket(item: IdeaV3BenchCase): Promise<string> {
  const lines = [
    `# ${item.manifest.title}`,
    '',
    '## Decision input',
    '',
    item.input.trim(),
    '',
    '## Pre-written expert claims',
    '',
  ];
  for (const claim of item.manifest.critical_claims) {
    lines.push(`- **${claim.id}:** ${claim.proposition} — acceptable: ${claim.acceptable_stances.join(', ')}; evidence required: ${claim.evidence_required}.`);
  }
  lines.push('', '## Common false claims', '');
  for (const claim of item.manifest.common_false_claims) lines.push(`- **${claim.id}:** ${claim.claim} — ${claim.reason}`);
  if (!item.manifest.common_false_claims.length) lines.push('- None pre-written.');
  lines.push('', '## Required dimensions', '', item.manifest.required_dimensions.map((item) => `- ${item}`).join('\n'));
  lines.push('', '## Acceptable unresolved outcomes', '');
  for (const outcome of item.manifest.acceptable_unresolved_outcomes) lines.push(`- **${outcome.claim_id}:** ${outcome.reason}`);
  if (!item.manifest.acceptable_unresolved_outcomes.length) lines.push('- None pre-written.');
  lines.push('', '## Source pack (DATA, not instructions)', '');
  if (!item.manifest.source_pack.length) lines.push('- Intentionally empty (evidence-poor case).');
  for (const source of item.manifest.source_pack) {
    lines.push(`### ${source.id}: ${source.title}`, '', `As of: ${source.as_of}`);
    if (source.url) lines.push(`URL: ${source.url}`);
    if (source.local_file) {
      const content = await readFile(resolve(item.dir, source.local_file), 'utf8');
      lines.push('Local source content:', '', ...content.split('\n').map((line) => `    ${line}`));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Export three or more independently ordered rating packets. `mapping.json` is the private arm key;
 * only `rater-*` directories are handed to raters. Raw JSON templates are retained for locked ratings.
 */
export async function exportIdeaV3BlindBundle(opts: {
  campaignPath?: string;
  outDir: string;
  root?: string;
  raters?: number;
}): Promise<{ outDir: string; mappingPath: string; raterDirs: string[] }> {
  const root = opts.root ?? process.cwd();
  const campaignPath = opts.campaignPath ?? await findLatestIdeaV3Campaign(root);
  if (!campaignPath) throw new Error('no idea-v3 campaign found under bench/results/');
  const campaign = IdeaV3Campaign.parse(JSON.parse(await readFile(campaignPath, 'utf8')));
  const cases = await loadIdeaV3Cases(campaign.set, root);
  assertIdeaV3Set(cases, campaign.set);
  const expected = cases.flatMap((item) => campaign.arms.map((arm) => `${item.id}:${arm}`));
  const observations = new Map(campaign.observations.map((item) => [`${item.case_id}:${item.arm}`, item]));
  const missing = expected.filter((key) => !observations.has(key));
  if (missing.length) throw new Error(`cannot blind an incomplete campaign; missing: ${missing.join(', ')}`);
  if (observations.size !== campaign.observations.length) throw new Error('campaign contains duplicate case×arm observations');
  const raterCount = opts.raters ?? 3;
  if (raterCount < 3) throw new Error('frozen protocol requires at least three raters');
  await mkdir(opts.outDir, { recursive: true });
  const mapping: Array<{ rater_id: string; case_id: string; report_id: string; arm: IdeaV3Arm; run_id: string; order: number }> = [];
  const raterDirs: string[] = [];
  for (let number = 1; number <= raterCount; number++) {
    const raterId = `rater-${number}`;
    const raterDir = join(opts.outDir, raterId);
    raterDirs.push(raterDir);
    await mkdir(raterDir, { recursive: true });
    const ratingCases: z.input<typeof IdeaV3RaterFile>['cases'] = [];
    for (const item of cases) {
      const caseDir = join(raterDir, item.id);
      await mkdir(caseDir, { recursive: true });
      await writeFile(join(caseDir, 'case.md'), await renderCasePacket(item), 'utf8');
      const ordered = campaign.arms.map((arm) => observations.get(`${item.id}:${arm}`)!)
        .sort((left, right) => blindId(`${campaign.at}:${raterId}:${item.id}:${left.arm}`).localeCompare(blindId(`${campaign.at}:${raterId}:${item.id}:${right.arm}`)));
      const reports: z.input<typeof RaterReportTemplate>[] = [];
      for (let index = 0; index < ordered.length; index++) {
        const observation = ordered[index]!;
        const reportId = blindId(`${campaign.at}:${raterId}:${item.id}:${observation.arm}:report`);
        const markdown = observation.report_markdown
          ? blindIdeaV3Report(observation.report_markdown, observation.run_id, item.dir)
          : '# Decision Report\n\nNo usable report was produced.\n';
        await writeFile(join(caseDir, `${index + 1}-${reportId}.md`), markdown, 'utf8');
        mapping.push({ rater_id: raterId, case_id: item.id, report_id: reportId, arm: observation.arm, run_id: observation.run_id, order: index + 1 });
        reports.push({
          report_id: reportId,
          claim_ratings: [],
          action_ratings: [],
          citation_checks: [],
          coverage: [],
          disagreement_checks: [],
          honesty_violations: [],
          preference_rank: null,
        });
      }
      ratingCases.push({ case_id: item.id, reports });
    }
    const template = IdeaV3RaterFile.parse({ benchmark: 'idea-v3', set: campaign.set, rater_id: raterId, locked: false, cases: ratingCases });
    await writeFile(join(raterDir, 'ratings.json'), JSON.stringify(template, null, 2), 'utf8');
  }
  const mappingPath = join(opts.outDir, 'mapping.json');
  const privateMapping = BlindMapping.parse({ campaign: resolve(campaignPath), private: true, mapping });
  await writeFile(mappingPath, JSON.stringify(privateMapping, null, 2), 'utf8');
  return { outDir: opts.outDir, mappingPath, raterDirs };
}

function resolveFrom(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function sameExpectedClaims(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** One-pass import of locked raw ratings plus their human-majority resolution. */
export async function importIdeaV3Ratings(opts: {
  campaignPath?: string;
  resolutionPath: string;
  root?: string;
  outPath?: string;
}): Promise<{ path: string; scored: IdeaV3ScoredCampaign }> {
  const root = opts.root ?? process.cwd();
  const campaignPath = opts.campaignPath ?? await findLatestIdeaV3Campaign(root);
  if (!campaignPath) throw new Error('no idea-v3 campaign found under bench/results/');
  const campaign = IdeaV3Campaign.parse(JSON.parse(await readFile(campaignPath, 'utf8')));
  const resolutionPath = resolve(opts.resolutionPath);
  const resolutionDir = dirname(resolutionPath);
  const resolution = IdeaV3RatingResolution.parse(JSON.parse(await readFile(resolutionPath, 'utf8')));
  if (resolution.set !== campaign.set) throw new Error(`rating set ${resolution.set} does not match campaign set ${campaign.set}`);
  const mappingPath = resolveFrom(resolutionDir, resolution.mapping_file);
  const mapping = BlindMapping.parse(JSON.parse(await readFile(mappingPath, 'utf8')));
  if (resolveFrom(dirname(mappingPath), mapping.campaign) !== resolve(campaignPath)) {
    throw new Error('private mapping belongs to a different campaign');
  }
  const rawRatings = await Promise.all(resolution.raw_rating_files.map(async (path) => {
    const full = resolveFrom(resolutionDir, path);
    const content = await readFile(full, 'utf8');
    const rating = IdeaV3RaterFile.parse(JSON.parse(content));
    if (!rating.locked) throw new Error(`${rating.rater_id}: ratings are not locked`);
    if (rating.set !== campaign.set) throw new Error(`${rating.rater_id}: rating set does not match campaign`);
    return { rating, path: full, sha256: createHash('sha256').update(content).digest('hex') };
  }));
  const raterIds = new Set(rawRatings.map((item) => item.rating.rater_id));
  if (raterIds.size !== rawRatings.length) throw new Error('raw rating files must come from distinct raters');
  const expectedRaters = new Set(mapping.mapping.map((item) => item.rater_id));
  if (raterIds.size !== expectedRaters.size || [...raterIds].some((id) => !expectedRaters.has(id))) {
    throw new Error('raw rater ids do not match the private mapping');
  }
  for (const { rating } of rawRatings) {
    const expected = mapping.mapping.filter((item) => item.rater_id === rating.rater_id)
      .map((item) => `${item.case_id}:${item.report_id}`).sort();
    const actual = rating.cases.flatMap((item) => item.reports.map((report) => `${item.case_id}:${report.report_id}`)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${rating.rater_id}: rated report ids do not match the private mapping`);
  }
  const cases = await loadIdeaV3Cases(campaign.set, root);
  assertIdeaV3Set(cases, campaign.set);
  const manifestById = new Map(cases.map((item) => [item.id, item.manifest]));
  const campaignPairs = campaign.observations.map((item) => `${item.case_id}:${item.arm}`).sort();
  const resolvedPairs = resolution.reports.map((item) => `${item.case_id}:${item.arm}`).sort();
  if (JSON.stringify(resolvedPairs) !== JSON.stringify(campaignPairs)) {
    throw new Error('resolved ratings must contain every campaign case×arm exactly once');
  }
  const reports = resolution.reports.map((item) => {
    const manifest = manifestById.get(item.case_id);
    if (!manifest) throw new Error(`unknown rated case ${item.case_id}`);
    if (!sameExpectedClaims(item.adjudication.expected_claims, manifest.critical_claims)) {
      throw new Error(`${item.case_id}/${item.arm}: adjudication changed the pre-written expected claims`);
    }
    return {
      case_id: item.case_id,
      arm: item.arm,
      score: scoreDecisionInsights(item.adjudication),
      secondary: item.secondary,
    };
  });
  const summary = campaign.arms.map((arm) => ({
    arm,
    score: summarizeDecisionInsights(reports.filter((item) => item.arm === arm).map((item) => item.score)),
  }));
  const pairwisePreferences: Array<{
    case_id: string;
    left: IdeaV3Arm;
    right: IdeaV3Arm;
    left_votes: number;
    right_votes: number;
    winner: IdeaV3Arm | null;
  }> = [];
  for (const item of cases) {
    for (let leftIndex = 0; leftIndex < campaign.arms.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < campaign.arms.length; rightIndex++) {
        const left = campaign.arms[leftIndex]!;
        const right = campaign.arms[rightIndex]!;
        let leftVotes = 0;
        let rightVotes = 0;
        for (const { rating } of rawRatings) {
          const ratedCase = rating.cases.find((candidate) => candidate.case_id === item.id)!;
          const armForReport = new Map(mapping.mapping.filter((entry) => entry.rater_id === rating.rater_id && entry.case_id === item.id)
            .map((entry) => [entry.report_id, entry.arm]));
          const ranks = new Map(ratedCase.reports.map((report) => [armForReport.get(report.report_id)!, report.preference_rank]));
          const leftRank = ranks.get(left);
          const rightRank = ranks.get(right);
          if (leftRank === null || leftRank === undefined || rightRank === null || rightRank === undefined || leftRank === rightRank) {
            throw new Error(`${rating.rater_id}/${item.id}: preference ranks must be non-null and unique across compared reports`);
          }
          if (leftRank < rightRank) leftVotes++;
          else rightVotes++;
        }
        const majority = Math.floor(rawRatings.length / 2) + 1;
        pairwisePreferences.push({
          case_id: item.id,
          left,
          right,
          left_votes: leftVotes,
          right_votes: rightVotes,
          winner: leftVotes >= majority ? left : rightVotes >= majority ? right : null,
        });
      }
    }
  }
  const scored = IdeaV3ScoredCampaign.parse({
    version: 1,
    at: new Date().toISOString(),
    campaign: campaignPath,
    set: campaign.set,
    raw_ratings: rawRatings.map((item) => ({ rater_id: item.rating.rater_id, path: item.path, sha256: item.sha256 })),
    reports,
    summary,
    pairwise_preferences: pairwisePreferences,
  });
  const path = opts.outPath ?? campaignPath.replace(/\.json$/, '.scores.json');
  try {
    await readFile(path);
    throw new Error(`scores already exist at ${path} — blind adjudication is one pass`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(scored, null, 2), 'utf8');
  await rename(tmp, path);
  return { path, scored };
}

function ratio(part: number, total: number): number {
  return total ? part / total : 1;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function nearestRank(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

export interface IdeaV3TokenEfficiencyRow {
  arm: IdeaV3Arm;
  matched: number;
  tokens: number | null;
  matched_per_1k_tokens: number | null;
  estimated_calls: number;
}

/** Phase F additive metric: adjudicated matched expert claims per 1,000 recorded input+output tokens. */
export function ideaV3TokenEfficiency(
  scored: IdeaV3ScoredCampaign,
  campaign: IdeaV3Campaign,
): IdeaV3TokenEfficiencyRow[] {
  scored = IdeaV3ScoredCampaign.parse(scored);
  campaign = IdeaV3Campaign.parse(campaign);
  return campaign.arms.map((arm) => {
    const observations = campaign.observations.filter((item) => item.arm === arm);
    const complete = observations.length > 0 && observations.every((item) => item.usage !== undefined);
    const tokens = complete
      ? observations.reduce((sum, item) => sum + item.usage!.inputTokens + item.usage!.outputTokens, 0)
      : null;
    const matched = scored.summary.find((item) => item.arm === arm)?.score.matched ?? 0;
    return {
      arm,
      matched,
      tokens,
      matched_per_1k_tokens: tokens ? matched * 1_000 / tokens : null,
      estimated_calls: observations.reduce((sum, item) => sum + (item.usage?.estimatedCalls ?? 0), 0),
    };
  });
}

export interface IdeaV3AdaptiveGateResult {
  matrix_complete: boolean;
  usage_complete: boolean;
  primary_vs_b: boolean;
  quality_floor_d2: boolean;
  quality_floor_r: boolean;
  token_savings: boolean;
  calls_median: boolean;
  calls_p95: boolean;
  pass: boolean;
  a_median_calls: number;
  a_p95_calls: number;
  a_median_tokens: number | null;
  r_median_tokens: number | null;
  token_reduction: number | null;
}

/** Phase F build-only product targets. Original frozen holdout ship gates remain separate. */
export function evaluateIdeaV3AdaptiveGates(
  scored: IdeaV3ScoredCampaign,
  campaign: IdeaV3Campaign,
): IdeaV3AdaptiveGateResult {
  scored = IdeaV3ScoredCampaign.parse(scored);
  campaign = IdeaV3Campaign.parse(campaign);
  if (scored.set !== 'build' || campaign.set !== 'build') {
    throw new Error('adaptive product targets require the Phase F build campaign');
  }
  const required = ['A', 'B', 'B2', 'D2', 'R'] as const;
  const caseIds = new Set(campaign.observations.filter((item) => item.arm === 'A').map((item) => item.case_id));
  const expectedPairs = [...caseIds].flatMap((caseId) => required.map((arm) => `${caseId}:${arm}`));
  const observedPairs = campaign.observations.filter((item) => required.includes(item.arm as typeof required[number]));
  const scoredPairs = new Set(scored.reports.map((item) => `${item.case_id}:${item.arm}`));
  const matrixComplete = caseIds.size > 0
    && observedPairs.length === expectedPairs.length
    && expectedPairs.every((pair) => observedPairs.some((item) => `${item.case_id}:${item.arm}` === pair) && scoredPairs.has(pair))
    && required.every((arm) => scored.summary.some((item) => item.arm === arm));
  const score = (arm: IdeaV3Arm) => scored.summary.find((item) => item.arm === arm)?.score.f1;
  const a = score('A'), b = score('B'), d2 = score('D2'), r = score('R');
  const aObservations = campaign.observations.filter((item) => item.arm === 'A');
  const rObservations = campaign.observations.filter((item) => item.arm === 'R');
  const usageComplete = aObservations.length > 0 && rObservations.length > 0
    && [...aObservations, ...rObservations].every((item) => item.usage !== undefined);
  const perCaseTokens = (items: typeof aObservations) => items.map((item) => item.usage!.inputTokens + item.usage!.outputTokens);
  const aMedianTokens = usageComplete ? median(perCaseTokens(aObservations)) : null;
  const rMedianTokens = usageComplete ? median(perCaseTokens(rObservations)) : null;
  const tokenReduction = aMedianTokens !== null && rMedianTokens
    ? 1 - aMedianTokens / rMedianTokens
    : null;
  const aMedianCalls = median(aObservations.map((item) => item.calls));
  const aP95Calls = nearestRank(aObservations.map((item) => item.calls), 0.95);
  const gates = {
    matrix_complete: matrixComplete,
    usage_complete: usageComplete,
    primary_vs_b: a !== undefined && b !== undefined && a > b,
    quality_floor_d2: a !== undefined && d2 !== undefined && a >= d2 - 0.05,
    quality_floor_r: a !== undefined && r !== undefined && a >= r - 0.05,
    token_savings: tokenReduction !== null && tokenReduction >= 0.4,
    calls_median: aObservations.length > 0 && aMedianCalls <= 3,
    calls_p95: aObservations.length > 0 && aP95Calls <= 6,
  };
  return {
    ...gates,
    pass: Object.values(gates).every(Boolean),
    a_median_calls: aMedianCalls,
    a_p95_calls: aP95Calls,
    a_median_tokens: aMedianTokens,
    r_median_tokens: rMedianTokens,
    token_reduction: tokenReduction,
  };
}

export interface IdeaV3GateResult {
  primary_vs_b: boolean;
  primary_vs_c: boolean;
  factual_precision: boolean;
  citation_support: boolean;
  coverage: boolean;
  disagreement_precision: boolean;
  validation_plan: boolean;
  honesty: boolean;
  blind_preference: boolean;
  operational: boolean;
  ship: boolean;
  r_preference_wins: number;
  holdout_cases: number;
}

/** Pure frozen ship-gate calculation. Secondary wins cannot rescue either primary F1 loss. */
export function evaluateIdeaV3Gates(scored: IdeaV3ScoredCampaign, campaign: IdeaV3Campaign): IdeaV3GateResult {
  scored = IdeaV3ScoredCampaign.parse(scored);
  campaign = IdeaV3Campaign.parse(campaign);
  if (scored.set !== 'holdout' || campaign.set !== 'holdout') throw new Error('ship gates require the frozen holdout');
  const score = (arm: IdeaV3Arm) => scored.summary.find((item) => item.arm === arm)?.score;
  const b = score('B');
  const c = score('C');
  const r = score('R');
  if (!b || !c || !r) throw new Error('holdout ship gate requires B, C, and R scores');
  const secondary = scored.reports.filter((item) => item.arm === 'R').map((item) => item.secondary);
  const sum = (pick: (item: z.infer<typeof SecondaryGateCounts>) => number) => secondary.reduce((total, item) => total + pick(item), 0);
  const factualEligible = sum((item) => item.factual_claims.eligible);
  const factualPass = sum((item) => item.factual_claims.honest_or_supported);
  const citations = sum((item) => item.citations.total);
  const supportedCitations = sum((item) => item.citations.exact_support);
  const dimensions = sum((item) => item.coverage.required);
  const coveredDimensions = sum((item) => item.coverage.accounted);
  const disagreements = sum((item) => item.disagreements.labeled);
  const genuineDisagreements = sum((item) => item.disagreements.genuine);
  const actions = sum((item) => item.actions.total);
  const completeActions = sum((item) => item.actions.complete);
  const actionable = sum((item) => item.actions.score_4_or_5);
  const honestyViolations = sum((item) => item.honesty_violations);
  const cases = new Set(campaign.observations.map((item) => item.case_id));
  let preferenceWins = 0;
  for (const caseId of cases) {
    const rb = scored.pairwise_preferences.find((item) => item.case_id === caseId && new Set([item.left, item.right]).size === 2 && [item.left, item.right].includes('R') && [item.left, item.right].includes('B'));
    const rc = scored.pairwise_preferences.find((item) => item.case_id === caseId && new Set([item.left, item.right]).size === 2 && [item.left, item.right].includes('R') && [item.left, item.right].includes('C'));
    if (rb?.winner === 'R' && rc?.winner === 'R') preferenceWins++;
  }
  const rObservations = campaign.observations.filter((item) => item.arm === 'R');
  const gates = {
    primary_vs_b: r.f1 > b.f1 && r.f1 >= 1.2 * b.f1,
    primary_vs_c: r.f1 > c.f1 && r.f1 >= 1.1 * c.f1,
    factual_precision: ratio(factualPass, factualEligible) >= 0.95,
    citation_support: ratio(supportedCitations, citations) >= 0.95,
    coverage: dimensions > 0 && coveredDimensions === dimensions,
    disagreement_precision: ratio(genuineDisagreements, disagreements) >= 0.9,
    validation_plan: actions > 0 && completeActions === actions && ratio(actionable, actions) >= 0.9,
    honesty: honestyViolations === 0,
    blind_preference: cases.size > 0 && preferenceWins / cases.size >= 0.7,
    operational: rObservations.length === cases.size
      && rObservations.every((item) => item.status === 'ok')
      && rObservations.every((item) => item.calls <= IDEA_V3_CALLS_PER_CASE.R)
      && median(rObservations.map((item) => item.latency_ms)) <= 8 * 60 * 1000,
  };
  return {
    ...gates,
    ship: Object.values(gates).every(Boolean),
    r_preference_wins: preferenceWins,
    holdout_cases: cases.size,
  };
}

/** Publish Phase F build validation without turning it into a frozen holdout claim. */
export async function writeIdeaV3AdaptiveResults(opts: {
  scoredPath: string;
  outPath?: string;
  root?: string;
}): Promise<{ path: string; gates: IdeaV3AdaptiveGateResult }> {
  const root = opts.root ?? process.cwd();
  const scoredPath = resolve(opts.scoredPath);
  const scored = IdeaV3ScoredCampaign.parse(JSON.parse(await readFile(scoredPath, 'utf8')));
  const campaignPath = resolveFrom(dirname(scoredPath), scored.campaign);
  const campaign = IdeaV3Campaign.parse(JSON.parse(await readFile(campaignPath, 'utf8')));
  const gates = evaluateIdeaV3AdaptiveGates(scored, campaign);
  const efficiency = ideaV3TokenEfficiency(scored, campaign);
  const summary = new Map(scored.summary.map((item) => [item.arm, item.score]));
  const rows: Array<[string, boolean, string]> = [
    ['Complete scored A/B/B2/D2/R matrix', gates.matrix_complete, gates.matrix_complete ? 'complete' : 'missing or duplicate pairs'],
    ['A/R token usage complete', gates.usage_complete, gates.usage_complete ? 'complete' : 'usage missing'],
    ['A strictly beats B on F1', gates.primary_vs_b, `${summary.get('A')?.f1.toFixed(3)} vs ${summary.get('B')?.f1.toFixed(3)}`],
    ['A within 0.05 F1 of D2', gates.quality_floor_d2, `${summary.get('A')?.f1.toFixed(3)} vs ${summary.get('D2')?.f1.toFixed(3)}`],
    ['A within 0.05 F1 of R', gates.quality_floor_r, `${summary.get('A')?.f1.toFixed(3)} vs ${summary.get('R')?.f1.toFixed(3)}`],
    ['A median tokens ≥40% below R', gates.token_savings, gates.token_reduction === null ? 'usage missing' : pct(gates.token_reduction)],
    ['A median calls ≤3', gates.calls_median, gates.a_median_calls.toFixed(1)],
    ['A p95 calls ≤6', gates.calls_p95, gates.a_p95_calls.toFixed(0)],
  ];
  const lines = [
    '# RESULTS-IDEA-V3-ADAPTIVE — Phase F build validation',
    '',
    `**Adaptive build targets: ${gates.pass ? 'PASS' : 'FAIL'}**`,
    '',
    'Build-set product validation; not a frozen holdout claim.',
    '',
    '## Product targets',
    '',
    '| Target | Result | Evidence |',
    '|---|---|---|',
    ...rows.map(([name, pass, evidence]) => `| ${name} | ${pass ? 'PASS' : 'FAIL'} | ${evidence} |`),
    '',
    '## Primary metric',
    '',
    '| Arm | Matched | Recall | Precision | F1 |',
    '|---|---:|---:|---:|---:|',
    ...campaign.arms.map((arm) => {
      const item = summary.get(arm)!;
      return `| ${arm} | ${item.matched} | ${pct(item.recall)} | ${pct(item.precision)} | ${item.f1.toFixed(3)} |`;
    }),
    '',
    '## Verified insights per 1,000 tokens',
    '',
    '| Arm | Matched | Tokens | Matched / 1k tokens | Estimated calls |',
    '|---|---:|---:|---:|---:|',
    ...efficiency.map((item) => `| ${item.arm} | ${item.matched} | ${item.tokens ?? 'missing'} | ${item.matched_per_1k_tokens?.toFixed(3) ?? 'missing'} | ${item.estimated_calls} |`),
    '',
    '## Every case and arm',
    '',
    '| Case | Arm | Status | Calls | Tokens | Repairs | Wall time | Flags / failure |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...[...campaign.observations]
      .sort((left, right) => left.case_id.localeCompare(right.case_id) || left.arm.localeCompare(right.arm))
      .map((item) => {
        const tokens = item.usage ? item.usage.inputTokens + item.usage.outputTokens : 'missing';
        const detail = item.status === 'error' ? item.error! : item.flags.join(', ') || 'none';
        return `| ${item.case_id} | ${item.arm} | ${item.status} | ${item.calls} | ${tokens} | ${item.repair_calls} | ${(item.latency_ms / 1000).toFixed(1)}s | ${mdCell(detail)} |`;
      }),
    '',
    `Token values include input plus output. ${efficiency.some((item) => item.estimated_calls > 0) ? 'At least one call uses Phase A labeled estimation.' : 'All recorded calls use provider-reported totals.'}`,
    '',
  ];
  const path = opts.outPath ?? join(root, 'RESULTS-IDEA-V3-ADAPTIVE.md');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, lines.join('\n'), 'utf8');
  await rename(tmp, path);
  return { path, gates };
}

function mdCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Deterministically publish every holdout case, failure, call count, latency, metric, and frozen gate. */
export async function writeIdeaV3Results(opts: {
  scoredPath: string;
  outPath?: string;
  root?: string;
}): Promise<{ path: string; gates: IdeaV3GateResult }> {
  const root = opts.root ?? process.cwd();
  const scoredPath = resolve(opts.scoredPath);
  const scored = IdeaV3ScoredCampaign.parse(JSON.parse(await readFile(scoredPath, 'utf8')));
  const campaignPath = resolveFrom(dirname(scoredPath), scored.campaign);
  const campaign = IdeaV3Campaign.parse(JSON.parse(await readFile(campaignPath, 'utf8')));
  const gates = evaluateIdeaV3Gates(scored, campaign);
  const summary = new Map(scored.summary.map((item) => [item.arm, item.score]));
  const gateRows: Array<[string, boolean, string]> = [
    ['Primary: R ≥1.20× B and strictly wins', gates.primary_vs_b, `${summary.get('R')!.f1.toFixed(3)} vs ${summary.get('B')!.f1.toFixed(3)}`],
    ['Primary: R ≥1.10× C and strictly wins', gates.primary_vs_c, `${summary.get('R')!.f1.toFixed(3)} vs ${summary.get('C')!.f1.toFixed(3)}`],
    ['Factual precision', gates.factual_precision, '≥95%'],
    ['Citation support', gates.citation_support, '≥95%'],
    ['Coverage', gates.coverage, '100% accounted'],
    ['Genuine-disagreement precision', gates.disagreement_precision, '≥90%'],
    ['Validation plan', gates.validation_plan, 'all complete; ≥90% score 4/5+'],
    ['Honesty', gates.honesty, 'zero settled unsupported/unresolved conclusions'],
    ['Blind preference', gates.blind_preference, `${gates.r_preference_wins}/${gates.holdout_cases} cases`],
    ['Operational', gates.operational, 'R ≤10 calls/case; median ≤8 min'],
  ];
  const lines = [
    '# RESULTS-IDEA-V3 — frozen holdout',
    '',
    `**Ship gate: ${gates.ship ? 'PASS' : 'FAIL'}**`,
    '',
  ];
  if (gates.ship) lines.push('R passed both frozen primary comparisons and every additional product/operational gate.', '');
  else if (!gates.primary_vs_b) lines.push('R did not beat B under the frozen protocol. Default idea evaluation to quick; no cross-provider advantage is claimed.', '');
  else if (!gates.primary_vs_c) lines.push('R did not beat C under the frozen protocol. Vendor diversity did not earn its cost; keep R experimental or ship the self-consistency protocol.', '');
  else lines.push('R passed the primary F1 comparisons but failed one or more product/operational gates. This is a research result, not a ship claim.', '');
  lines.push('## Primary metric', '', '| Arm | Expected | Matched | Reported | True positive | Recall | Precision | F1 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const arm of ['B', 'C', 'R'] as const) {
    const item = summary.get(arm)!;
    lines.push(`| ${arm} | ${item.expected} | ${item.matched} | ${item.reported} | ${item.true_positive_reports} | ${pct(item.recall)} | ${pct(item.precision)} | ${item.f1.toFixed(3)} |`);
  }
  lines.push('', '## Frozen gates', '', '| Gate | Result | Evidence |', '|---|---|---|');
  for (const [name, pass, evidence] of gateRows) lines.push(`| ${name} | ${pass ? 'PASS' : 'FAIL'} | ${evidence} |`);
  lines.push('', '## Every case and arm', '', '| Case | Arm | Status | Calls | Claude | Codex | Gemini | Repairs | Wall time | Flags / failure |', '|---|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const item of [...campaign.observations].sort((left, right) => left.case_id.localeCompare(right.case_id) || left.arm.localeCompare(right.arm))) {
    const detail = item.status === 'error' ? item.error! : item.flags.join(', ') || 'none';
    lines.push(`| ${item.case_id} | ${item.arm} | ${item.status} | ${item.calls} | ${item.calls_by_provider.claude ?? 0} | ${item.calls_by_provider.codex ?? 0} | ${item.calls_by_provider.agy ?? 0} | ${item.repair_calls} | ${(item.latency_ms / 1000).toFixed(1)}s | ${mdCell(detail)} |`);
  }
  lines.push('', '## Cost and latency', '', '| Arm | Calls | Claude | Codex | Gemini | Median wall time | Failures |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const arm of ['B', 'C', 'R'] as const) {
    const items = campaign.observations.filter((item) => item.arm === arm);
    const total = (provider: ProviderId) => items.reduce((sum, item) => sum + (item.calls_by_provider[provider] ?? 0), 0);
    lines.push(`| ${arm} | ${items.reduce((sum, item) => sum + item.calls, 0)} | ${total('claude')} | ${total('codex')} | ${total('agy')} | ${(median(items.map((item) => item.latency_ms)) / 1000).toFixed(1)}s | ${items.filter((item) => item.status === 'error').length} |`);
  }
  lines.push('', '## Rating record', '');
  for (const raw of scored.raw_ratings) lines.push(`- ${raw.rater_id}: SHA-256 \`${raw.sha256}\``);
  lines.push('', 'Provider/model names, run ids, call logs, and report order were hidden during independent rating. The private mapping was opened only for majority resolution.', '');
  const path = opts.outPath ?? join(root, 'RESULTS-IDEA-V3.md');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, lines.join('\n'), 'utf8');
  await rename(tmp, path);
  return { path, gates };
}

/** CLI publication dispatch: build amendments and frozen holdout results stay visibly separate. */
export async function publishIdeaV3Results(opts: {
  scoredPath: string;
  root?: string;
}): Promise<{ path: string; passed: boolean; label: string }> {
  const scored = IdeaV3ScoredCampaign.parse(JSON.parse(await readFile(resolve(opts.scoredPath), 'utf8')));
  if (scored.set === 'build') {
    const result = await writeIdeaV3AdaptiveResults(opts);
    return { path: result.path, passed: result.gates.pass, label: 'adaptive build targets' };
  }
  const result = await writeIdeaV3Results(opts);
  return { path: result.path, passed: result.gates.ship, label: 'frozen ship gate' };
}

export const IdeaV3ProtocolDraft = z.object({
  build_scores: z.string().min(1),
  baseline_provider: z.enum(['claude', 'codex', 'agy']),
  models: z.object({ claude: z.string().min(1), codex: z.string().min(1), agy: z.string().min(1) }).strict(),
  roles: z.object({
    analyst: z.enum(['claude', 'codex', 'agy']),
    judge: z.enum(['claude', 'codex', 'agy']),
    verifier: z.enum(['claude', 'codex', 'agy']),
    s4: z.tuple([z.enum(['claude', 'codex', 'agy']), z.enum(['claude', 'codex', 'agy'])]),
  }).strict(),
  lane_assignment: z.enum(['agy-market', 'codex-market']),
}).strict();

/** Freeze only the original complete, already-scored B/C/D2/R build campaign; the file is one-shot. */
export async function writeFrozenIdeaV3Protocol(opts: {
  draftPath: string;
  root?: string;
  outPath?: string;
}): Promise<{ path: string; protocol: z.infer<typeof IdeaV3Protocol> }> {
  const root = opts.root ?? process.cwd();
  const draftPath = resolve(opts.draftPath);
  const draft = IdeaV3ProtocolDraft.parse(JSON.parse(await readFile(draftPath, 'utf8')));
  const scoresPath = resolveFrom(dirname(draftPath), draft.build_scores);
  const scored = IdeaV3ScoredCampaign.parse(JSON.parse(await readFile(scoresPath, 'utf8')));
  if (scored.set !== 'build') throw new Error('protocol freeze requires scored build results');
  const campaignPath = resolveFrom(dirname(scoresPath), scored.campaign);
  const campaign = IdeaV3Campaign.parse(JSON.parse(await readFile(campaignPath, 'utf8')));
  if (campaign.set !== 'build') throw new Error('protocol freeze requires a build campaign');
  if (campaign.baseline_provider !== draft.baseline_provider) {
    throw new Error(`draft baseline ${draft.baseline_provider} does not match campaign ${campaign.baseline_provider}`);
  }
  const arms = ['B', 'C', 'D2', 'R'] as const;
  if (arms.some((arm) => !campaign.arms.includes(arm) || !scored.summary.some((item) => item.arm === arm))) {
    throw new Error('protocol freeze requires scored B, C, D2, and R build arms');
  }
  const caseIds = new Set(campaign.observations.map((item) => item.case_id));
  const pairs = new Set(campaign.observations.map((item) => `${item.case_id}:${item.arm}`));
  if (caseIds.size !== 8 || pairs.size !== 8 * arms.length || campaign.observations.length !== pairs.size) {
    throw new Error('protocol freeze requires the complete 8-case × B/C/D2/R build matrix');
  }
  const scoredPairs = new Set(scored.reports.map((item) => `${item.case_id}:${item.arm}`));
  if (scoredPairs.size !== pairs.size || [...pairs].some((pair) => !scoredPairs.has(pair))) {
    throw new Error('protocol freeze requires every build observation to be scored');
  }
  const protocol = IdeaV3Protocol.parse({
    version: 1,
    status: 'FROZEN',
    frozen_at: new Date().toISOString(),
    benchmark_commit: '680fba3',
    build_scores: scoresPath,
    baseline_provider: draft.baseline_provider,
    models: draft.models,
    roles: draft.roles,
    lane_assignment: draft.lane_assignment,
    r_mode: 'research',
    hashes: await ideaV3FreezeHashes(root),
  });
  const path = opts.outPath ?? join(root, 'bench', 'idea-v3-protocol.json');
  try {
    await readFile(path);
    throw new Error(`protocol already frozen at ${path} — refusing to overwrite`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(protocol, null, 2), 'utf8');
  await rename(tmp, path);
  return { path, protocol };
}
