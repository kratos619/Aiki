import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import type { WorkflowId } from '../orchestration/context.js';
import type { AnnotatedFinding, DisagreementMap, JudgeReport, ReviewMap, RoleOutput, RunMeta } from '../schemas/index.js';
import { listArtifacts, readJsonArtifact } from '../storage/runs-read.js';

type Column = { provider: string; title: string; lines: string[] };
type RowKind = 'consensus' | 'dispute' | 'unique' | 'single';
type CouncilRow = { kind: RowKind; title: string; detail: string; providers: ProviderId[]; ruling?: string };

// ── Human-facing narrative (idea workflow) ─────────────────────────────────────
// The raw artifacts speak in internal terms (contradiction ids, UPHOLD/REJECT, "consensus"). A normal
// reader wants: is my idea sound, what are the real risks, what got missed, what do I do next. These
// structured fields translate the artifacts into that story. All derived deterministically — no model
// call, no schema change.

export type Tone = 'good' | 'caution' | 'risk';
export interface Signal { label: string; tone: Tone; }
/** A dispute the judge UPHELD → the attack won → an assumption the idea leans on did NOT hold up. */
export interface RiskItem { assumption: string; severity: string; challenge: string; reasoning: string; providers: ProviderId[]; }
/** A dispute the judge REJECTED → the objection was dismissed → the idea holds up here. */
export interface DefendedItem { assumption: string; challenge: string; reasoning: string; }
export interface Agreement { statement: string; providers: ProviderId[]; }

export interface CouncilView {
  runId: string;
  workflow: WorkflowId;
  verdict: string;
  confidence: string;
  dissent: string[];
  columns: Column[];
  rows: CouncilRow[];
  stats: string[];
  calls: string;
  flags: string[];
  // Additive narrative fields (populated for idea-refinement; the TUI ignores them).
  topic?: string;
  moderator?: string;
  signal?: Signal;
  agreements?: Agreement[];
  risks?: RiskItem[];
  defended?: DefendedItem[];
  blindSpots?: string[];
  nextSteps?: string[];
  biggestRisk?: string;
  bestNextStep?: string;
}

function providerName(id: string): string {
  return id in DISPLAY_NAME ? DISPLAY_NAME[id as ProviderId] : id;
}

function findingLine(f: AnnotatedFinding['finding']): string {
  return `${f.severity}/${f.category} ${f.file}:${f.line_start}-${f.line_end} — ${f.claim}`;
}

function roleColumn(provider: string, role: RoleOutput): Column {
  if (role.workflow === 'code-review') {
    return {
      provider,
      title: providerName(provider),
      lines: role.findings.map(findingLine),
    };
  }
  return {
    provider,
    title: providerName(provider),
    lines: [
      `Strongest version: ${role.strongest_version}`,
      ...role.assumptions.map((a) => `${a.load_bearing ? 'Load-bearing' : 'Assumption'}: ${a.statement}`),
      ...role.attacks.map((a) => `Attack: ${a.argument}`),
      ...role.open_questions.map((q) => `Question: ${q}`),
    ],
  };
}

function judgeRulings(judge: JudgeReport | null): Map<string, string> {
  return new Map((judge?.adjudications ?? []).map((a) => [a.id, `${a.ruling}: ${a.reasoning}`]));
}

function codeReviewRows(map: ReviewMap, judge: JudgeReport | null): CouncilRow[] {
  const rulings = judgeRulings(judge);
  const row = (kind: RowKind, a: AnnotatedFinding): CouncilRow => ({
    kind,
    title: findingLine(a.finding),
    detail: a.refutation ?? a.finding.evidence,
    providers: a.reviewers,
    ruling: rulings.get(a.finding.id),
  });
  return [
    ...map.consensus.map((a) => row('consensus', a)),
    ...map.disputed.map((a) => row('dispute', a)),
    ...map.single_reviewer.map((a) => row('single', a)),
  ];
}

