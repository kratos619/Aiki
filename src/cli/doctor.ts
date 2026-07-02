import { PROVIDER_IDS, type Detection, type FlagProfile, type ProviderId, type ReadOnlyFlag } from '../providers/types.js';
import { detect } from '../providers/detect.js';
import { probeFlags } from '../providers/probe.js';

// Default role labels for the status panel (§4.1 / §10). Assignment logic is T5+.
const ROLE_LABEL: Record<ProviderId, string> = {
  claude: 'judge',
  codex: 'critic/verifier',
  gemini: 'analyst/prompt-builder',
};

const READONLY_LABEL: Record<ReadOnlyFlag, string> = {
  plan: 'plan',
  sandbox: 'read-only',
  'approval-plan': 'approval:plan',
  none: '⚠ none',
};

const pad = (s: string, w: number) => s.padEnd(w);

/**
 * `aiki doctor` — detection + flag probe, table output, actionable fixes.
 * T1: no smoke test yet (wired in T2). Exit 0 iff ≥2 providers ready (§5, §8 quorum).
 */
export async function doctor(): Promise<number> {
  const rows = await Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const det = await detect(id);
      const flags = det.status === 'READY' ? await probeFlags(id) : undefined;
      return { det, flags };
    }),
  );

  const lines: string[] = [];
  lines.push('');
  lines.push('  aiki doctor — provider status (detection + flag probe; smoke test: T2)');
  lines.push('');
  lines.push(`  ${pad('PROVIDER', 10)}${pad('VERSION', 12)}${pad('STATUS', 16)}${pad('JSON', 6)}${pad('READ-ONLY', 15)}ROLE`);
  lines.push(`  ${'─'.repeat(72)}`);

  let ready = 0;
  const fixes: string[] = [];

  for (const { det, flags } of rows) {
    if (det.status === 'READY') ready++;
    lines.push(renderRow(det, flags));
    if (det.status !== 'READY' && det.hint) fixes.push(`  ${det.id}: ${det.hint}`);
  }

  lines.push('');
  lines.push(`  ${ready}/3 providers detected. Engine minimum quorum: 2.`);
  if (fixes.length) {
    lines.push('');
    lines.push('  Fixes:');
    lines.push(...fixes);
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
  return ready >= 2 ? 0 : 1;
}

function renderRow(det: Detection, flags: FlagProfile | undefined): string {
  const status = det.status === 'READY' ? '✔ ready' : '✖ NOT_INSTALLED';
  const version = det.version ?? '—';
  const json = flags ? (flags.jsonOutput ? 'yes' : 'no') : '—';
  const ro = flags ? READONLY_LABEL[flags.readOnlyFlag] : '—';
  return `  ${pad(det.id, 10)}${pad(version, 12)}${pad(status, 16)}${pad(json, 6)}${pad(ro, 15)}${ROLE_LABEL[det.id]}`;
}
