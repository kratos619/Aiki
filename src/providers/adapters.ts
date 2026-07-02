import type { Adapter, ProviderId } from './types.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { agy } from './agy.js';

/** All provider adapters with a working run(). */
export const ADAPTERS: Record<ProviderId, Adapter> = {
  claude,
  codex,
  agy,
};
