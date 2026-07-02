import { DISPLAY_NAME, PROVIDER_IDS, type Detection, type FlagProfile, type ProviderId, type ReadOnlyFlag, type Smoke } from '../providers/types.js';
import { detect } from '../providers/detect.js';
import { probeFlags } from '../providers/probe.js';
import { smokeTest } from '../providers/smoke.js';

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

interface Row {
  det: Detection;
  flags?: FlagProfile;
  smoke?: Smoke;
}

/**
 * `aiki doctor` — detection + flag probe + (optional) smoke test, table output, actionable
 * fixes. Exit 0 iff ≥2 providers are "ready" (§5, §8 quorum). With smoke on, ready = smoke
 * passed; with --no-smoke, ready = detected.
 */
export async function doctor(opts: { smoke?: boolean } = {}): Promise<number> {
  const runSmoke = opts.smoke !== false;

  const rows: Row[] = await Promise.all(
    PROVIDER_IDS.map(async (id): Promise<Row> => {
      const det = await detect(id);
      if (det.status !== 'READY') return { det };
      const flags = await probeFlags(id);
      const smoke = runSmoke ? await smokeTest(id, flags) : undefined;
      return { det, flags, smoke };
    }),
  );

  const lines: string[] = [];
  lines.push('');
  lines.push(`  aiki doctor — provider status${runSmoke ? '' : ' (smoke skipped)'}`);
  lines.push('');
  lines.push(`  ${pad('PROVIDER', 10)}${pad('VERSION', 11)}${pad('STATUS', 15)}${pad('JSON', 6)}${pad('READ-ONLY', 11)}${pad('SMOKE', 14)}ROLE`);
  lines.push(`  ${'─'.repeat(82)}`);

  let ready = 0;
  const fixes: string[] = [];

  for (const row of rows) {
    lines.push(renderRow(row, runSmoke));
    if (isReady(row, runSmoke)) ready++;
    fixes.push(...fixLines(row));
  }

  lines.push('');
  lines.push(`  ${ready}/3 providers ready. Engine minimum quorum: 2.`);
  if (fixes.length) {
    lines.push('');
    lines.push('  Fixes:');
    lines.push(...fixes);
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
  return ready >= 2 ? 0 : 1;
}

function isReady(row: Row, runSmoke: boolean): boolean {
  if (row.det.status !== 'READY') return false;
  return runSmoke ? row.smoke?.ok === true : true;
}

function renderRow(row: Row, runSmoke: boolean): string {
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

function fixLines(row: Row): string[] {
  const { det, smoke } = row;
  const name = DISPLAY_NAME[det.id];
  // Fixes are user-facing (show display name) but reference the real binary for commands.
  if (det.status !== 'READY' && det.hint) return [`  ${name}: ${det.hint}`];
  if (smoke && !smoke.ok) {
    const fix =
      smoke.error === 'AUTH'
        ? `run \`${det.id}\` once to log in`
        : smoke.error === 'QUOTA'
          ? 'provider quota/rate limited — retry later'
          : (smoke.detail ?? 'smoke failed');
    return [`  ${name}: ${fix}`];
  }
  return [];
}
