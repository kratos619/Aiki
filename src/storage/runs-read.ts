// Read-side helpers for stored runs under `.aiki/runs/` (T9). The write side is RunWriter (runs.ts);
// this is the counterpart used by `aiki show` and `aiki resolve`.
//
// Run ids are timestamp-prefixed (`20260704-1312-idea-refinement-8c44`) so a plain lexical sort is
// chronological — the last element is the most recent run.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Result of resolving a user-supplied run-id arg against the set of stored run ids. */
export type RunMatch =
  | { ok: true; runId: string }
  | { ok: false; kind: 'none' } // no runs exist at all
  | { ok: false; kind: 'no-match'; arg: string }
  | { ok: false; kind: 'ambiguous'; arg: string; candidates: string[] };

/**
 * Pure run-id resolution (unit-tested without fs). Rules (grilled 2026-07-04):
 * - no arg → the most recent run (lexical-max, since ids are timestamp-prefixed);
 * - exact dir-name match wins;
 * - else unique substring/suffix match (so `8c44` finds the full id);
 * - multiple substring matches → ambiguous (return candidates); none → no-match.
 */
export function matchRunId(ids: string[], arg: string | undefined): RunMatch {
  if (ids.length === 0) return { ok: false, kind: 'none' };
  const sorted = [...ids].sort();
  if (!arg) return { ok: true, runId: sorted[sorted.length - 1]! };
  if (ids.includes(arg)) return { ok: true, runId: arg };
  const candidates = sorted.filter((id) => id.includes(arg));
  if (candidates.length === 1) return { ok: true, runId: candidates[0]! };
  if (candidates.length > 1) return { ok: false, kind: 'ambiguous', arg, candidates };
  return { ok: false, kind: 'no-match', arg };
}

/** List stored run ids (directory names under `<root>/runs/`). Empty if the dir doesn't exist. */
export async function listRuns(root = '.aiki'): Promise<string[]> {
  try {
    const entries = await readdir(join(root, 'runs'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Resolve a run-id arg to a concrete run directory + id (listRuns + matchRunId). */
export async function resolveRunId(arg: string | undefined, root = '.aiki'): Promise<RunMatch> {
  return matchRunId(await listRuns(root), arg);
}

export function runDir(runId: string, root = '.aiki'): string {
  return join(root, 'runs', runId);
}

/** Read a run's final report, or null if it was never written (aborted/partial run). */
export async function readFinalReport(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, 'final-report.md'), 'utf8');
  } catch {
    return null;
  }
}

/** Parse a JSON artifact from a run dir, or null if absent/unparseable. */
export async function readJsonArtifact<T = unknown>(dir: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Recursively list every artifact file in a run dir as sorted relative paths (for `show --raw`). */
export async function listArtifacts(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(dir, full));
    }
  }
  await walk(dir);
  return out.sort();
}

/** True if a run directory exists on disk. */
export async function runExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
