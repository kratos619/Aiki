import { DISPLAY_NAME, PROVIDER_IDS, type Detection, type FlagProfile, type ProviderId, type ReadOnlyFlag, type Smoke } from '../providers/types.js';
import { detect } from '../providers/detect.js';
import { probeFlags } from '../providers/probe.js';
import { smokeTest } from '../providers/smoke.js';
import { entryToSmoke, isFresh, readSmokeCache, toEntry, writeSmokeCache, type SmokeCache } from '../config/smoke-cache.js';

// Default role labels for the status panel (§4.1 / §10). Assignment logic is T5+.
// NOTE: agy = Gemini 3.1 Pro (strong + metered), not the old cheap/free gemini — §10 role
// rationale should be revisited at T5.
const ROLE_LABEL: Record<ProviderId, string> = {
  claude: 'judge',
  codex: 'critic/verifier',
  agy: 'analyst/prompt-builder',
};

const READONLY_LABEL: Record<ReadOnlyFlag, string> = {
  plan: 'plan',
  sandbox: 'sandbox',
  none: '⚠ none',
};

const pad = (s: string, w: number) => s.padEnd(w);

export interface ProviderRow {
  det: Detection;
  flags?: FlagProfile;
  smoke?: Smoke;
  cached?: boolean; // smoke result came from the §242 cache, not a fresh call
}

export interface DoctorReport {
  rows: ProviderRow[];
  ready: number;
  fixes: string[];
}

/**
 * The shared check engine behind `aiki doctor` and the TUI startup preflight: detection + flag
 * probe + (optional) smoke test per provider. `onRow` fires as each provider finishes, so a UI
 * can show live progress. Smoke results are cached 6h in `.aiki/smoke-cache.json` (§242);
 * `fresh` bypasses the cache. A cache entry is reused only when its provider version still
 * matches (an upgrade re-smokes).
 */
export async function runDoctorChecks(
  opts: { smoke?: boolean; fresh?: boolean; onRow?: (row: ProviderRow) => void } = {},
): Promise<DoctorReport> {
  const runSmoke = opts.smoke !== false;
  const cache = runSmoke ? await readSmokeCache() : {};
  const now = Date.now();
  const updates: SmokeCache = {};

  const check = async (id: ProviderId): Promise<ProviderRow> => {
    const det = await detect(id);
    if (det.status !== 'READY') return { det };
    const flags = await probeFlags(id);
    if (!runSmoke) return { det, flags };
    const cached = opts.fresh ? undefined : cache[id];
    if (cached && isFresh(cached, det.version ?? null, now)) {
      return { det, flags, smoke: entryToSmoke(cached), cached: true };
    }
    const smoke = await smokeTest(id, flags);
    updates[id] = toEntry(smoke, det.version ?? null, new Date(now));
    return { det, flags, smoke };
  };

  const rows: ProviderRow[] = await Promise.all(
    PROVIDER_IDS.map(async (id): Promise<ProviderRow> => {
      const row = await check(id);
      opts.onRow?.(row);
      return row;
    }),
  );

  if (Object.keys(updates).length) await writeSmokeCache({ ...cache, ...updates });

  return {
    rows,
    ready: rows.filter((row) => isReady(row, runSmoke)).length,
    fixes: rows.flatMap(fixLines),
  };
}

/**
 * `aiki doctor` — runs the checks, prints the table + actionable fixes. Exit 0 iff ≥2 providers
 * are "ready" (§5, §8 quorum). With smoke on, ready = smoke passed; with --no-smoke, ready = detected.
 */
