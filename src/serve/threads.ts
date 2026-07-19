// Conversation threads for `aiki serve` (plan §1.2). A thread is a titled sequence of turns that
// starts from a decision run. Two append-only files, same last-line-wins pattern as sessions.jsonl:
//   <root>/threads.jsonl        — the registry (one ThreadEntry line per update)
//   <root>/threads/<id>.jsonl   — the per-thread turn log
// Old sessions.jsonl runs are projected read-only as single-run "legacy" threads so existing users
// see their history on first launch (HD2). New live threads land in HD3.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readSessions, type SessionEntry } from '../storage/sessions.js';
import { readFinalReport } from '../storage/runs-read.js';
import { runDir } from '../storage/runs-read.js';
import { sanitizeLocalPaths } from '../orchestration/sanitize-paths.js';
import { threadTitle, type ThreadListItemView, type ThreadStatusView, type ThreadDetail } from './projections.js';

export const ThreadStatus = z.enum(['idle', 'running', 'failed', 'cancelled']);

export const ThreadEntry = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    status: ThreadStatus,
    run_ids: z.array(z.string()),
  })
  .strict();
export type ThreadEntry = z.infer<typeof ThreadEntry>;

/** Per-thread turn log (append-only). */
export const ThreadTurn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_message'), text: z.string(), attachments: z.array(z.string()), mode: z.string() }).strict(),
  z.object({ kind: z.literal('run_ref'), run_id: z.string(), mode: z.string() }).strict(),
  z.object({ kind: z.literal('followup'), question: z.string(), provider: z.enum(['claude', 'codex', 'agy']), answer: z.string(), call_ms: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal('gate_receipt'), gate_kind: z.string(), summary: z.string(), decision: z.string() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
]);
export type ThreadTurn = z.infer<typeof ThreadTurn>;

function registryPath(root: string): string {
  return join(root, 'threads.jsonl');
}
function threadLogPath(root: string, id: string): string {
  return join(root, 'threads', `${id}.jsonl`);
}

export async function readThreads(root: string): Promise<ThreadEntry[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath(root), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, ThreadEntry>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = ThreadEntry.parse(JSON.parse(line));
      byId.set(e.id, e);
    } catch {
      /* skip a malformed/legacy line */
    }
  }
  return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function appendThread(root: string, entry: ThreadEntry): Promise<void> {
  await mkdir(root, { recursive: true });
  await appendFile(registryPath(root), `${JSON.stringify(ThreadEntry.parse(entry))}\n`);
}

export async function appendTurn(root: string, id: string, turn: ThreadTurn): Promise<void> {
  await mkdir(join(root, 'threads'), { recursive: true });
  await appendFile(threadLogPath(root, id), `${JSON.stringify(ThreadTurn.parse(turn))}\n`);
}

export async function readTurns(root: string, id: string): Promise<ThreadTurn[]> {
  let raw: string;
  try {
    raw = await readFile(threadLogPath(root, id), 'utf8');
  } catch {
    return [];
  }
  const turns: ThreadTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      turns.push(ThreadTurn.parse(JSON.parse(line)));
    } catch {
      /* skip a malformed line */
    }
  }
  return turns;
}

const SESSION_TO_THREAD_STATUS: Record<SessionEntry['status'], ThreadStatusView> = {
  running: 'running',
  ok: 'complete',
  failed: 'failed',
  aborted: 'cancelled',
};

/** Project the legacy sessions.jsonl into read-only single-run thread rows. Titles come from the
 *  run's own input (idea text) when available; code-review runs (a diff) get a synthesized label. */
export async function legacyThreads(): Promise<ThreadListItemView[]> {
  const sessions = await readSessions();
  return Promise.all(sessions.map(sessionToThreadItem));
}

async function sessionToThreadItem(s: SessionEntry): Promise<ThreadListItemView> {
  return {
    id: s.id,
    title: await legacyTitle(s),
    updatedAt: s.startedAt,
    status: SESSION_TO_THREAD_STATUS[s.status],
    mode: null,
    legacy: true,
  };
}

async function legacyTitle(s: SessionEntry): Promise<string> {
  if (s.workflow === 'code-review') return `Code review · ${s.startedAt.slice(0, 10)}`;
  try {
    const dir = runDir(s.id, s.runsRoot);
    const original = await readFile(join(dir, '00-original.md'), 'utf8');
    const firstLine = original.split('\n').find((l) => l.trim()) ?? '';
    return threadTitle(firstLine) || `${s.workflow} · ${s.startedAt.slice(0, 10)}`;
  } catch {
    return `${s.workflow} · ${s.startedAt.slice(0, 10)}`;
  }
}

/** Read-only detail for a legacy thread: the run's final report, path-sanitized. Returns null when
 *  the run id isn't a known legacy session. Live threads (HD3) render from their turn log instead. */
export async function legacyThreadDetail(id: string): Promise<ThreadDetail | null> {
  const sessions = await readSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return null;
  const dir = runDir(s.id, s.runsRoot);
  const report = await readFinalReport(dir);
  const title = await legacyTitle(s);
  return {
    id: s.id,
    title,
    legacy: true,
    resumeRunId: null,
    turns: report
      ? [{ kind: 'report_md', markdown: sanitizeLocalPaths(report) }]
      : [{ kind: 'note', text: 'This run left no final report (it did not complete).' }],
  };
}
