// `.aiki/smoke-cache.json` — the §242 6h smoke-test cache. Tool-owned (doctor writes it), kept SEPARATE
// from the human-edited .aiki/config.json so doctor never clobbers hand-edits (grilled 2026-07-04).
//
// Unlike config.json, a corrupt/missing cache is NOT a hard error — it's disposable, so we silently
// treat it as empty and re-run the smoke. An entry is stale when it's older than 6h OR the provider's
// detected version has changed since it was cached (an upgrade should re-prove the provider).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderIdSchema } from '../schemas/index.js';
import type { Smoke } from '../providers/types.js';

export const SMOKE_TTL_MS = 6 * 60 * 60 * 1000; // §242

const SmokeCacheEntrySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
  version: z.string().nullable(), // detected --version when cached; version change ⇒ stale
  at: z.string(), // ISO-8601 of when the smoke ran
});
const SmokeCacheSchema = z.record(ProviderIdSchema, SmokeCacheEntrySchema);

export type SmokeCacheEntry = z.infer<typeof SmokeCacheEntrySchema>;
export type SmokeCache = z.infer<typeof SmokeCacheSchema>;

/** Pure: is a cached entry still usable? Fresh = same detected version AND within the TTL. */
export function isFresh(entry: SmokeCacheEntry, detectedVersion: string | null, nowMs: number, ttlMs = SMOKE_TTL_MS): boolean {
  if (entry.version !== detectedVersion) return false;
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return false;
  return nowMs - at < ttlMs;
}

/** Pure: build a cache entry from a fresh smoke result. */
export function toEntry(smoke: Smoke, version: string | null, at: Date = new Date()): SmokeCacheEntry {
  return {
    ok: smoke.ok,
    ...(smoke.error ? { error: smoke.error } : {}),
    durationMs: smoke.durationMs,
    version,
    at: at.toISOString(),
  };
}

/** Reconstruct a Smoke (for rendering) from a cached entry. */
export function entryToSmoke(entry: SmokeCacheEntry): Smoke {
  return {
    ok: entry.ok,
    ...(entry.error ? { error: entry.error as Smoke['error'] } : {}),
    nonce: 'cached',
    durationMs: entry.durationMs,
  };
}

/** Read the cache; missing or corrupt → `{}` (disposable, never throws). */
export async function readSmokeCache(root = '.aiki'): Promise<SmokeCache> {
  try {
    const parsed = SmokeCacheSchema.safeParse(JSON.parse(await readFile(join(root, 'smoke-cache.json'), 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Atomically write the cache (temp + rename). */
export async function writeSmokeCache(cache: SmokeCache, root = '.aiki'): Promise<void> {
  await mkdir(root, { recursive: true });
  const full = join(root, 'smoke-cache.json');
  const tmp = `${full}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(tmp, full);
}
