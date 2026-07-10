// S10 — artifact rendering (§9, §12.1, §307). Pure code → `final-report.md`, a DECISION BRIEF, not a
// smoothed essay (§263). Every section is assembled deterministically from prior artifacts; the only
// computed content is the assumption-audit status/confidence, which is DERIVED here (not taken from
// the judge — §624). A truly missing required field is a template bug (fail loudly); degraded-but-valid
// states (S8 skipped, items UNVERIFIED, empty consensus) render normally. User-facing → DISPLAY_NAME.

import type { ActionPlanArtifact, IntentContract, JudgeReport, Recommendation, VerificationSet } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { DISPLAY_NAME } from '../../providers/types.js';
import type { RunCtx } from '../context.js';
import { overlap, tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';
import type { RubricItem } from './s7-decision-graph.js';
import type { DecisionGraph } from '../decision-graph.js';

export interface AuditRow {
  id: string;
  statement: string;
  providers: ProviderId[];
  status: 'held' | 'failed' | 'unverified';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** Pure graph-backed decision audit. */
export function deriveAudit(graph: DecisionGraph, judgeReport: JudgeReport): AuditRow[] {
  const ruling = new Map(judgeReport.adjudications.map((a) => [a.id, a.ruling]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));

  return graph.claims.map((claim) => {
    const positions = claim.position_ids.map((id) => positionById.get(id)!);
    const providers = [...new Set(positions.map((position) => position.provider))];
    let status: AuditRow['status'];
    let confidence: AuditRow['confidence'];
    if (claim.state === 'UNCERTAIN' || claim.evidence_state !== 'SUPPORTED') {
      [status, confidence] = ['unverified', 'LOW'];
    } else if (claim.state === 'SHARED_CONCERN' || (claim.state === 'UNIQUE' && positions[0]?.stance === 'OPPOSE')) {
      [status, confidence] = ['failed', providers.length >= 2 ? 'HIGH' : 'MEDIUM'];
    } else if (claim.state === 'DISAGREEMENT') {
      const result = ruling.get(claim.id);
      if (result === 'UPHOLD') [status, confidence] = ['failed', 'MEDIUM'];
      else if (result === 'REJECT') [status, confidence] = ['held', 'MEDIUM'];
      else [status, confidence] = ['unverified', 'LOW'];
    } else {
      [status, confidence] = ['held', providers.length >= 2 ? 'HIGH' : 'MEDIUM'];
    }
    return { id: claim.id, statement: claim.proposition, providers, status, confidence };
  });
}

const disp = (id: ProviderId): string => DISPLAY_NAME[id];
const attrib = (ps: ProviderId[]): string => ps.map(disp).join(', ');

/** Union of the seats' decision questions, deduped by lexical similarity (≥0.85), capped. */
export function mergeOpenQuestions(seats: SeatOutput[], cap = 10): string[] {
  const kept: Array<{ q: string; tokens: Set<string> }> = [];
  for (const seat of seats) {
    for (const { question: q } of seat.output.decision_questions) {
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

/** Exact rubric coverage derived from graph dimension anchors and holes. */
export function deriveScorecard(rubric: RubricItem[], graph: DecisionGraph): ScorecardRow[] {
  const blind = new Set(graph.holes.coverage.map((hole) => hole.dimension_id));
  const claimByPosition = new Map(graph.claims.flatMap((claim) => claim.position_ids.map((id) => [id, claim] as const)));
  return rubric.map((r) => {
    if (blind.has(r.id)) return { id: r.id, label: r.label, status: 'unexamined' as const };
    const contested = graph.positions
      .filter((position) => position.dimension_id === r.id)
      .some((position) => {
        const state = claimByPosition.get(position.id)?.state;
        return state === 'DISAGREEMENT' || state === 'UNCERTAIN';
      });
    return { id: r.id, label: r.label, status: contested ? 'contested' : 'examined' };
  });
}

export interface S10Args {
  contract: IntentContract;
  seats: SeatOutput[];
  graph: DecisionGraph;
  verifications: VerificationSet;
  judgeReport: JudgeReport;
  actionPlan?: ActionPlanArtifact;
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
  const { seats, graph, judgeReport, actionPlan } = args;
  const flags = [...ctx.flags];
  const audit = deriveAudit(graph, judgeReport);
  const scorecard = args.rubric ? deriveScorecard(args.rubric, graph) : [];
  const rulingById = new Map(judgeReport.adjudications.map((a) => [a.id, a]));
  const positionById = new Map(graph.positions.map((position) => [position.id, position]));
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
    if (flags.includes('synthesis_suspect')) L.push('> ⚠ synthesis_suspect — the chair output required deterministic repair or degradation handling.', '');
    for (const p of judgeReport.key_points) L.push(`- ${p}`);
    L.push('');
  } else if (flags.includes('synthesis_suspect')) {
    L.push("## Chairman's reasoning", '', '> ⚠ synthesis_suspect — no reliable chairman reasoning was produced.', '');
  }

  if (scorecard.length) {
    L.push('## Dimension scorecard', '', '| Dimension | Status |', '|---|---|');
    for (const r of scorecard) L.push(`| ${mdCell(r.label)} | ${r.status} |`);
    L.push('');
  }

  L.push('## Decision audit', '', '| Claim | Status | Confidence | Analysts |', '|---|---|---|---|');
  for (const r of audit) L.push(`| ${mdCell(r.statement)} | ${r.status} | ${r.confidence} | ${attrib(r.providers)} |`);
  L.push('');

  const failed = audit.filter((r) => r.status === 'failed');
  if (failed.length) {
    L.push('## Risks that held up', '');
    for (const r of failed) L.push(`- ${r.statement} _(${r.confidence})_`);
    L.push('');
  }

  const sharedConcerns = graph.claims.filter((claim) => claim.state === 'SHARED_CONCERN');
  if (sharedConcerns.length) {
    L.push('## Shared concerns', '');
    for (const claim of sharedConcerns) {
      const providers = [...new Set(claim.position_ids.map((id) => positionById.get(id)!.provider))];
      L.push(`- ${claim.proposition} _(${attrib(providers)})_`);
    }
    L.push('');
  }

  const disagreements = graph.claims.filter((claim) => claim.state === 'DISAGREEMENT');
  if (disagreements.length) {
    L.push('## The debate', '');
    for (const claim of disagreements) {
      const adj = rulingById.get(claim.id);
      const positions = claim.position_ids.map((id) => positionById.get(id)!);
      L.push(
        `- **${claim.proposition}** — ${positions.map((position) => `${disp(position.provider)} ${position.stance.toLowerCase()}: ${position.reasoning}`).join(' · ')}. ` +
          `Chair: ${rulingPhrase(adj?.ruling)}${adj?.reasoning ? ` — ${adj.reasoning}` : ''}.`,
      );
    }
    L.push('');
  }

  if (actionPlan) {
    L.push('## Validation plan', '');
    if ('kind' in actionPlan) {
      const planFlags = flags.filter((flag) => flag === 'plan_fallback' || flag === 'plan_skipped');
      L.push(`> ⚠ Planner unavailable: ${actionPlan.reason}${planFlags.length ? ` (${planFlags.join(', ')})` : ''}.`, '', 'Unresolved questions:');
      for (const question of actionPlan.unresolved_questions) L.push(`- ${question}`);
      L.push('');
    } else {
      L.push('| # | Action | Why | Validates | Effort | Kill signal |', '|---|---|---|---|---|---|');
      for (const a of actionPlan.actions) {
        L.push(`| ${a.order} | ${mdCell(a.action)} | ${mdCell(a.why)} | ${mdCell(a.validates)} | ${a.effort} | ${mdCell(a.kill_signal)} |`);
      }
      L.push('', actionPlan.sequencing_note, '');
    }
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

  L.push('## Decision graph', '');
  for (const state of ['CONSENSUS', 'SHARED_CONCERN', 'DISAGREEMENT', 'UNIQUE', 'UNCERTAIN'] as const) {
    const claims = graph.claims.filter((claim) => claim.state === state);
    L.push(`**${state.replaceAll('_', ' ').toLowerCase()}:** ${claims.length}`);
    for (const claim of claims) L.push(`- ${claim.proposition}`);
    L.push('');
  }
  if (graph.holes.coverage.length || graph.holes.evidence.length) {
    L.push('**Unresolved holes:**');
    for (const hole of graph.holes.coverage) L.push(`- Coverage: ${hole.label}`);
    for (const hole of graph.holes.evidence) {
      const claim = graph.claims.find((item) => item.id === hole.claim_id);
      L.push(`- Evidence: ${claim?.proposition ?? hole.claim_id} — ${hole.reason}`);
    }
  }
  L.push('');

  L.push('## Receipt', '', ...receiptLines(ctx), '');

  return L.join('\n');
}

export async function s10Render(ctx: RunCtx, args: S10Args): Promise<void> {
  await ctx.writer.writeText('final-report', renderReport(ctx, args));
}
