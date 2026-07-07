// Pure timeline model for the run screen (T8, §4.2). No Ink here — the reducer that turns the
// engine's stage events into row states, plus provider resolution and glyphs. Unit-tested directly.

import type { ProviderId } from '../providers/types.js';
import { DISPLAY_NAME } from '../providers/types.js';
import type { RoleMap, StageInfo } from '../orchestration/context.js';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StageRow {
  id: string;
  label: string;
  providers: ProviderId[]; // [] for deterministic (code-only) stages
  status: StageStatus;
  startedAt?: number;
  endedAt?: number;
}

/** §4.2 state glyphs. */
export const GLYPH: Record<StageStatus, string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✖',
  skipped: '⊘',
};

/** Which provider chip(s) a row shows, from its role hint + the resolved roles. */
export function stageProviders(role: StageInfo['role'], roles: RoleMap, available: ProviderId[]): ProviderId[] {
  switch (role) {
    case 'analyst':
      return [roles.analyst];
    case 'judge':
      return [roles.judge];
    case 'verifier':
      return [roles.verifier];
    case 's4':
      return roles.s4;
    case 'all':
      return available;
    case null:
      return [];
  }
}

/** All rows pending, providers resolved — the skeleton drawn before the run starts. */
export function initTimeline(stages: StageInfo[], roles: RoleMap, available: ProviderId[]): StageRow[] {
  return stages.map((s) => ({
    id: s.id,
    label: s.label,
    providers: stageProviders(s.role, roles, available),
    status: 'pending' as StageStatus,
  }));
}

export function markStart(rows: StageRow[], id: string, now: number): StageRow[] {
  return rows.map((r) => (r.id === id ? { ...r, status: 'running', startedAt: now } : r));
}

export function markEnd(rows: StageRow[], id: string, status: 'done' | 'failed' | 'skipped', now: number): StageRow[] {
  return rows.map((r) => (r.id === id ? { ...r, status, endedAt: now } : r));
}

/** Elapsed label for a row: final duration once ended, live seconds while running, else empty. */
export function elapsedLabel(row: StageRow, now: number): string {
  if (row.status === 'done' || row.status === 'failed') {
    if (row.startedAt === undefined || row.endedAt === undefined) return '';
    return `${((row.endedAt - row.startedAt) / 1000).toFixed(1)}s`;
  }
  if (row.status === 'running' && row.startedAt !== undefined) return `${Math.floor((now - row.startedAt) / 1000)}s`;
  return '';
}

export const displayNames = (ps: ProviderId[]): string => ps.map((p) => DISPLAY_NAME[p]).join(', ');

// ── V10 run-screen life: rotating status phrases + progress bar + total time. Pure; unit-tested. ────

/** Stage-flavored status phrases, rotated every 4s so long stages feel alive (not stuck). */
const PHRASES: Record<string, string[]> = {
  S1: ['pinning down what you actually asked', 'writing the task contract'],
  S2: ['checking every model read it the same way', 'guarding against a misread'],
  S3: ["writing each seat's brief", 'tailoring the role prompts'],
  S4: ['council working in separate rooms', 'independent takes incoming'],
  S5: ['checking nobody drifted off-task', 'comparing echoes against the contract'],
  S6: ['boiling the output down to claims', 'extracting the claims'],
  S7: ['mapping where they disagree', 'drawing the disagreement map'],
  S8: ['cross-examining the claims', 'stress-testing the evidence'],
  S9: ['the judge is deliberating', 'weighing evidence over confidence'],
  S10: ['writing the report', 'assembling the decision brief'],
};

/** The phrase for a running stage at `seconds` elapsed (cycles its list every 4s). */
export function runningPhrase(stageId: string, seconds: number): string {
  const list = PHRASES[stageId];
  if (!list || list.length === 0) return 'working';
  return list[Math.floor(seconds / 4) % list.length]!;
}

/** Overall progress: finished-stage count (done/failed/skipped) as a ▰▱ bar + counts. */
export function progressBar(rows: StageRow[]): { bar: string; done: number; total: number } {
  const done = rows.filter((r) => r.status === 'done' || r.status === 'failed' || r.status === 'skipped').length;
  return { bar: '▰'.repeat(done) + '▱'.repeat(rows.length - done), done, total: rows.length };
}

/** Whole-run elapsed (first start → last end), e.g. "84s"; '' before anything ran. */
export function totalElapsed(rows: StageRow[]): string {
  const starts = rows.map((r) => r.startedAt).filter((n): n is number => n !== undefined);
  const ends = rows.map((r) => r.endedAt).filter((n): n is number => n !== undefined);
  if (starts.length === 0 || ends.length === 0) return '';
  return `${((Math.max(...ends) - Math.min(...starts)) / 1000).toFixed(0)}s`;
}
