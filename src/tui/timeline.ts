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
