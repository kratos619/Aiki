// code-review S9 — judge adjudication (§12.2, T10). The judge (agy/Gemini — it authored NO finding, so
// it can adjudicate cleanly) rules on the DISPUTED findings only (those one reviewer flagged as a false
// positive in cross-exam). Ruling polarity is finding-centric here (NOT idea S9's attack-centric one):
//   UPHOLD = genuine defect, keep it   ·   REJECT = false positive, drop it   ·   UNRESOLVED = undecided.
//
// SAFETY (grilled 2026-07-04): the judge runs with cwd = the RUN DIR, never the repo — it only sees
// findings text in its prompt, so agy's unverified --sandbox write-blocking can't touch the repo. Zero
// disputes → no judge call; synthesize a deterministic verdict.

import type { JudgeReport as JudgeReportT, ReviewMap } from '../../schemas/index.js';
import { JudgeReportModel } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { adjudicationScopeViolations } from './s9-judge.js';
import { loadSkill } from '../skills.js';

const S9_PROMPT = `ROLE: Judge on a code review. Two independent reviewers disagreed on the findings below:
one reviewer reported each as a defect; another flagged it as a likely FALSE POSITIVE (see "refutation").
For EACH disputed finding, rule from the evidence and refutation given (you have findings text only):
- UPHOLD = it IS a genuine defect (keep it),
- REJECT = it is a false positive (drop it),
- UNRESOLVED = genuinely undecided.{{SKILL}}
Output ONLY JSON matching the judge schema:
- adjudications: for EACH disputed id → {id, ruling: UPHOLD|REJECT|UNRESOLVED, reasoning ≤3 sentences, evidence_cited}.
- verdict: ≤80 words — overall assessment of the change (roughly how many real defects, worst severity).
- dissent: ≥1 item — the strongest argument against your own verdict. Empty dissent is invalid.
- confidence_notes: which findings you hold HIGH/MEDIUM/LOW and why.
DISPUTED FINDINGS: {{DISPUTED_JSON}}`;

/**
 * Fill the judge template: {{DISPUTED_JSON}} → the disputes, {{SKILL}} → the judge playbook (or nothing).
 * An empty skill collapses the slot, so the prompt is byte-for-byte the pre-skill baseline.
 */
export function buildJudgePrompt(disputes: unknown, skill: string): string {
  return S9_PROMPT.replace('{{DISPUTED_JSON}}', JSON.stringify(disputes, null, 2)).replace('{{SKILL}}', skill ? `\n\n${skill}` : '');
}

export async function s9ReviewJudge(ctx: RunCtx, map: ReviewMap): Promise<JudgeReportT> {
  const disputeIds = map.disputed.map((d) => d.finding.id);

  // No disputes → nothing to adjudicate; synthesize a verdict deterministically (save the call).
  if (disputeIds.length === 0) {
    const kept = map.consensus.length + map.single_reviewer.length;
    const report: JudgeReportT = {
      adjudications: [],
      verdict: `${kept} finding(s) reported, none disputed by the reviewers.`,
      dissent: ['(no disputed findings — nothing to contest)'],
      confidence_notes: 'Consensus findings HIGH; single-reviewer findings MEDIUM.',
    };
    await ctx.writer.writeJson('judge-report', report);
    return report;
  }

  const disputes = map.disputed.map((d) => ({
    id: d.finding.id,
    file: d.finding.file,
    lines: `${d.finding.line_start}-${d.finding.line_end}`,
    severity: d.finding.severity,
    category: d.finding.category,
    claim: d.finding.claim,
    evidence: d.finding.evidence,
    refutation: d.refutation ?? '',
  }));
  const basePrompt = buildJudgePrompt(disputes, loadSkill('code-review', 'judge'));

  // Judge runs on cwd = run dir (NOT the repo) — sidesteps agy's unverified sandbox.
  const judge = ctx.handle(ctx.roles.judge);
  const opts = { cwd: ctx.writer.dir };
  let report = await jsonCall(ctx, judge, 'S9', basePrompt, JudgeReportModel, opts);

  // Anti-scope + mandatory-dissent guard → one targeted re-ask (mirrors idea S9).
  let violations = adjudicationScopeViolations(report, disputeIds);
  if (violations.length || report.dissent.length === 0) {
    const fix =
      `${basePrompt}\n\n---\nYour previous output had problems:\n` +
      (violations.length ? `- adjudications must reference ONLY these disputed ids [${disputeIds.join(', ')}]; not: ${violations.join(', ')}\n` : '') +
      (report.dissent.length === 0 ? `- dissent must contain at least one item.\n` : '') +
      `Output ONLY the corrected JSON.`;
    try {
      report = await jsonCall(ctx, judge, 'S9-repair', fix, JudgeReportModel, opts);
      violations = adjudicationScopeViolations(report, disputeIds);
    } catch (e) {
      if (isFatal(e)) throw e; // keep the first report on a non-fatal repair failure
    }
  }

  const inScope = report.adjudications.filter((a) => new Set(disputeIds).has(a.id));
  if (inScope.length !== report.adjudications.length) ctx.addFlag('synthesis_suspect');
  let dissent = report.dissent;
  if (dissent.length === 0) {
    ctx.addFlag('synthesis_suspect');
    dissent = ['(none produced — flagged synthesis_suspect)'];
  }

  const final: JudgeReportT = { ...report, adjudications: inScope, dissent };
  await ctx.writer.writeJson('judge-report', final);
  return final;
}