function ideaRows(map: DisagreementMap, judge: JudgeReport | null): CouncilRow[] {
  const rulings = judgeRulings(judge);
  return [
    ...map.consensus.map((c) => ({ kind: 'consensus' as const, title: c.statement, detail: c.evidence ?? '', providers: c.providers })),
    ...map.contradictions.map((d) => ({
      kind: 'dispute' as const,
      title: d.id,
      detail: d.attacks.map((a) => `${providerName(a.provider)}: ${a.argument}`).join(' · '),
      providers: d.attacks.map((a) => a.provider),
      ruling: rulings.get(d.id),
    })),
    ...map.unique.map((c) => ({ kind: 'unique' as const, title: c.statement, detail: c.evidence ?? '', providers: c.providers })),
  ];
}

const SEV_ORDER: Record<string, number> = { HIGH: 0, MED: 1, MEDIUM: 1, LOW: 2 };
function sevRank(s: string): number {
  return SEV_ORDER[s.toUpperCase()] ?? 1;
}
function maxSeverity(sevs: string[]): string {
  return [...sevs].sort((a, b) => sevRank(a) - sevRank(b))[0] ?? 'MED';
}
function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}
/** The intent-contract task is a third-person restatement ("The user is asking about …"). Strip that
 *  meta-preamble and keep the first sentence so the masthead reads as the plain question. */
