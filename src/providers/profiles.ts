// Static capability profiles (§7.4), merged with live detection + flag probe into the
// machine-readable profile that `aiki providers --json` prints (§5).
//
// Ordinals (1–3) are hand-maintained and exist ONLY to drive default role assignment (§10).
// They are NOT a benchmark output — do not build dynamic scoring in v1 (§7.4).
//
// CAVEAT (revisit at T5, per .agent/STATE.md): the plan's §7.4 table describes the OLD `gemini`
// CLI. Our third provider is `agy` (Antigravity / Gemini 3.1 Pro) — strong AND quota-metered,
// not the old free-tier gemini. We kept §7.4's ordinals here to avoid silently changing default
// role assignment before T5, but corrected `cost` to `quota-metered` (using `free-tier-generous`
// would contradict a decided fact). The ordinals + their role impact are re-decided at T5.

import { createRequire } from 'node:module';
import type { FlagProfile, ProviderId } from './types.js';
import { DISPLAY_NAME, PROVIDER_IDS } from './types.js';
import { detect } from './detect.js';
import { probeFlags } from './probe.js';

// Read the JSON via require: keeps `rootDir` = src clean (no dist copy step needed for an import
// assertion) and works under NodeNext without pulling the file into the TS program.
const require = createRequire(import.meta.url);

export interface CapabilityProfile {
  reasoning: number;
  codeNav: number;
  jsonReliability: number;
  cost: string;
  contextExplore: number;
}

const STATIC_PROFILES = require('./profiles.json') as Record<ProviderId, CapabilityProfile>;

/** The profile actually resolved on this machine for one provider (static ⊕ detection ⊕ probe). */
export interface ResolvedProfile {
  id: ProviderId;
  displayName: string;
  installed: boolean;
  version: string | null;
  flags: { jsonOutput: boolean; readOnlyFlag: FlagProfile['readOnlyFlag'] } | null; // null when not installed
  capability: CapabilityProfile;
}

/**
 * Resolve every provider's machine profile: detection (PATH + --version) and flag probe (--help),
 * merged with the static capability ordinals. No model calls (§8) — this is fast and safe.
 */
export async function resolveProfiles(): Promise<ResolvedProfile[]> {
  return Promise.all(
    PROVIDER_IDS.map(async (id): Promise<ResolvedProfile> => {
      const det = await detect(id);
      const installed = det.status === 'READY';
      const flags = installed ? await probeFlags(id) : null;
      return {
        id,
        displayName: DISPLAY_NAME[id],
        installed,
        version: det.version ?? null,
        flags: flags ? { jsonOutput: flags.jsonOutput, readOnlyFlag: flags.readOnlyFlag } : null,
        capability: STATIC_PROFILES[id],
      };
    }),
  );
}
