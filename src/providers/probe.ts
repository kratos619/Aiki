import type { FlagProfile, ProviderId } from './types.js';
import { captureFull } from './spawn.js';

const PROBE_TIMEOUT_MS = 5000;

// Which binary + args to ask for --help, per provider (codex flags live under `exec`).
const HELP_INVOCATION: Record<ProviderId, { bin: string; args: string[] }> = {
  claude: { bin: 'claude', args: ['--help'] },
  codex: { bin: 'codex', args: ['exec', '--help'] },
  agy: { bin: 'agy', args: ['--help'] },
};

export type CaptureFn = (id: ProviderId, bin: string, args: string[], timeoutMs: number) => Promise<string>;

/**
 * Parse a --help dump into a FlagProfile. Pure — the seam T2 tests directly.
 * Flag names verified against installed CLIs at build time (see docs/PROVIDER_NOTES.md).
 */
export function parseFlagProfile(id: ProviderId, help: string): FlagProfile {
  const has = (re: RegExp) => re.test(help);
  switch (id) {
    case 'claude':
      return {
        id,
        jsonOutput: has(/--output-format/),
        readOnlyFlag: has(/--permission-mode/) ? 'plan' : 'none',
      };
    case 'codex':
      return {
        id,
        jsonOutput: has(/--json\b/),
        readOnlyFlag: has(/--sandbox/) ? 'sandbox' : 'none',
      };
    case 'agy':
      // agy has no JSON-output flag; `-p` returns raw text (the JSON we ask for) → §14 extraction.
      // Read-only is best-effort via `--sandbox` (terminal restrictions); see docs/PROVIDER_NOTES.md.
      return {
        id,
        jsonOutput: false,
        readOnlyFlag: has(/--sandbox/) ? 'sandbox' : 'none',
      };
  }
}

/** Flag probe: `<bin> --help`, regex-match §7.3 flags, no model calls (§8). */
export async function probeFlags(id: ProviderId, capture: CaptureFn = captureFull): Promise<FlagProfile> {
  const { bin, args } = HELP_INVOCATION[id];
  const help = await capture(id, bin, args, PROBE_TIMEOUT_MS);
  return parseFlagProfile(id, help);
}
