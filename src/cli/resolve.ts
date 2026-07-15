// `aiki resolve <run-id>` (§5/§127) — the human review gate. Records a verdict on each of a run's
// annotatable items → appends `.aiki/feedback.jsonl`. Workflow-aware (T11):
//   idea-refinement → the judge's adjudicated contradictions, verdict correct/incorrect/unsure;
//   code-review     → the report's kept findings, verdict fixed/wontfix/false-positive (false-positive
//                     labels feed the bench PRECISION metric).
// Two entry paths: an interactive readline loop (needs a TTY) and non-interactive `--verdict <id>=<v>`
// (repeatable, used by tests/automation). Both funnel through the pure core in storage/feedback.ts.

import { createInterface, type Interface } from 'node:readline';
import type { DecisionGraph, DisagreementMap, Finding, JudgeReport, ReviewMap, RunMeta } from '../schemas/index.js';
import type { WorkflowId } from '../orchestration/context.js';
import { scoreFindings } from '../orchestration/stages/cr-report.js';
import { readJsonArtifact, resolveRunId, runDir } from '../storage/runs-read.js';
import { appendFeedback, buildFeedbackEntries, FeedbackError, parseVerdictFlags, VERDICT_VOCAB, type AdjItem, type FeedbackEntry, type Verdict } from '../storage/feedback.js';
import { adaptLegacyDecisionGraph } from '../orchestration/legacy-idea-adapter.js';

export interface ResolveOptions {
  verdict?: string[]; // repeatable --verdict <id>=<verdict>; presence ⇒ non-interactive
  root?: string; // runs root (hybrid, injected by the CLI entry); default '.aiki'.
}

/** A uniform annotatable item across workflows: id + a ruling/status snapshot + a display label. */
interface Annotatable {
  id: string;
  ruling: string;
  label: string;
}

/** Build the annotatable list for an idea-refinement run (adjudicated contradictions). */
function ideaItems(judge: JudgeReport, graph: DecisionGraph | null): Annotatable[] {
  return judge.adjudications.map((a) => {
    const claim = graph?.claims.find((item) => item.id === a.id);
    return { id: a.id, ruling: a.ruling, label: `[${a.ruling}] ${claim?.proposition ?? a.reasoning}` };
  });
}

/** Build the annotatable list for a code-review run (kept findings from the report). */
function reviewItems(map: ReviewMap, judge: JudgeReport): Annotatable[] {
  return scoreFindings(map, judge)
    .filter((s) => s.disposition === 'kept')
    .map((s) => ({
      id: s.finding.id,
      ruling: `${s.finding.severity}/${s.finding.category}/${s.confidence}`,
      label: `[${s.finding.severity} ${s.confidence}] ${s.finding.file}:${s.finding.line_start}-${s.finding.line_end} — ${s.finding.claim}`,
    }));
}

function ask(rl: Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

/** Interactive annotation loop. `keys` maps a single-char shortcut to a verdict. */
async function interactiveAnnotate(items: Annotatable[], keys: Record<string, Verdict>): Promise<Map<string, { verdict: Verdict; note?: string }>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const verdicts = new Map<string, { verdict: Verdict; note?: string }>();
  const legend = Object.entries(keys).map(([k, v]) => `[${k}]${v.slice(1)}`).join(' / ');
  process.stdout.write(`\n  ${items.length} item(s). For each: ${legend} / [s]kip / [q]uit\n`);
  try {
    for (const item of items) {
      process.stdout.write(`\n  ${item.id}  ${item.label}\n`);
      const key = (await ask(rl, `    verdict? `)).toLowerCase();
      if (key === 'q') break;
      if (key === 's' || key === '') continue;
      const verdict = keys[key];
      if (!verdict) {
        process.stdout.write(`    ? unrecognized "${key}" — skipping\n`);
        continue;
      }
      const note = await ask(rl, `    note (enter to skip): `);
      verdicts.set(item.id, { verdict, ...(note ? { note } : {}) });
    }
  } finally {
    rl.close();
  }
  return verdicts;
}

