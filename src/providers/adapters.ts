import type { Adapter, ProviderId } from './types.js';
import { claude } from './claude.js';
import { agy } from './agy.js';

/** Adapters with a working run(). codex is added in T3 (parsing quarantined in codex.ts). */
export const ADAPTERS: Partial<Record<ProviderId, Adapter>> = {
  claude,
  agy,
};
