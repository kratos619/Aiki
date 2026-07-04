// `.aiki/feedback.jsonl` — the human review gate (`aiki resolve`, §127/§444/§618). Append-only.
// This is the PURE core (schema + build + append); the interactive readline shell lives in cli/resolve.ts.
// Keeping the writes pure is what lets §604 ("resolve appends valid JSONL") be tested without a TTY.
//
// A line is workflow-aware; for idea-refinement it records a human verdict on one of the judge's
// adjudicated contradictions, snapshotting the judge's `ruling` so each line is self-describing for the
// bench scorer (T11/T12) without rejoining to the run (grilled 2026-07-04).

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WorkflowIdSchema } from '../schemas/index.js';
import type { WorkflowId } from '../orchestration/context.js';

/** Human verdict on an item (idea-refinement vocab; code-review's fixed/wontfix/false-positive is T10+). */
export const VerdictSchema = z.enum(['correct', 'incorrect', 'unsure']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Judge ruling snapshotted onto the feedback line (mirrors JudgeReport Adjudication.ruling). */
export const RulingSchema = z.enum(['UPHOLD', 'REJECT', 'UNRESOLVED']);
export type Ruling = z.infer<typeof RulingSchema>;

/** One appended feedback line. */
export const FeedbackEntry = z
  .object({
    run_id: z.string().min(1),
    workflow: WorkflowIdSchema,
    item_type: z.literal('adjudication'),
    item_id: z.string().min(1),
    verdict: VerdictSchema,
    ruling: RulingSchema, // the judge ruling the human was reacting to (snapshot)
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

/** An adjudicated item available for annotation (id + the judge's ruling on it). */
export interface AdjItem {
  id: string;
  ruling: Ruling;
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
): FeedbackEntry[] {
  const known = new Set(items.map((i) => i.id));
  for (const id of verdicts.keys()) {
    if (!known.has(id)) throw new FeedbackError(`no adjudicated item "${id}" in this run (have: ${[...known].join(', ') || 'none'})`);
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
        item_type: 'adjudication',
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
};

/** Parse repeatable `--verdict <id>=<correct|incorrect|unsure>` flags (also c/i/u) → a verdict map.
 *  Pure + total: a malformed flag throws FeedbackError (hard-fail, mirrors the config rule). */
export function parseVerdictFlags(flags: string[]): Map<string, { verdict: Verdict }> {
  const m = new Map<string, { verdict: Verdict }>();
  for (const f of flags) {
    const eq = f.indexOf('=');
    if (eq < 1) throw new FeedbackError(`bad --verdict "${f}" — use <id>=<correct|incorrect|unsure>`);
    const id = f.slice(0, eq).trim();
    const verdict = VERDICT_ALIAS[f.slice(eq + 1).trim().toLowerCase()];
    if (!id) throw new FeedbackError(`bad --verdict "${f}" — missing item id`);
    if (!verdict) throw new FeedbackError(`bad verdict for "${id}" — use correct|incorrect|unsure (or c|i|u)`);
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
