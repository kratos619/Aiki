// V4 escalation ladder — deterministic coverage-hole detection (pure). See BENCHMARK.md amendment L1.
//
// The ladder hunts cheap first (agy + codex, = Arm E's tier 1) and escalates a Claude call ONLY when it
// is likely to matter: (a) a disputed finding → the Claude judge (Arm E already does this); (b) a COVERAGE
// HOLE → one targeted Claude review over the risky hunks. This file owns (b)'s trigger: a pure function
// over the diff + tier-1 findings, so it's fully unit-tested without any model call. RISK_DEFS are FROZEN
// by the L1 pre-registration — do not tune them without a new amendment.

import { CodeReviewRoleOutputModel, type Finding, type ReviewMap } from '../../schemas/index.js';
import type { RunCtx } from '../context.js';
import { parseDiffFiles } from '../git.js';
import { jsonCall } from '../jsonStage.js';
import { sameFinding } from './cr-map.js';
import { countLines, filterValidFindings, type ReviewerFindings } from './cr-s4-review.js';

export interface RiskDef {
  id: string;
  label: string;
  categories: Finding['category'][]; // a tier-1 finding of one of these categories "covers" this risk
  fileRe: RegExp; // HEAD file paths that put this risk in play
  keywordRe: RegExp; // added-line (`+…`) keywords that put this risk in play
}

/** FROZEN for L1 (BENCHMARK.md amendment L1): risk classes + their globs / keywords / covering categories. */
export const RISK_DEFS: RiskDef[] = [
  {
    id: 'auth',
    label: 'auth / access control',
    categories: ['SECURITY'],
    fileRe: /(auth|login|session|token|permission|acl|oauth|jwt|guard|middleware)/i,
    keywordRe: /\b(authenticate|authoriz|password|jwt|bcrypt|session|cookie|csrf|isadmin|req\.user|\.role\b|permission)\b/i,
  },
  {
    id: 'crypto',
    label: 'cryptography',
    categories: ['SECURITY'],
    fileRe: /(crypto|encrypt|cipher|hash|sign)/i,
    keywordRe: /\b(encrypt|decrypt|createhash|randombytes|createcipher|hmac|nonce|\biv\b|math\.random)\b/i,
  },
  {
    id: 'payment',
    label: 'payments / money',
    categories: ['CORRECTNESS', 'SECURITY'],
    fileRe: /(payment|billing|charge|invoice|checkout|stripe|order|price)/i,
    keywordRe: /\b(charge|refund|amount|currency|\bprice\b|subtotal|\btotal\b|discount|\btax\b|balance)\b/i,
  },
  {
    id: 'async',
    label: 'async / concurrency',
    categories: ['CONCURRENCY'],
    fileRe: /(worker|queue|scheduler|\bjob\b|concurrent)/i,
    keywordRe: /\b(async|await|promise\.all|promise\.race|settimeout|setinterval|mutex|\block\b|concurrent|parallel)\b/i,
  },
];

export interface CoverageHole {
  risk: string;
  label: string;
  categories: Finding['category'][];
  files: string[]; // the diff files the targeted Claude hunt should re-review
}

/**
 * A risk the diff touches (by file glob or added-line keyword) that tier-1 flagged NOTHING of the right
 * category inside → escalate a targeted hunt. Deterministic + pure (BENCHMARK.md L1 §"Coverage hole").
 */
export function detectCoverageHoles(diff: string, findings: Pick<Finding, 'category' | 'file'>[]): CoverageHole[] {
  const files = parseDiffFiles(diff);
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');

  const holes: CoverageHole[] = [];
  for (const r of RISK_DEFS) {
    const riskFiles = files.filter((f) => r.fileRe.test(f));
    const triggered = riskFiles.length > 0 || r.keywordRe.test(added);
    if (!triggered) continue;
    // Scope = the risk-glob files if any, else the whole diff (keyword-only trigger).
    const scope = riskFiles.length ? riskFiles : files;
    const covered = findings.some((f) => r.categories.includes(f.category) && scope.includes(f.file));
    if (!covered) holes.push({ risk: r.id, label: r.label, categories: r.categories, files: scope });
  }
  return holes;
}

