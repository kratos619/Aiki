// Global session registry (V6.3) — `~/.aiki/sessions.jsonl`, append-only, one JSON object per line.
// Records every run REGARDLESS of where it was launched, so `aiki sessions` can list them and
// `aiki resume` can locate a run that lives under a different project's `.aiki`. Status updates append
// a fresh full line; readers keep the last line per id (last-write-wins).

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { homeAikiRoot } from './paths.js';

export const SessionStatus = z.enum(['running', 'ok', 'failed', 'aborted']);
export const SessionEntry = z
  .object({
    id: z.string().min(1),
    workflow: z.string(),
    cwd: z.string(), // launch dir (code-review needs it as the reviewer repo root on resume)
    runsRoot: z.string(), // absolute .aiki root the run lives under (repo vs ~/.aiki)
    startedAt: z.string(), // ISO
    status: SessionStatus,
    resumedFrom: z.string().optional(),
  })
  .strict();
export type SessionEntry = z.infer<typeof SessionEntry>;

function registryPath(): string {
  return join(homeAikiRoot(), 'sessions.jsonl');
}

export async function recordSession(entry: SessionEntry): Promise<void> {
  await mkdir(homeAikiRoot(), { recursive: true });
  await appendFile(registryPath(), `${JSON.stringify(SessionEntry.parse(entry))}\n`);
}

/** All sessions, newest first, deduped by id (the last line for an id wins — that's its latest status). */
export async function readSessions(): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath(), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, SessionEntry>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = SessionEntry.parse(JSON.parse(line));
      byId.set(e.id, e); // last line for this id wins
    } catch {
      /* skip a malformed/legacy line */
    }
  }
  // Newest first by startedAt.
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Re-append the entry with a new status (keeps the append-only file honest). No-op if id unknown. */
export async function updateSessionStatus(id: string, status: SessionEntry['status']): Promise<void> {
  const cur = (await readSessions()).find((s) => s.id === id);
  if (!cur) return;
  await recordSession({ ...cur, status });
}

/** Locate a session by exact id or a unique suffix/substring (mirrors resolveRunId's matching). */
export async function findSession(idArg: string): Promise<SessionEntry | { ambiguous: string[] } | null> {
  const all = await readSessions();
  const exact = all.find((s) => s.id === idArg);
  if (exact) return exact;
  const hits = all.filter((s) => s.id.includes(idArg));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return { ambiguous: hits.map((s) => s.id) };
  return null;
}
