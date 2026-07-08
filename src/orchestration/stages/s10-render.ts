// S10 — artifact rendering (§9, §12.1, §307). Pure code → `final-report.md`, a DECISION BRIEF, not a
// smoothed essay (§263). Every section is assembled deterministically from prior artifacts; the only
// computed content is the assumption-audit status/confidence, which is DERIVED here (not taken from
// the judge — §624). A truly missing required field is a template bug (fail loudly); degraded-but-valid
// states (S8 skipped, items UNVERIFIED, empty consensus) render normally. User-facing → DISPLAY_NAME.

import type { ActionPlan, DisagreementMap, IntentContract, JudgeReport, Recommendation, VerificationSet } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';
import type { RubricItem } from './s7-disagreement.js';

export interface AuditRow {
  id: string;
  statement: string;
  providers: ProviderId[];
  status: 'held' | 'failed' | 'unverified';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Pure: derive the assumption-audit (held/failed/unverified + confidence) from the map + the judge's
 *  rulings on disputes. Consensus+undisputed → held/HIGH; single-provider+undisputed → held/MEDIUM;
 *  attack REJECTed → held/MEDIUM; UPHELD → failed/LOW; UNRESOLVED or unadjudicated → unverified/LOW. */
export function deriveAudit(map: DisagreementMap, judgeReport: JudgeReport): AuditRow[] {
  const contestedBy = new Map<string, string>(); // claim id → contradiction id
  for (const d of map.contradictions) for (const cid of d.claim_ids) contestedBy.set(cid, d.id);
  const ruling = new Map(judgeReport.adjudications.map((a) => [a.id, a.ruling]));

  return [...map.consensus, ...map.unique].map((c) => {
    const dispId = contestedBy.get(c.id);
    let status: AuditRow['status'];
    let confidence: AuditRow['confidence'];
    if (!dispId) {
      status = 'held';
      confidence = c.providers.length >= 2 ? 'HIGH' : 'MEDIUM';
    } else {
      const r = ruling.get(dispId);
      if (r === 'REJECT') [status, confidence] = ['held', 'MEDIUM'];
      else if (r === 'UPHOLD') [status, confidence] = ['failed', 'LOW'];
      else [status, confidence] = ['unverified', 'LOW']; // UNRESOLVED / unadjudicated
    }
    return { id: c.id, statement: c.statement, providers: c.providers, status, confidence };
  });
}

const disp = (id: ProviderId): string => DISPLAY_NAME[id];
const attrib = (ps: ProviderId[]): string => ps.map(disp).join(', ');

/** Union of the seats' open questions, deduped by lexical similarity (≥0.85), capped. */
export function mergeOpenQuestions(seats: SeatOutput[], cap = 10): string[] {
  const kept: Array<{ q: string; tokens: Set<string> }> = [];
  for (const seat of seats) {
    for (const q of seat.output.open_questions) {
      const tokens = tokenize(q);
      if (!kept.some((k) => overlap(k.tokens, tokens) >= 0.85)) kept.push({ q, tokens });
    }
  }
  return kept.slice(0, cap).map((k) => k.q);
}

export interface ScorecardRow {
  id: string;
  label: string;
  status: 'contested' | 'examined' | 'unexamined';
}

/** Best-effort rubric coverage for the report. This is intentionally coarse: it mirrors S7's keyword
 *  coverage, never throws, and labels the result honestly as best-effort in the renderer. */
export function deriveScorecard(rubric: RubricItem[], map: DisagreementMap): ScorecardRow[] {
  const claimById = new Map([...map.consensus, ...map.unique].map((c) => [c.id, c.statement]));
  const blind = new Set(map.blind_spots.map((b) => b.toLowerCase()));
  const contestedTexts = map.contradictions.map((d) => d.claim_ids.map((id) => claimById.get(id) ?? id).join(' '));
  return rubric.map((r) => {
    if (blind.has(r.label.toLowerCase())) return { id: r.id, label: r.label, status: 'unexamined' as const };
    const dimensionTokens = new Set([...tokenize(r.label), ...r.keywords.flatMap((kw) => [...tokenize(kw)])]);
    const contested = contestedTexts.some((text) => overlap(dimensionTokens, tokenize(text)) > 0);
    return { id: r.id, label: r.label, status: contested ? 'contested' : 'examined' };
  });
}

export interface S10Args {
  contract: IntentContract;
  seats: SeatOutput[];
  map: DisagreementMap;
  verifications: VerificationSet;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlan;
  rubric?: RubricItem[];
}

function recommendationLabel(r: Recommendation): string {
  return r === 'PROCEED_WITH_CONDITIONS' ? 'PROCEED WITH CONDITIONS' : r;
}

function mdCell(s: string): string {
  return s.replaceAll('\n', ' ').replaceAll('|', '\\|');
}

function rulingPhrase(ruling: string | undefined): string {
  if (ruling === 'UPHOLD') return 'the objection stands';
  if (ruling === 'REJECT') return 'the idea holds here';
  return 'left to you';
}

function receiptLines(ctx: RunCtx): string[] {
  const byProvider = new Map<ProviderId, number>();
  let ms = 0;
  for (const c of ctx.calls) {
    byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
    ms += c.durationMs;
  }
  const providerCounts = [...byProvider.entries()].map(([p, n]) => `${disp(p)} ${n}`).join(', ') || 'none';
  return [
    `- Calls: ${ctx.calls.length}/${ctx.budget.limit}`,
    `- By provider: ${providerCounts}`,
    `- Recorded model time: ${(ms / 1000).toFixed(1)}s`,
  ];
}

/** Build the markdown report (pure given the run context's read-only accounting). */
export function renderReport(ctx: RunCtx, args: S10Args): string {
  const { seats, map, judgeReport, actionPlan } = args;
  const flags = [...ctx.flags];
  const audit = deriveAudit(map, judgeReport);
  const scorecard = args.rubric ? deriveScorecard(args.rubric, map) : [];
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const claimById = new Map([...map.consensus, ...map.unique].map((c) => [c.id, c]));
  const L: string[] = [];

  L.push(`# Decision Brief — ${ctx.runId}`, '');
  L.push(`- Providers: ${ctx.available().map(disp).join(', ')}  ·  calls: ${ctx.calls.length}/${ctx.budget.limit}`);
  if (flags.length) L.push(`- ⚠ Flags: ${flags.join(', ')}`);
  L.push('');

  if (judgeReport.recommendation) {
    L.push('## Bottom line', '', `**${recommendationLabel(judgeReport.recommendation)}** — ${judgeReport.verdict}`, '');
    if (judgeReport.conditions?.length) {
      L.push('Conditions:');
      for (const c of judgeReport.conditions) L.push(`- ${c}`);
      L.push('');
    }
  } else {
    L.push('## Verdict', '', judgeReport.verdict, '');
  }

  if (judgeReport.key_points?.length) {
    L.push("## Chairman's reasoning", '');
    for (const p of judgeReport.key_points) L.push(`- ${p}`);
    L.push('');
  }

  if (scorecard.length) {
    L.push('## Dimension scorecard (best-effort)', '', '| Dimension | Status |', '|---|---|');
    for (const r of scorecard) L.push(`| ${mdCell(r.label)} | ${r.status} |`);
    L.push('');
  }

  L.push('## Assumption audit', '', '| Claim | Status | Confidence | Analysts |', '|---|---|---|---|');
  for (const r of audit) L.push(`| ${mdCell(r.statement)} | ${r.status} | ${r.confidence} | ${attrib(r.providers)} |`);
  L.push('');

  const failed = audit.filter((r) => r.status === 'failed');
  if (failed.length) {
    L.push('## Risks that held up', '');
    for (const r of failed) L.push(`- ${r.statement} _(${r.confidence})_`);
    L.push('');
  }

  if (map.contradictions.length) {
    L.push('## The debate', '');
    for (const d of map.contradictions) {
      const adj = rulingById.get(d.id);
      const claim = d.claim_ids.map((id) => claimById.get(id)?.statement ?? id).join(' / ');
      const claimants = [...new Set(d.claim_ids.flatMap((id) => claimById.get(id)?.providers ?? []))];
      const attackers = [...new Set(d.attacks.map((a) => a.provider))];
      L.push(
        `- ${attrib(claimants)} claimed ${claim}. ${attrib(attackers)} countered: ${d.attacks.map((a) => a.argument).join('; ')}. ` +
          `Chair: ${rulingPhrase(adj?.ruling)}${adj?.reasoning ? ` — ${adj.reasoning}` : ''}.`,
      );
    }
    L.push('');
  }

  if (actionPlan) {
    L.push('## Validation plan', '', '| # | Action | Why | Validates | Effort | Kill signal |', '|---|---|---|---|---|---|');
    for (const a of actionPlan.actions) {
      L.push(`| ${a.order} | ${mdCell(a.action)} | ${mdCell(a.why)} | ${mdCell(a.validates)} | ${a.effort} | ${mdCell(a.kill_signal)} |`);
    }
    L.push('', actionPlan.sequencing_note, '');
  }

  const questions = mergeOpenQuestions(seats);
  if (questions.length) {
    L.push('## Open questions that flip the verdict', '');
    for (const q of questions) L.push(`- ${q}`);
    L.push('');
  }

  L.push('## Red-team note', '');
  for (const d of judgeReport.dissent) L.push(`- ${d}`);
  L.push('', `_Confidence: ${judgeReport.confidence_notes}_`, '');

  L.push('## Strongest case (per analyst)', '');
  for (const seat of seats) L.push(`- **${disp(seat.provider)}:** ${seat.output.strongest_version}`);
  L.push('');

  L.push('## Disagreement map', '');
  L.push(`**Consensus (≥2 analysts):** ${map.consensus.length}`);
  for (const c of map.consensus) L.push(`- ${c.statement}  _(${attrib(c.providers)})_`);
  L.push('', `**Unique (one analyst):** ${map.unique.length}`);
  for (const c of map.unique) L.push(`- ${c.statement}  _(${attrib(c.providers)})_`);
  L.push('', `**Contradictions:** ${map.contradictions.length}`);
  for (const d of map.contradictions) {
    const adj = rulingById.get(d.id);
    L.push(`- **${d.id}** ${adj ? `→ ${adj.ruling}` : ''}: ${d.attacks.map((a) => a.argument).join('; ')}`);
  }
  if (map.blind_spots.length) {
    L.push('', `**Blind spots (rubric items no analyst addressed):**`);
    for (const b of map.blind_spots) L.push(`- ${b}`);
  }
  L.push('');

  L.push('## Receipt', '', ...receiptLines(ctx), '');

  return L.join('\n');
}

export async function s10Render(ctx: RunCtx, args: S10Args): Promise<void> {
  await ctx.writer.writeText('final-report', renderReport(ctx, args));
}
