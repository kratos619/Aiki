// `.aiki/feedback.jsonl` — the human review gate (`aiki resolve`, §127/§444/§618). Append-only.
// This is the PURE core (schema + build + append); the interactive readline shell lives in cli/resolve.ts.
// Keeping the writes pure is what lets §604/§606 ("resolve appends valid JSONL") be tested without a TTY.
//
// Workflow-aware (T11): idea-refinement annotates the judge's adjudicated contradictions with
// correct/incorrect/unsure; code-review annotates the report's kept findings with fixed/wontfix/
// false-positive (the false-positive labels feed the bench PRECISION metric, BENCHMARK.md §2). Each line
// snapshots the item's `ruling` (a free string: idea = UPHOLD/REJECT/UNRESOLVED; code-review = severity/
// category/confidence) so it's self-describing for the bench scorer without rejoining to the run.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WorkflowIdSchema } from '../schemas/index.js';
import type { WorkflowId } from '../orchestration/context.js';

/** All human verdicts across workflows. `parseVerdictFlags`/`resolve` restrict to the per-workflow vocab. */
export const VerdictSchema = z.enum(['correct', 'incorrect', 'unsure', 'fixed', 'wontfix', 'false-positive']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VERDICT_VOCAB: Record<WorkflowId, Verdict[]> = {
  'idea-refinement': ['correct', 'incorrect', 'unsure'],
  'code-review': ['fixed', 'wontfix', 'false-positive'],
};

/** One appended feedback line. `item_type` distinguishes an idea adjudication from a code-review finding. */
export const FeedbackEntry = z
  .object({
    run_id: z.string().min(1),
    workflow: WorkflowIdSchema,
    item_type: z.enum(['adjudication', 'finding']),
    item_id: z.string().min(1),
    verdict: VerdictSchema,
    ruling: z.string().min(1), // snapshot of what the human reacted to (workflow-specific)
    at: z.string().min(1), // ISO-8601
    note: z.string().optional(),
  })
  .strict();

export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackError';
  }
}

/** An annotatable item (id + a ruling/status snapshot string). */
export interface AdjItem {
  id: string;
  ruling: string;
}

/**
 * Build validated feedback entries from a verdict map, in `items` order. A verdict referencing an
 * unknown item id is a hard error (typo guard — mirrors the config hard-fail rule).
 */
export function buildFeedbackEntries(
  runId: string,
  workflow: WorkflowId,
  items: AdjItem[],
  verdicts: Map<string, { verdict: Verdict; note?: string }>,
  at: Date = new Date(),
  itemType: FeedbackEntry['item_type'] = 'adjudication',
): FeedbackEntry[] {
  const known = new Set(items.map((i) => i.id));
  for (const id of verdicts.keys()) {
    if (!known.has(id)) throw new FeedbackError(`no ${itemType} "${id}" in this run (have: ${[...known].join(', ') || 'none'})`);
  }
  const iso = at.toISOString();
  const entries: FeedbackEntry[] = [];
  for (const item of items) {
    const v = verdicts.get(item.id);
    if (!v) continue;
    entries.push(
      FeedbackEntry.parse({
        run_id: runId,
        workflow,
        item_type: itemType,
        item_id: item.id,
        verdict: v.verdict,
        ruling: item.ruling,
        at: iso,
        ...(v.note ? { note: v.note } : {}),
      }),
    );
  }
  return entries;
}

const VERDICT_ALIAS: Record<string, Verdict> = {
  c: 'correct',
  correct: 'correct',
  i: 'incorrect',
  incorrect: 'incorrect',
  u: 'unsure',
  unsure: 'unsure',
  f: 'fixed',
  fixed: 'fixed',
  w: 'wontfix',
  wontfix: 'wontfix',
  fp: 'false-positive',
  'false-positive': 'false-positive',
};

/**
 * Parse repeatable `--verdict <id>=<verdict>` flags → a verdict map. `allowed` restricts to a workflow's
 * vocab (default: all). Malformed flag or out-of-vocab verdict throws FeedbackError (hard-fail).
 */
export function parseVerdictFlags(flags: string[], allowed: readonly Verdict[] = VerdictSchema.options): Map<string, { verdict: Verdict }> {
  const ok = new Set(allowed);
  const m = new Map<string, { verdict: Verdict }>();
  for (const f of flags) {
    const eq = f.indexOf('=');
    if (eq < 1) throw new FeedbackError(`bad --verdict "${f}" — use <id>=<${allowed.join('|')}>`);
    const id = f.slice(0, eq).trim();
    const verdict = VERDICT_ALIAS[f.slice(eq + 1).trim().toLowerCase()];
    if (!id) throw new FeedbackError(`bad --verdict "${f}" — missing item id`);
    if (!verdict || !ok.has(verdict)) throw new FeedbackError(`bad verdict for "${id}" — use ${allowed.join('|')}`);
    m.set(id, { verdict });
  }
  return m;
}

/** Append entries to `<root>/feedback.jsonl` (one JSON object per line). No-op on empty input. */
export async function appendFeedback(entries: FeedbackEntry[], root = '.aiki'): Promise<string> {
  const path = join(root, 'feedback.jsonl');
  if (entries.length === 0) return path;
  await mkdir(root, { recursive: true });
  await appendFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}