/** First-letter shortcut map for a workflow's vocab (correct→c, false-positive→f... unique-first-letter). */
function shortcutKeys(vocab: Verdict[]): Record<string, Verdict> {
  const keys: Record<string, Verdict> = {};
  for (const v of vocab) {
    let k = v[0]!;
    let i = 1;
    while (keys[k] && i < v.length) k = v[i++]!;
    keys[k] = v;
  }
  return keys;
}

export async function resolve(runArg: string | undefined, opts: ResolveOptions = {}): Promise<number> {
  const root = opts.root ?? '.aiki';
  const match = await resolveRunId(runArg, root);
  if (!match.ok) {
    if (match.kind === 'none') process.stderr.write('no runs found under .aiki/runs/\n');
    else if (match.kind === 'no-match') process.stderr.write(`no run matches "${match.arg}". Omit the id for the most recent run.\n`);
    else process.stderr.write(`"${match.arg}" is ambiguous — matches:\n${match.candidates.map((c) => `  ${c}`).join('\n')}\n`);
    return 1;
  }
  const dir = runDir(match.runId, root);
  const meta = await readJsonArtifact<RunMeta>(dir, 'meta.json');
  const workflow: WorkflowId = meta?.workflow ?? 'idea-refinement';
  const judge = await readJsonArtifact<JudgeReport>(dir, '09-judge-report.json');

  let items: Annotatable[];
  let itemType: FeedbackEntry['item_type'];
  if (workflow === 'code-review') {
    const map = await readJsonArtifact<ReviewMap>(dir, '07-review-map.json');
    if (map && judge) {
      items = reviewItems(map, judge);
    } else {
      // Single-call bench arms (A/B) write no review-map — annotate the harness-persisted
      // scored findings instead (raw/bench-findings.json, the precision denominator).
      const bench = await readJsonArtifact<Finding[]>(dir, 'raw/bench-findings.json');
      if (!bench || bench.length === 0) {
        process.stdout.write(`  run ${match.runId} has no findings to annotate.\n`);
        return 0;
      }
      items = bench.map((f) => ({
        id: f.id,
        ruling: `${f.severity}/${f.category}/BENCH`,
        label: `[${f.severity}] ${f.file}:${f.line_start}-${f.line_end} — ${f.claim}`,
      }));
    }
    itemType = 'finding';
  } else {
    if (!judge || judge.adjudications.length === 0) {
      process.stdout.write(`  run ${match.runId} has no adjudicated disputes to annotate.\n`);
      return 0;
    }
    const storedGraph = await readJsonArtifact<DecisionGraph>(dir, '07-decision-graph.json');
    const legacyMap = storedGraph ? null : await readJsonArtifact<DisagreementMap>(dir, '07-disagreement-map.json');
    items = ideaItems(judge, storedGraph ?? (legacyMap ? adaptLegacyDecisionGraph(legacyMap) : null));
    itemType = 'adjudication';
  }
  if (items.length === 0) {
    process.stdout.write(`  run ${match.runId} has no items to annotate.\n`);
    return 0;
  }

  const vocab = VERDICT_VOCAB[workflow];
  let verdicts: Map<string, { verdict: Verdict; note?: string }>;
  if (opts.verdict?.length) {
    try {
      verdicts = parseVerdictFlags(opts.verdict, vocab);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  } else if (!process.stdin.isTTY) {
    process.stderr.write(`resolve is interactive — in a non-interactive shell pass --verdict <id>=<${vocab.join('|')}>\n`);
    return 1;
  } else {
    verdicts = await interactiveAnnotate(items, shortcutKeys(vocab));
  }

  const annItems: AdjItem[] = items.map((i) => ({ id: i.id, ruling: i.ruling }));
  let entries;
  try {
    entries = buildFeedbackEntries(match.runId, workflow, annItems, verdicts, new Date(), itemType);
  } catch (e) {
    process.stderr.write(`${e instanceof FeedbackError ? e.message : String(e)}\n`);
    return 1;
  }
  if (entries.length === 0) {
    process.stdout.write('  no verdicts recorded.\n');
    return 0;
  }
  const path = await appendFeedback(entries);
  process.stdout.write(`  ✔ recorded ${entries.length} verdict(s) → ${path}\n`);
  return 0;
}
