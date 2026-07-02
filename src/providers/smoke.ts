import { randomBytes } from 'node:crypto';
import type { FlagProfile, ProviderId, Smoke, SpawnCaptureFn } from './types.js';
import { ADAPTERS } from './adapters.js';

const SMOKE_TIMEOUT_MS = 60_000;

function nonce(): string {
  return randomBytes(4).toString('hex'); // 8 hex chars
}

/**
 * One cheap model call per provider (§8): ask it to echo a random nonce as JSON.
 * Pass = process exits ok within timeout AND extracted JSON echoes the nonce.
 */
export async function smokeTest(
  id: ProviderId,
  flags: FlagProfile,
  deps: { spawn?: SpawnCaptureFn } = {},
): Promise<Smoke> {
  const adapter = ADAPTERS[id];
  const n = nonce();
  const prompt = `Reply with ONLY this JSON and nothing else: {"ok": true, "echo": "${n}"}`;
  const res = await adapter.run(
    { prompt, cwd: process.cwd(), timeoutMs: SMOKE_TIMEOUT_MS, expectJson: true, readOnly: true },
    flags,
    deps,
  );
  if (!res.ok) {
    return { ok: false, error: res.error, nonce: n, durationMs: res.durationMs, detail: res.stderrTail.slice(-160) };
  }
  const echoed = (res.json as { echo?: unknown } | null)?.echo;
  return {
    ok: echoed === n,
    nonce: n,
    echoed: typeof echoed === 'string' ? echoed : undefined,
    durationMs: res.durationMs,
  };
}
