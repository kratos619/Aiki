// `aiki resolve <run-id>` (§5/§127) — the human review gate. Walks a run's adjudicated contradictions
// and records a verdict (correct/incorrect/unsure) on each judge ruling → appends `.aiki/feedback.jsonl`.
//
// Two entry paths (grilled 2026-07-04): an interactive readline loop (default, needs a TTY) and a
// non-interactive `--verdict <id>=<c|i|u>` (repeatable) used by tests/automation. Both funnel through the
// pure core in storage/feedback.ts, so the append logic is unit-tested without a TTY (§604).

import { createInterface, type Interface } from 'node:readline';
import type { DisagreementMap, JudgeReport, RunMeta } from '../schemas/index.js';
import type { WorkflowId } from '../orchestration/context.js';
import { readJsonArtifact, resolveRunId, runDir } from '../storage/runs-read.js';
import { appendFeedback, buildFeedbackEntries, FeedbackError, parseVerdictFlags, type AdjItem, type Verdict } from '../storage/feedback.js';

export interface ResolveOptions {
  verdict?: string[]; // repeatable --verdict <id>=<c|i|u>; presence ⇒ non-interactive
}

const RULING_GLOSS: Record<string, string> = { UPHOLD: 'attack upheld', REJECT: 'attack rejected', UNRESOLVED: 'unresolved' };

/** One line of context for an adjudicated item: the contested claim + the judge's ruling/reasoning. */
function itemContext(adj: JudgeReport['adjudications'][number], map: DisagreementMap | null): string {
  const c = map?.contradictions.find((x) => x.id === adj.id);
  const attack = c?.attacks[0]?.argument ?? '';
  return [`  ${adj.id}  [${adj.ruling} — ${RULING_GLOSS[adj.ruling] ?? ''}]`, attack ? `    dispute: ${attack}` : '', `    judge: ${adj.reasoning}`]
    .filter(Boolean)
    .join('\n');
}

function ask(rl: Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

const VERDICT_KEY: Record<string, Verdict> = { c: 'correct', i: 'incorrect', u: 'unsure' };

/** Interactive annotation loop over the adjudicated items. Returns the collected verdicts. */
async function interactiveAnnotate(
  items: AdjItem[],
  adjudications: JudgeReport['adjudications'],
  map: DisagreementMap | null,
): Promise<Map<string, { verdict: Verdict; note?: string }>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const verdicts = new Map<string, { verdict: Verdict; note?: string }>();
  process.stdout.write(`\n  ${items.length} adjudicated dispute(s). For each: [c]orrect / [i]ncorrect / [u]nsure / [s]kip / [q]uit\n`);
  try {
    for (const adj of adjudications) {
      process.stdout.write(`\n${itemContext(adj, map)}\n`);
      const key = (await ask(rl, `    verdict? `)).toLowerCase();
      if (key === 'q') break;
      if (key === 's' || key === '') continue;
      const verdict = VERDICT_KEY[key];
      if (!verdict) {
        process.stdout.write(`    ? unrecognized "${key}" — skipping\n`);
        continue;
      }
      const note = await ask(rl, `    note (enter to skip): `);
      verdicts.set(adj.id, { verdict, ...(note ? { note } : {}) });
    }
  } finally {
    rl.close();
  }
  return verdicts;
}

export async function resolve(runArg: string | undefined, opts: ResolveOptions = {}): Promise<number> {
  const match = await resolveRunId(runArg);
  if (!match.ok) {
    if (match.kind === 'none') process.stderr.write('no runs found under .aiki/runs/\n');
    else if (match.kind === 'no-match') process.stderr.write(`no run matches "${match.arg}". Omit the id for the most recent run.\n`);
    else process.stderr.write(`"${match.arg}" is ambiguous — matches:\n${match.candidates.map((c) => `  ${c}`).join('\n')}\n`);
    return 1;
  }
  const dir = runDir(match.runId);
  const [judge, map, meta] = await Promise.all([
    readJsonArtifact<JudgeReport>(dir, '09-judge-report.json'),
    readJsonArtifact<DisagreementMap>(dir, '07-disagreement-map.json'),
    readJsonArtifact<RunMeta>(dir, 'meta.json'),
  ]);

  if (!judge || judge.adjudications.length === 0) {
    process.stdout.write(`  run ${match.runId} has no adjudicated disputes to annotate.\n`);
    return 0;
  }
  const workflow: WorkflowId = meta?.workflow ?? 'idea-refinement';
  const items: AdjItem[] = judge.adjudications.map((a) => ({ id: a.id, ruling: a.ruling }));

  let verdicts: Map<string, { verdict: Verdict; note?: string }>;
  if (opts.verdict?.length) {
    try {
      verdicts = parseVerdictFlags(opts.verdict);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  } else if (!process.stdin.isTTY) {
    process.stderr.write('resolve is interactive — in a non-interactive shell pass --verdict <id>=<correct|incorrect|unsure>\n');
    return 1;
  } else {
    verdicts = await interactiveAnnotate(items, judge.adjudications, map);
  }

  let entries;
  try {
    entries = buildFeedbackEntries(match.runId, workflow, items, verdicts);
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