const TARGETED_PROMPT = `ROLE: Senior targeted coverage-hole reviewer.
You have READ-ONLY access to the repository at your working directory.

Review ONLY the {{RISK_LABEL}} risk in these changed files: {{FILES_JSON}}.
Report ONLY categories {{CATEGORIES_JSON}} and ONLY findings whose file is in that list. Investigate
surrounding code as needed, but do not report unrelated defects.

Produce ONLY JSON:
- task_echo (≤2 sentences),
- findings: ≤12, each {id "F1"..., file, line_start, line_end, severity P0|P1|P2|P3,
  category CORRECTNESS|SECURITY|CONCURRENCY|ERROR_HANDLING|PERF|MAINTAINABILITY,
  claim, evidence, suggested_fix, self_confidence 0-1}.
Every finding MUST cite a verified file and line range. JSON only.

SCOPED DIFF:
{{DIFF}}`;

/** Keep only complete `diff --git` sections whose HEAD file is in `files`. */
export function scopeDiff(diff: string, files: string[]): string {
  const wanted = new Set(files);
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => parseDiffFiles(section).some((file) => wanted.has(file)))
    .join('')
    .trim();
}

/** Arm L tier 2(b): one Claude call per frozen coverage hole, validated back to that hole's scope. */
export async function runCoverageHunts(
  ctx: RunCtx,
  diff: string,
  tier1: ReviewerFindings[],
): Promise<ReviewerFindings | null> {
  const holes = detectCoverageHoles(diff, tier1.flatMap((reviewer) => reviewer.findings));
  if (holes.length === 0) return null;

  const findings: Finding[] = [];
  const dropped: Finding[] = [];
  let raised = 0;
  for (const hole of holes) {
    const prompt = TARGETED_PROMPT
      .replace('{{RISK_LABEL}}', hole.label)
      .replace('{{FILES_JSON}}', JSON.stringify(hole.files))
      .replace('{{CATEGORIES_JSON}}', JSON.stringify(hole.categories))
      .replace('{{DIFF}}', scopeDiff(diff, hole.files));
    const model = await jsonCall(ctx, ctx.handle('claude'), `L-${hole.risk}`, prompt, CodeReviewRoleOutputModel);
    await ctx.writer.writeRoleOutput(`claude-ladder-${hole.risk}`, { workflow: 'code-review', ...model });
    raised += model.findings.length;

    const wrongCategory = model.findings.filter((finding) => !hole.categories.includes(finding.category));
    const inCategory = model.findings.filter((finding) => hole.categories.includes(finding.category));
    const checked = filterValidFindings(inCategory, new Set(hole.files), await countLines(ctx.cwd, hole.files));
    dropped.push(...wrongCategory, ...checked.dropped);
    for (const finding of checked.valid) {
      if (findings.some((kept) => sameFinding(kept, finding))) dropped.push(finding);
      else findings.push(finding);
    }
  }

  return { provider: 'claude', findings, dropped, raised };
}

/** Merge validated ladder findings into the kept, MEDIUM-confidence set without self-adjudication. */
export function mergeCoverageHunt(map: ReviewMap, hunt: ReviewerFindings | null): ReviewMap {
  if (!hunt) return map;
  const existing = [...map.consensus, ...map.disputed, ...map.single_reviewer].map((item) => item.finding);
  const novel = hunt.findings.filter((finding) => !existing.some((item) => sameFinding(item, finding)));
  let next = existing.length;
  const added = novel.map((finding) => ({
    finding: { ...finding, id: `G${++next}` },
    reviewers: ['claude' as const],
    cross_verdict: 'NONE' as const,
  }));
  return {
    ...map,
    single_reviewer: [...map.single_reviewer, ...added],
    per_reviewer: [
      ...map.per_reviewer,
      { provider: 'claude', raised: hunt.raised, kept: added.length, dropped: hunt.raised - added.length },
    ],
  };
}
