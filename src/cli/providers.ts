import { resolveProfiles, type ResolvedProfile } from '../providers/profiles.js';

/**
 * `aiki providers` (§5) — machine-readable provider status. `--json` prints the capability
 * profiles actually resolved on this machine; bare prints a compact human summary. Detection +
 * flag probe only, no model calls (§8). Exit 0 always (informational).
 */
export async function providers(opts: { json?: boolean } = {}): Promise<number> {
  const resolved = await resolveProfiles();

  if (opts.json) {
    process.stdout.write(JSON.stringify(resolved, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(renderHuman(resolved) + '\n');
  return 0;
}

const pad = (s: string, w: number) => s.padEnd(w);

function renderHuman(rows: ResolvedProfile[]): string {
  const out: string[] = ['', '  aiki providers — resolved capability profiles (no smoke)', ''];
  out.push(`  ${pad('PROVIDER', 10)}${pad('VERSION', 11)}${pad('INSTALLED', 11)}${pad('JSON', 6)}${pad('READ-ONLY', 11)}CAPABILITY (reason/codeNav/json/ctx)`);
  out.push(`  ${'─'.repeat(88)}`);
  for (const r of rows) {
    const c = r.capability;
    const cap = `${c.reasoning}/${c.codeNav}/${c.jsonReliability}/${c.contextExplore}  ${c.cost}`;
    const json = r.flags ? (r.flags.jsonOutput ? 'yes' : 'no') : '—';
    const ro = r.flags ? r.flags.readOnlyFlag : '—';
    out.push(
      `  ${pad(r.displayName, 10)}${pad(r.version ?? '—', 11)}${pad(r.installed ? 'yes' : 'no', 11)}${pad(json, 6)}${pad(ro, 11)}${cap}`,
    );
  }
  out.push('');
  out.push('  Use --json for the machine-readable form.');
  return out.join('\n');
}