export async function doctor(opts: { smoke?: boolean; fresh?: boolean } = {}): Promise<number> {
  const runSmoke = opts.smoke !== false;
  const { rows, ready, fixes } = await runDoctorChecks(opts);

  const lines: string[] = [];
  lines.push('');
  lines.push(`  aiki doctor — provider status${runSmoke ? '' : ' (smoke skipped)'}`);
  lines.push('');
  lines.push(`  ${pad('PROVIDER', 10)}${pad('VERSION', 11)}${pad('STATUS', 15)}${pad('JSON', 6)}${pad('READ-ONLY', 11)}${pad('SMOKE', 14)}ROLE`);
  lines.push(`  ${'─'.repeat(82)}`);

  for (const row of rows) lines.push(renderRow(row, runSmoke));

  lines.push('');
  lines.push(`  ${ready}/3 providers ready. Engine minimum quorum: 2.`);
  if (rows.some((r) => r.cached)) lines.push('  (smoke: cached ≤6h — `aiki doctor --fresh` re-runs)');
  if (fixes.length) {
    lines.push('');
    lines.push('  Fixes:');
    lines.push(...fixes);
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
  return ready >= 2 ? 0 : 1;
}

function isReady(row: ProviderRow, runSmoke: boolean): boolean {
  if (row.det.status !== 'READY') return false;
  return runSmoke ? row.smoke?.ok === true : true;
}

function renderRow(row: ProviderRow, runSmoke: boolean): string {
  const { det, flags, smoke } = row;
  const status = det.status === 'READY' ? '✔ ready' : '✖ NOT_INSTALLED';
  const version = det.version ?? '—';
  const json = flags ? (flags.jsonOutput ? 'yes' : 'no') : '—';
  const ro = flags ? READONLY_LABEL[flags.readOnlyFlag] : '—';
  const smokeCell = renderSmoke(det.status === 'READY', runSmoke, smoke);
  return `  ${pad(DISPLAY_NAME[det.id], 10)}${pad(version, 11)}${pad(status, 15)}${pad(json, 6)}${pad(ro, 11)}${pad(smokeCell, 14)}${ROLE_LABEL[det.id]}`;
}

function renderSmoke(detected: boolean, runSmoke: boolean, smoke?: Smoke): string {
  if (!detected || !runSmoke) return '—';
  if (!smoke) return '—';
  if (smoke.ok) return `✔ ${(smoke.durationMs / 1000).toFixed(1)}s`;
  return `✖ ${smoke.error ?? 'FAIL'}`;
}

/** The actionable fix for a failing row, or undefined when the row is healthy.
 *  Fixes are user-facing (show display name) but reference the real binary for commands. */
function fixFor(row: ProviderRow): string | undefined {
  const { det, smoke } = row;
  if (det.status !== 'READY') return det.hint;
  if (smoke && !smoke.ok) {
    return smoke.error === 'AUTH'
      ? `run \`${det.id}\` once to log in`
      : smoke.error === 'QUOTA'
        ? 'retry later — quota/rate limit resets on its own'
        : (smoke.detail ?? 'smoke failed');
  }
  return undefined;
}

function fixLines(row: ProviderRow): string[] {
  const fix = fixFor(row);
  return fix ? [`  ${DISPLAY_NAME[row.det.id]}: ${fix}`] : [];
}

/** One TUI preflight row: status icon + human label + the fix to show when it failed. */
export function preflightLine(row: ProviderRow): { ok: boolean; label: string; fix?: string } {
  const name = DISPLAY_NAME[row.det.id];
  if (row.det.status !== 'READY') return { ok: false, label: `${name} — not installed`, fix: fixFor(row) };
  const version = row.det.version ? ` ${row.det.version}` : '';
  const { smoke } = row;
  if (!smoke) return { ok: true, label: `${name}${version} — CLI detected` };
  if (smoke.ok) {
    const timing = row.cached ? 'cached ≤6h' : `${(smoke.durationMs / 1000).toFixed(1)}s`;
    return { ok: true, label: `${name}${version} — ready (smoke ${timing})` };
  }
  const reason =
    smoke.error === 'AUTH' ? 'auth failed'
      : smoke.error === 'QUOTA' ? 'quota/rate limited'
        : `smoke failed (${smoke.error ?? 'unknown'})`;
  return { ok: false, label: `${name}${version} — ${reason}`, fix: fixFor(row) };
}