function cleanTopic(t: string): string {
  let s = t.trim().replace(/^the user('?s)?\s+(is\s+asking\s+(about|for)|wants\s+to\s+know(\s+(if|whether|how))?|wants|is\s+asking|question\s+is|request\s+is|idea\s+is)\s*:?\s*/i, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const firstSentence = s.match(/^[^.?!]{25,}[.?!]/);
  return clip(firstSentence ? firstSentence[0] : s, 200);
}

function computeSignal(riskCount: number, agreeCount: number): Signal {
  if (riskCount === 0) return { tone: 'good', label: agreeCount ? 'Holds up well' : 'No major objections' };
  const tone: Tone = riskCount >= 3 ? 'risk' : 'caution';
  return { tone, label: agreeCount ? 'Feasible — with real caveats' : 'Proceed with caution' };
}

/** Turn the idea disagreement map + judge report into the human decision story. Deterministic. */
function ideaNarrative(map: DisagreementMap, judge: JudgeReport | null): Partial<CouncilView> {
  const claims = new Map<string, string>();
  for (const c of [...map.consensus, ...map.unique]) claims.set(c.id, c.statement);
  const adj = new Map((judge?.adjudications ?? []).map((a) => [a.id, a]));

  const disputes = map.contradictions.map((d) => {
    const a = adj.get(d.id);
    return {
      ruling: a?.ruling ?? '',
      assumption: d.claim_ids.map((id) => claims.get(id) ?? id).join(' '),
      challenge: d.attacks.map((x) => `${providerName(x.provider)}: ${x.argument}`).join('\n\n'),
      severity: maxSeverity(d.attacks.map((x) => x.severity)),
      reasoning: a?.reasoning ?? '',
      providers: d.attacks.map((x) => x.provider),
    };
  });

  const risks: RiskItem[] = disputes
    .filter((d) => d.ruling === 'UPHOLD')
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
    .map(({ assumption, severity, challenge, reasoning, providers }) => ({ assumption, severity, challenge, reasoning, providers }));
  const defended: DefendedItem[] = disputes
    .filter((d) => d.ruling === 'REJECT')
    .map(({ assumption, challenge, reasoning }) => ({ assumption, challenge, reasoning }));
  const agreements: Agreement[] = map.consensus.map((c) => ({ statement: c.statement, providers: c.providers }));
  const blindSpots = map.blind_spots ?? [];

  const nextSteps = [
    ...risks.map((r) => `Pressure-test the assumption “${clip(r.assumption, 130)}” — the council found it doesn't hold as stated.`),
    ...blindSpots.map((b) => `Work out: ${b}.`),
  ];

  return {
    signal: computeSignal(risks.length, agreements.length),
    agreements,
    risks,
    defended,
    blindSpots,
    nextSteps,
    biggestRisk: risks[0]?.assumption,
    bestNextStep: nextSteps[0],
  };
}

async function loadRoleOutputs(dir: string): Promise<Array<{ provider: string; role: RoleOutput }>> {
  const artifacts = await listArtifacts(dir);
  const roleFiles = artifacts.filter((f) => f.startsWith('04-role-outputs/') && f.endsWith('.json'));
  const roles = await Promise.all(roleFiles.map(async (file) => ({
    provider: basename(file, '.json'),
    role: JSON.parse(await readFile(join(dir, file), 'utf8')) as RoleOutput,
  })));
  return roles.sort((a, b) => providerName(a.provider).localeCompare(providerName(b.provider)));
}

export async function loadCouncilView(runId: string, dir: string): Promise<CouncilView | null> {
  const meta = await readJsonArtifact<RunMeta>(dir, 'meta.json');
  if (!meta) return null;
  const [judge, roles, intent] = await Promise.all([
    readJsonArtifact<JudgeReport>(dir, '09-judge-report.json'),
    loadRoleOutputs(dir),
    readJsonArtifact<{ task?: string }>(dir, '01-intent-contract.json'),
  ]);
  const columns = roles.map(({ provider, role }) => roleColumn(provider, role));
  const verdict = judge?.verdict ?? (meta.exit_status === 'ok' ? 'Run completed without a judge verdict artifact.' : `Run ${meta.exit_status}.`);
  let rows: CouncilRow[] = [];
  let stats: string[] = [];
  let narrative: Partial<CouncilView> = {};
  if (meta.workflow === 'code-review') {
    const map = await readJsonArtifact<ReviewMap>(dir, '07-review-map.json');
    if (map) {
      rows = codeReviewRows(map, judge);
      stats = [
        `${map.consensus.length} consensus`,
        `${map.disputed.length} disputed`,
        `${map.single_reviewer.length} single-reviewer`,
      ];
    }
  } else {
    const map = await readJsonArtifact<DisagreementMap>(dir, '07-disagreement-map.json');
    if (map) {
      rows = ideaRows(map, judge);
      stats = [
        `${map.consensus.length} consensus`,
        `${map.contradictions.length} disputes`,
        `${map.unique.length} unique`,
        `${map.blind_spots.length} blind spots`,
      ];
      narrative = ideaNarrative(map, judge);
    }
  }
  const moderator = meta.roles?.judge ? providerName(meta.roles.judge) : undefined;
  return {
    runId,
    workflow: meta.workflow,
    verdict,
    confidence: judge?.confidence_notes ?? '',
    dissent: judge?.dissent ?? [],
    columns,
    rows,
    stats,
    calls: `${meta.call_count}/${meta.budget.limit} provider calls`,
    flags: meta.flags ?? [],
    topic: intent?.task,
    moderator,
    ...narrative,
  };
}

// ── HTML rendering ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
/** Escape then turn blank-line gaps into paragraph breaks. */
function paras(s: string): string {
  return s
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replaceAll('\n', '<br>')}</p>`)
    .join('');
}
function sevClass(s: string): string {
  const r = sevRank(s);
  return r === 0 ? 'sev-high' : r === 2 ? 'sev-low' : 'sev-med';
}
function sevLabel(s: string): string {
  const r = sevRank(s);
  return r === 0 ? 'High severity' : r === 2 ? 'Low severity' : 'Medium severity';
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}
function providerDots(ids: ProviderId[]): string {
  const seen = new Set<string>();
  const names = ids.map(providerName).filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  if (!names.length) return '';
  return `<span class="who">${names.map((n) => `<span class="dot" title="${escapeHtml(n)}">${escapeHtml(initials(n))}</span>`).join('')}<span class="who-names">${escapeHtml(names.join(' · '))}</span></span>`;
}

function section(index: string, title: string, inner: string, delay: number, note = ''): string {
  return `
  <section class="block reveal" style="animation-delay:${delay}ms">
    <div class="block-head"><span class="idx">${index}</span><h2>${escapeHtml(title)}</h2></div>
    ${note ? `<p class="lede">${escapeHtml(note)}</p>` : ''}
    ${inner}
  </section>`;
}

function renderIdeaBody(view: CouncilView): string {
  const risks = view.risks ?? [];
  const agreements = view.agreements ?? [];
  const blindSpots = view.blindSpots ?? [];
  const defended = view.defended ?? [];
  const nextSteps = view.nextSteps ?? [];
  const signal = view.signal ?? { label: 'Reviewed', tone: 'caution' as Tone };

  const glance = `
    <div class="glance">
      <div class="stat good"><span class="n">${agreements.length}</span><span class="k">agreed on</span></div>
      <div class="stat risk"><span class="n">${risks.length}</span><span class="k">risks that stand</span></div>
      <div class="stat caution"><span class="n">${blindSpots.length}</span><span class="k">not examined</span></div>
    </div>`;

  const hero = `
  <section class="verdict tone-${signal.tone} reveal" style="animation-delay:60ms">
    <span class="pill">${escapeHtml(signal.label)}</span>
    <p class="verdict-text">${escapeHtml(view.verdict)}</p>
    ${glance}
  </section>`;

  const bottomLine = (view.biggestRisk || view.bestNextStep)
    ? `<section class="bottomline reveal" style="animation-delay:120ms">
        ${view.biggestRisk ? `<div><span class="tag">Biggest risk</span><p>${escapeHtml(clip(view.biggestRisk, 200))}</p></div>` : ''}
        ${view.bestNextStep ? `<div><span class="tag">Start here</span><p>${escapeHtml(clip(view.bestNextStep, 200))}</p></div>` : ''}
      </section>`
    : '';

  const riskCards = risks.length
    ? risks.map((r) => `
      <article class="card risk-card">
        <div class="card-top"><span class="chip ${sevClass(r.severity)}">${escapeHtml(sevLabel(r.severity))}</span>${providerDots(r.providers)}</div>
        <h3>${escapeHtml(r.assumption)}</h3>
        <div class="field"><span class="fk">The challenge</span>${paras(r.challenge)}</div>
        ${r.reasoning ? `<div class="field"><span class="fk">Why it stands</span><p>${escapeHtml(r.reasoning)}</p></div>` : ''}
      </article>`).join('')
    : '<p class="muted">No assumption failed scrutiny — the council did not sustain any objection.</p>';

  const blindGrid = blindSpots.length
    ? `<ul class="checks">${blindSpots.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '<p class="muted">The council covered the major angles.</p>';

  const agreeList = agreements.length
    ? `<ul class="agree">${agreements.map((a) => `<li><p>${escapeHtml(a.statement)}</p>${providerDots(a.providers)}</li>`).join('')}</ul>`
    : '<p class="muted">No point drew agreement from more than one model.</p>';

  const steps = nextSteps.length
    ? `<ol class="steps">${nextSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '<p class="muted">No follow-ups derived.</p>';

  const defendedBlock = defended.length
    ? `<details class="fold reveal" style="animation-delay:0ms">
        <summary>Objections the council dismissed (${defended.length}) — your idea held up here</summary>
        <div class="fold-body">${defended.map((d) => `
          <article class="card mini">
            <h3>${escapeHtml(clip(d.assumption, 160))}</h3>
            <div class="field"><span class="fk">Objection</span>${paras(d.challenge)}</div>
            ${d.reasoning ? `<div class="field"><span class="fk">Why it was dismissed</span><p>${escapeHtml(d.reasoning)}</p></div>` : ''}
          </article>`).join('')}</div>
      </details>`
    : '';

  return `
    ${hero}
    ${bottomLine}
    ${section('01', 'Risks that held up', riskCards, 180, 'Assumptions your idea depends on that the council challenged — and the challenge stuck.')}
    ${section('02', 'Blind spots — answer these before you build', blindGrid, 240, 'Nobody on the council examined these. They are usually where ideas actually fail.')}
    ${section('03', 'Where the models agreed', agreeList, 300, 'Points more than one model independently backed.')}
    ${section('04', 'Recommended next steps', steps, 360, 'Derived from the risks and blind spots above.')}
    ${defendedBlock}
    ${renderTechnical(view)}
  `;
}

function renderReviewBody(view: CouncilView): string {
  const badge = (k: RowKind): string => {
    const label = k === 'consensus' ? 'Both agreed' : k === 'dispute' ? 'Disputed' : k === 'single' ? 'One reviewer' : k;
    return `<span class="chip k-${k}">${escapeHtml(label)}</span>`;
  };
  const rows = view.rows.map((r) => `
    <article class="card">
      <div class="card-top">${badge(r.kind)}${providerDots(r.providers)}</div>
      <h3>${escapeHtml(r.title)}</h3>
      ${r.detail ? `<div class="field"><span class="fk">Detail</span><p>${escapeHtml(r.detail)}</p></div>` : ''}
      ${r.ruling ? `<div class="field"><span class="fk">Judge</span><p>${escapeHtml(r.ruling)}</p></div>` : ''}
    </article>`).join('');
  const statsRow = view.stats.map((s) => `<span class="mchip">${escapeHtml(s)}</span>`).join('');
  const hero = `
  <section class="verdict tone-caution reveal" style="animation-delay:60ms">
    <span class="pill">Review complete</span>
    <p class="verdict-text">${escapeHtml(view.verdict)}</p>
    <div class="mstrip">${statsRow}</div>
  </section>`;
  return `
    ${hero}
    ${section('01', 'Findings', rows || '<p class="muted">No findings recorded.</p>', 180, 'Every issue the reviewers raised, and where they agreed or disagreed.')}
    ${renderTechnical(view)}
  `;
}

/** Collapsed power-user block: per-model raw output, dissent, confidence notes. */
function renderTechnical(view: CouncilView): string {
  const columns = view.columns.map((c) => `
    <div class="col">
      <h4>${escapeHtml(c.title)}</h4>
      ${c.lines.length ? `<ul>${c.lines.slice(0, 12).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '<p class="muted">No output recorded.</p>'}
    </div>`).join('');
  const dissent = view.dissent.length ? `<ul>${view.dissent.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>';
  return `
  <details class="fold reveal" style="animation-delay:0ms">
    <summary>Full council analysis (technical)</summary>
    <div class="fold-body">
      <h4 class="fold-h">Each model, in its own words</h4>
      <div class="cols">${columns || '<p class="muted">No model output recorded.</p>'}</div>
      <h4 class="fold-h">The moderator's strongest counter-argument (dissent)</h4>
      ${dissent}
      <h4 class="fold-h">Confidence notes</h4>
      <p>${escapeHtml(view.confidence || 'None recorded.')}</p>
    </div>
  </details>`;
}

export function renderCouncilHtml(view: CouncilView): string {
  const isIdea = view.workflow !== 'code-review';
  const kicker = isIdea ? 'aiki · idea refinement' : 'aiki · code review';
  const title = isIdea && view.topic ? cleanTopic(view.topic) : (isIdea ? 'Idea refinement' : 'Code review');
  const panel = view.columns.map((c) => c.title);
  const metaBits = [
    panel.length ? `Panel: ${panel.join(' · ')}` : '',
    view.moderator ? `Moderator: ${view.moderator}` : '',
    view.calls,
  ].filter(Boolean);
  const flags = view.flags.length
    ? `<div class="warns">${view.flags.map((f) => `<span class="warn">⚑ ${escapeHtml(f.replaceAll('_', ' '))}</span>`).join('')}</div>`
    : '';
  const body = isIdea ? renderIdeaBody(view) : renderReviewBody(view);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(isIdea ? 'Idea refinement' : 'Code review')} — aiki council</title>
<style>
:root{
  color-scheme: light;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Charter,Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Avenir Next","Segoe UI",system-ui,sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
  --paper:#f4efe4; --panel:#fbf8f1; --ink:#221d16; --soft:#6c6151; --faint:#8b8172; --line:#ddd3bf;
  --good:#3d6b4e; --good-bg:#e7efe4; --risk:#a4392a; --risk-bg:#f6e5df;
  --caution:#966410; --caution-bg:#f6ebd3; --slate:#4a6272; --accent:#7a2f24;
}
*{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{margin:0;background:
  radial-gradient(120% 60% at 100% -10%, rgba(122,47,36,.05), transparent 60%),
  radial-gradient(90% 50% at -10% 0%, rgba(61,107,78,.05), transparent 55%),
  var(--paper);
  color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.55;
  background-attachment:fixed;}
main{max-width:820px;margin:0 auto;padding:48px 26px 90px;}
a{color:var(--accent);}
h1,h2,h3,h4{font-family:var(--serif);font-weight:600;letter-spacing:-.01em;}
p{margin:0 0 .6em;}

/* masthead */
.mast{border-bottom:2px solid var(--ink);padding-bottom:22px;margin-bottom:30px;}
.kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);}
.mast h1{font-size:clamp(28px,4.6vw,42px);line-height:1.12;margin:12px 0 16px;}
.mmeta{display:flex;flex-wrap:wrap;gap:7px;}
.mmeta span{font-family:var(--mono);font-size:11.5px;color:var(--soft);border:1px solid var(--line);background:var(--panel);border-radius:100px;padding:3px 10px;}
.warns{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;}
.warn{font-family:var(--mono);font-size:11.5px;color:var(--caution);background:var(--caution-bg);border:1px solid #e6d09b;border-radius:6px;padding:3px 9px;}

/* verdict hero */
.verdict{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:26px 28px 22px;margin-bottom:18px;overflow:hidden;}
.verdict::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;}
.tone-good::before{background:var(--good);} .tone-caution::before{background:var(--caution);} .tone-risk::before{background:var(--risk);}
.pill{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.02em;
  padding:5px 13px;border-radius:100px;margin-bottom:14px;}
.tone-good .pill{background:var(--good-bg);color:var(--good);} .tone-caution .pill{background:var(--caution-bg);color:var(--caution);}
.tone-risk .pill{background:var(--risk-bg);color:var(--risk);}
.verdict-text{font-family:var(--serif);font-size:clamp(19px,2.5vw,23px);line-height:1.45;color:var(--ink);margin:0;}
.glance{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:22px;}
.stat{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:14px 12px;text-align:center;}
.stat .n{display:block;font-family:var(--serif);font-size:30px;line-height:1;}
.stat .k{display:block;font-size:12.5px;color:var(--soft);margin-top:6px;}
.stat.good .n{color:var(--good);} .stat.risk .n{color:var(--risk);} .stat.caution .n{color:var(--caution);}

/* bottom line */
.bottomline{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:34px;}
.bottomline > div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;}
.tag{display:inline-block;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:7px;}
.bottomline p{margin:0;font-size:15px;color:var(--ink);}

/* sections */
.block{margin:38px 0;}
.block-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:14px;}
.idx{font-family:var(--mono);font-size:12px;color:var(--faint);letter-spacing:.1em;}
.block h2{font-size:22px;margin:0;}
.lede{color:var(--soft);font-size:14.5px;margin:0 0 16px;max-width:62ch;}

/* cards */
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px;transition:box-shadow .18s ease,transform .18s ease;}
.card:hover{box-shadow:0 6px 22px rgba(34,29,22,.07);transform:translateY(-1px);}
.risk-card{border-left:4px solid var(--risk);}
.card.mini{border-left:4px solid var(--slate);}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
.card h3{font-size:18px;line-height:1.35;margin:0 0 12px;}
.card.mini h3{font-size:15.5px;}
.field{margin-top:10px;}
.fk{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin-bottom:4px;}
.field p{margin:0 0 .5em;font-size:14.5px;color:#3d3629;}
.chip{font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;white-space:nowrap;}
.sev-high{background:var(--risk-bg);color:var(--risk);} .sev-med{background:var(--caution-bg);color:var(--caution);} .sev-low{background:#e7edf0;color:var(--slate);}
.k-consensus{background:var(--good-bg);color:var(--good);} .k-dispute{background:var(--risk-bg);color:var(--risk);} .k-single,.k-unique{background:#e7edf0;color:var(--slate);}

/* provider dots */
.who{display:inline-flex;align-items:center;gap:6px;}
.dot{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:9.5px;font-weight:700;}
.who-names{font-size:12px;color:var(--soft);}

/* blind spots */
.checks{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.checks li{position:relative;background:var(--caution-bg);border:1px solid #e6d09b;border-radius:10px;padding:12px 14px 12px 38px;font-size:14.5px;color:#5f4a15;}
.checks li::before{content:"?";position:absolute;left:12px;top:50%;transform:translateY(-50%);width:18px;height:18px;border-radius:50%;background:var(--caution);color:#fff;font-family:var(--mono);font-size:11px;font-weight:700;display:grid;place-items:center;}

/* agreements */
.agree{list-style:none;margin:0;padding:0;}
.agree li{border-left:4px solid var(--good);background:var(--good-bg);border-radius:0 10px 10px 0;padding:13px 16px;margin-bottom:10px;}
.agree li p{margin:0 0 8px;font-size:15px;}

/* steps */
.steps{margin:0;padding:0;list-style:none;counter-reset:s;}
.steps li{counter-increment:s;position:relative;padding:12px 0 12px 46px;border-bottom:1px solid var(--line);font-size:15px;}
.steps li:last-child{border-bottom:0;}
.steps li::before{content:counter(s);position:absolute;left:0;top:11px;width:28px;height:28px;border-radius:50%;border:1.5px solid var(--accent);color:var(--accent);font-family:var(--mono);font-size:13px;font-weight:600;display:grid;place-items:center;}

/* folds */
.fold{margin:24px 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;}
.fold > summary{cursor:pointer;list-style:none;padding:16px 20px;font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);display:flex;align-items:center;gap:10px;}
.fold > summary::-webkit-details-marker{display:none;}
.fold > summary::before{content:"+";font-size:16px;color:var(--accent);}
.fold[open] > summary::before{content:"–";}
.fold[open] > summary{border-bottom:1px solid var(--line);color:var(--ink);}
.fold-body{padding:6px 20px 20px;}
.fold-h{font-size:14px;color:var(--soft);margin:18px 0 8px;text-transform:none;letter-spacing:0;}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;}
.col{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:14px;}
.col h4{margin:0 0 10px;font-size:14px;}
.col ul,.fold-body ul{margin:0;padding-left:18px;}
.col li,.fold-body li{font-size:13px;color:#3d3629;margin-bottom:7px;}
.mstrip{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;}
.mchip{font-family:var(--mono);font-size:12px;color:var(--soft);border:1px solid var(--line);background:var(--paper);border-radius:100px;padding:3px 11px;}

.muted{color:var(--faint);font-style:italic;}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--faint);}

.reveal{opacity:0;transform:translateY(10px);animation:rise .5s cubic-bezier(.2,.7,.2,1) forwards;}
@keyframes rise{to{opacity:1;transform:none;}}
@media (max-width:640px){
  main{padding:34px 16px 60px;}
  .glance,.bottomline,.checks{grid-template-columns:1fr;}
}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;animation:none;}}
@media print{.reveal{opacity:1;transform:none;animation:none;}.fold[open]{break-inside:avoid;}}
</style>
</head>
<body>
<main>
  <header class="mast">
    <div class="kicker">${escapeHtml(kicker)}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="mmeta">${metaBits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</div>
    ${flags}
  </header>
  ${body}
  <footer>Generated by aiki · ${escapeHtml(view.runId)} · a local model council. This is analysis, not advice — verify before acting.</footer>
</main>
</body>
</html>`;
}

export async function writeCouncilHtml(runId: string, dir: string): Promise<string | null> {
  const view = await loadCouncilView(runId, dir);
  if (!view) return null;
  const path = join(dir, 'council-view.html');
  await writeFile(path, renderCouncilHtml(view));
  return path;
}
