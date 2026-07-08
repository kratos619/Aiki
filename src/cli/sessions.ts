// `aiki sessions` (V6.3) — list runs from the global registry (~/.aiki/sessions.jsonl), newest first,
// across every location aiki was launched from. Failed/aborted ones are resumable via `aiki resume <id>`.

import { readSessions, type SessionEntry } from '../storage/sessions.js';

const MARK: Record<SessionEntry['status'], string> = { running: '●', ok: '✔', failed: '✖', aborted: '⊘' };

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function sessionsCommand(opts: { json?: boolean } = {}): Promise<number> {
  const all = await readSessions();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return 0;
  }
  if (all.length === 0) {
    process.stdout.write('no sessions yet — run `aiki` or `aiki run <workflow> …` first.\n');
    return 0;
  }
  const lines = all.slice(0, 30).map((s) => {
    const resumable = s.status === 'failed' || s.status === 'aborted';
    return `  ${MARK[s.status]} ${s.id}  ${s.workflow.padEnd(16)} ${ago(s.startedAt).padStart(9)}${resumable ? '   ← aiki resume ' + s.id : ''}`;
  });
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
