// V4 escalation ladder — deterministic coverage-hole detection (pure). See BENCHMARK.md amendment L1.
//
// The ladder hunts cheap first (agy + codex, = Arm E's tier 1) and escalates a Claude call ONLY when it
// is likely to matter: (a) a disputed finding → the Claude judge (Arm E already does this); (b) a COVERAGE
// HOLE → one targeted Claude review over the risky hunks. This file owns (b)'s trigger: a pure function
// over the diff + tier-1 findings, so it's fully unit-tested without any model call. RISK_DEFS are FROZEN
// by the L1 pre-registration — do not tune them without a new amendment.

import type { Finding } from '../../schemas/index.js';
import { parseDiffFiles } from '../git.js';

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
