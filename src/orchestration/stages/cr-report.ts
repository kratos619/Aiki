// code-review S10 — report rendering (§12.2, T10). Pure → final-report.md, a decision brief for the
// reviewer: verdict → findings table (P0/P1 first) → disagreement map → per-reviewer stats → raw links.
//
// Confidence + false-positive exclusion are DERIVED here (one source of truth, §624), NOT taken from the
// judge: consensus→HIGH, single-reviewer→MEDIUM, disputed+UPHOLD/UNRESOLVED→LOW (kept),
// disputed+REJECT→false positive (excluded from the findings table, listed under Rejected).

import type { Finding, JudgeReport, ReviewMap } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';

export interface ScoredFinding {
  finding: Finding;
  reviewers: ProviderId[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  disposition: 'kept' | 'rejected'; // rejected = adjudicated false positive
  ruling?: 'UPHOLD' | 'REJECT' | 'UNRESOLVED';
}

const SEV_RANK: Record<Finding['severity'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const disp = (id: ProviderId): string => DISPLAY_NAME[id];
const attrib = (ps: ProviderId[]): string => ps.map(disp).join(' + ');

/** Pure: assign each finding its derived confidence + disposition from the map + judge rulings. */
export function scoreFindings(map: ReviewMap, judge: JudgeReport): ScoredFinding[] {
  const ruling = new Map(judge.adjudications.map((a) => [a.id, a.ruling]));
  const out: ScoredFinding[] = [];
  for (const af of map.consensus) out.push({ finding: af.finding, reviewers: af.reviewers, confidence: 'HIGH', disposition: 'kept' });
  for (const af of map.single_reviewer) out.push({ finding: af.finding, reviewers: af.reviewers, confidence: 'MEDIUM', disposition: 'kept' });
  for (const af of map.disputed) {
    const r = ruling.get(af.finding.id) ?? 'UNRESOLVED';
    out.push({ finding: af.finding, reviewers: af.reviewers, confidence: 'LOW', disposition: r === 'REJECT' ? 'rejected' : 'kept', ruling: r });
  }
  return out;
}

const bySeverity = (a: ScoredFinding, b: ScoredFinding): number => SEV_RANK[a.finding.severity] - SEV_RANK[b.finding.severity];

export function renderReviewReport(ctx: RunCtx, map: ReviewMap, judge: JudgeReport): string {
  const scored = scoreFindings(map, judge);
  const kept = scored.filter((s) => s.disposition === 'kept').sort(bySeverity);
  const rejected = scored.filter((s) => s.disposition === 'rejected');
  const flags = [...ctx.flags];
  const L: string[] = [];

  L.push(`# Code Review — ${ctx.runId}`, '');
  L.push(`- Reviewers: ${map.per_reviewer.map((r) => disp(r.provider)).join(', ')}  ·  Judge: ${disp(ctx.roles.judge)}  ·  calls: ${ctx.calls.length}/${ctx.budget.limit}`);
  if (flags.length) L.push(`- ⚠ Flags: ${flags.join(', ')}`);
  L.push('');

  L.push('## Verdict', '', judge.verdict, '');

  const p0p1 = kept.filter((s) => s.finding.severity === 'P0' || s.finding.severity === 'P1');
  L.push(`## Findings (${kept.length} kept${p0p1.length ? `, ${p0p1.length} P0/P1` : ''})`, '');
  if (kept.length) {
    L.push('| Sev | Location | Conf | Category | Finding | Reviewers |', '|---|---|---|---|---|---|');
    for (const s of kept) {
      const f = s.finding;
      L.push(`| ${f.severity} | ${f.file}:${f.line_start}-${f.line_end} | ${s.confidence} | ${f.category} | ${f.claim} | ${attrib(s.reviewers)} |`);
    }
  } else {
    L.push('_No defects held after review._');
  }
  L.push('');

  L.push('## Disagreement map', '');
  L.push(`**Consensus (both reviewers or cross-confirmed):** ${map.consensus.length}`);
  L.push(`**Single-reviewer:** ${map.single_reviewer.length}`);
  L.push(`**Disputed → adjudicated:** ${map.disputed.length}`);
  for (const d of map.disputed) {
    const r = judge.adjudications.find((a) => a.id === d.finding.id);
    L.push(`- **${d.finding.id}** ${d.finding.file}:${d.finding.line_start}-${d.finding.line_end}${r ? ` → ${r.ruling}` : ''}: ${d.finding.claim}`);
    if (d.refutation) L.push(`  - refutation: ${d.refutation}`);
    if (r) L.push(`  - judge: ${r.reasoning}`);
  }
  L.push('');

  if (rejected.length) {
    L.push(`## Rejected (adjudicated false positives): ${rejected.length}`, '');
    for (const s of rejected) L.push(`- ${s.finding.file}:${s.finding.line_start}-${s.finding.line_end} — ${s.finding.claim}`);
    L.push('');
  }

  L.push('## Per-reviewer stats', '', '| Reviewer | Raised | Kept (valid) | Dropped (bad file:line) |', '|---|---|---|---|');
  for (const r of map.per_reviewer) L.push(`| ${disp(r.provider)} | ${r.raised} | ${r.kept} | ${r.dropped} |`);
  L.push('');

  L.push('## Dissent', '');
  for (const d of judge.dissent) L.push(`- ${d}`);
  L.push('', `_Confidence: ${judge.confidence_notes}_`, '');

  L.push('## Raw artifacts', '', '- reviewer findings: `04-role-outputs/`', '- cross-exam: `08-verifications.json`', '- disagreement map: `07-review-map.json`', '- judge report: `09-judge-report.json`', '- diff: `inputs/diff.patch`', '');

  return L.join('\n');
}

export async function s10ReviewRender(ctx: RunCtx, map: ReviewMap, judge: JudgeReport): Promise<void> {
  await ctx.writer.writeText('final-report', renderReviewReport(ctx, map, judge));
}
