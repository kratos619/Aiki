// S10 — artifact rendering (§9, §12.1, §307). Pure code → `final-report.md`, a DECISION BRIEF, not a
// smoothed essay (§263). Every section is assembled deterministically from prior artifacts; the only
// computed content is the assumption-audit status/confidence, which is DERIVED here (not taken from
// the judge — §624). A truly missing required field is a template bug (fail loudly); degraded-but-valid
// states (S8 skipped, items UNVERIFIED, empty consensus) render normally. User-facing → DISPLAY_NAME.

import type { DisagreementMap, IntentContract, JudgeReport, VerificationSet } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';

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
function mergeOpenQuestions(seats: SeatOutput[], cap = 10): string[] {
  const kept: Array<{ q: string; tokens: Set<string> }> = [];
  for (const seat of seats) {
    for (const q of seat.output.open_questions) {
      const tokens = tokenize(q);
      if (!kept.some((k) => overlap(k.tokens, tokens) >= 0.85)) kept.push({ q, tokens });
    }
  }
  return kept.slice(0, cap).map((k) => k.q);
}

export interface S10Args {
  contract: IntentContract;
  seats: SeatOutput[];
  map: DisagreementMap;
  verifications: VerificationSet;
  judgeReport: JudgeReport;
}

/** Build the markdown report (pure given the run context's read-only accounting). */
export function renderReport(ctx: RunCtx, args: S10Args): string {
  const { seats, map, judgeReport } = args;
  const flags = [...ctx.flags];
  const audit = deriveAudit(map, judgeReport);
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const L: string[] = [];

  L.push(`# Decision Brief — ${ctx.runId}`, '');
  L.push(`- Providers: ${ctx.available().map(disp).join(', ')}  ·  calls: ${ctx.calls.length}/${ctx.budget.limit}`);
  if (flags.length) L.push(`- ⚠ Flags: ${flags.join(', ')}`);
  L.push('');

  L.push('## Verdict', '', judgeReport.verdict, '');

  L.push('## Strongest case (per analyst)', '');
  for (const seat of seats) L.push(`- **${disp(seat.provider)}:** ${seat.output.strongest_version}`);
  L.push('');

  L.push('## Assumption audit', '', '| Claim | Status | Confidence | Analysts |', '|---|---|---|---|');
  for (const r of audit) L.push(`| ${r.statement} | ${r.status} | ${r.confidence} | ${attrib(r.providers)} |`);
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

  if (judgeReport.adjudications.length) {
    L.push('## Adjudications', '');
    for (const a of judgeReport.adjudications) L.push(`- **${a.id} — ${a.ruling}:** ${a.reasoning}`);
    L.push('');
  }

  L.push('## Dissent', '');
  for (const d of judgeReport.dissent) L.push(`- ${d}`);
  L.push('', `_Confidence: ${judgeReport.confidence_notes}_`, '');

  const questions = mergeOpenQuestions(seats);
  if (questions.length) {
    L.push('## Open questions for you', '');
    for (const q of questions) L.push(`- ${q}`);
    L.push('');
  }

  return L.join('\n');
}

export async function s10Render(ctx: RunCtx, args: S10Args): Promise<void> {
  await ctx.writer.writeText('final-report', renderReport(ctx, args));
}
