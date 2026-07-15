// Pure formatters for the completion + error screens (T8, §4.3, §471). No Ink — unit-tested directly.

import type { DecisionGraph, JudgeReport } from '../schemas/index.js';

export interface CompletionView {
  verdict: string;
  disagreements: string[]; // top-N contested items with their ruling
  reportPath: string;
  rawPath: string;
}

/** Completion summary (§4.3): verdict + the top-N contradictions with their adjudication ruling. */
export function formatCompletion(dir: string, judge: JudgeReport, graph: DecisionGraph, topN = 3): CompletionView {
  const ruling = new Map(judge.adjudications.map((a) => [a.id, a.ruling]));
  const disagreements = graph.claims.filter((claim) => claim.state === 'DISAGREEMENT').slice(0, topN).map((claim) => {
    const result = ruling.get(claim.id) ?? 'UNRESOLVED';
    return `${claim.id} → ${result}: ${claim.proposition}`;
  });
  return { verdict: judge.verdict, disagreements, reportPath: `${dir}/final-report.md`, rawPath: `${dir}/raw/` };
}

/** Actionable fix line per classified error (§471 error panel). */
const FIX: Record<string, string> = {
  AUTH: "provider needs login — run it once in a terminal (e.g. `claude`)",
  QUOTA: 'provider quota / rate limit hit — wait, or switch the role to another provider',
  NOT_FOUND: 'provider binary not on PATH — run `aiki doctor`',
  TIMEOUT: 'a provider call exceeded its timeout',
  BAD_OUTPUT: 'a provider returned unparseable output even after the repair retry',
  CRASH: 'a provider process exited abnormally',
  QUORUM: 'need ≥2 providers ready — run `aiki doctor`',
  BUDGET: 'call budget exhausted — raise it with `--budget <n>`',
  DEADLINE: 'run exceeded its wall-clock deadline',
  ABORT: 'run aborted',
};

export interface ErrorView {
  code: string;
  fix: string;
  partialDir?: string;
}

export function formatError(code: string, partialDir?: string): ErrorView {
  return { code, fix: FIX[code] ?? 'see the run logs under .aiki/', ...(partialDir ? { partialDir } : {}) };
}
