import type { FlagProfile, ProviderId } from './types.js';
import { captureFull } from './spawn.js';

const PROBE_TIMEOUT_MS = 5000;

// Which binary + args to ask for --help, per provider (codex flags live under `exec`).
const HELP_INVOCATION: Record<ProviderId, { bin: string; args: string[] }> = {
  claude: { bin: 'claude', args: ['--help'] },
  codex: { bin: 'codex', args: ['exec', '--help'] },
  gemini: { bin: 'gemini', args: ['--help'] },
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
    case 'gemini':
      return {
        id,
        jsonOutput: has(/--output-format/),
        readOnlyFlag: has(/--approval-mode/) ? 'approval-plan' : 'none',
      };
  }
}

/** Flag probe: `<bin> --help`, regex-match §7.3 flags, no model calls (§8). */
export async function probeFlags(id: ProviderId, capture: CaptureFn = captureFull): Promise<FlagProfile> {
  const { bin, args } = HELP_INVOCATION[id];
  const help = await capture(id, bin, args, PROBE_TIMEOUT_MS);
  return parseFlagProfile(id, help);
}
