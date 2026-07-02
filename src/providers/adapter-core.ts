import type { AdapterSpec, FlagProfile, ProviderError, RawResult, RunRequest, RunResultAdapter, SpawnCaptureFn } from './types.js';
import { spawnCapture } from './spawn.js';

const CREDENTIAL_RE = /KEY|TOKEN|SECRET/i;

/** Inherit the user's env minus anything credential-looking (§7.2, §19 defense in depth). */
export function filterEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!CREDENTIAL_RE.test(k)) out[k] = v;
  }
  return out;
}

const AUTH_RE = /\b(login|log in|unauthorized|expired|authenticat|not authenticated|ineligible|unsupported client|no longer supported|sign in|please run)\b/i;
const QUOTA_RE = /\b(rate limit|quota|429|resource[_ ]exhausted|too many requests|usage limit|out of)\b/i;

/**
 * Map a raw process result to a ProviderError, or 'OK' (§7.2 taxonomy). Order is deliberate.
 * Exit 0 short-circuits to OK — we do NOT scan stderr on success. Some CLIs (codex) write a
 * full session transcript (prompt + result) to stderr, so pattern-matching it on success would
 * false-positive AUTH/QUOTA on innocent content. AUTH/QUOTA are failure modes: only relevant
 * when the process did not exit cleanly.
 */
export function classify(raw: RawResult): ProviderError | 'OK' {
  if (raw.notFound) return 'NOT_FOUND';
  if (raw.timedOut) return 'TIMEOUT';
  if (raw.code === 0) return 'OK';
  const err = raw.stderr ?? '';
  if (AUTH_RE.test(err)) return 'AUTH';
  if (QUOTA_RE.test(err)) return 'QUOTA';
  return 'CRASH';
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** First balanced {...} object in text, ignoring braces inside strings. */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * §14 JSON location within already-de-enveloped model text:
 * whole-parse → fenced ```json block → first balanced {...}. Returns undefined if none parse.
 */
export function extractJson(text: string): unknown | undefined {
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const p = tryParse(fence[1].trim());
    if (p !== undefined) return p;
  }

  const bal = firstBalancedObject(text);
  if (bal) {
    const p = tryParse(bal);
    if (p !== undefined) return p;
  }
  return undefined;
}

/**
 * Shared adapter runner: build argv → spawn (fd-capture) → classify → de-envelope → extract JSON.
 * Exactly one retry, only for TIMEOUT | BAD_OUTPUT | CRASH (§7.2). AUTH/QUOTA/NOT_FOUND fail fast.
 */
export async function runAdapter(
  spec: AdapterSpec,
  req: RunRequest,
  flags: FlagProfile,
  deps: { spawn?: SpawnCaptureFn } = {},
): Promise<RunResultAdapter> {
  const spawnFn = deps.spawn ?? spawnCapture;

  const attempt = async (): Promise<RunResultAdapter> => {
    const args = spec.buildArgs(req, flags);
    const raw = await spawnFn(spec.id, args, { cwd: req.cwd, timeoutMs: req.timeoutMs, env: filterEnv() });

    const cls = classify(raw);
    if (cls !== 'OK') {
      return { ok: false, error: cls, stderrTail: raw.stderr, durationMs: raw.durationMs };
    }

    const envErr = spec.envelopeError?.(raw.stdout);
    if (envErr) {
      return { ok: false, error: envErr, stderrTail: raw.stderr, durationMs: raw.durationMs };
    }

    const text = spec.extractText(raw.stdout);
    let json: unknown | undefined;
    if (req.expectJson) {
      json = extractJson(text);
      if (json === undefined) {
        return { ok: false, error: 'BAD_OUTPUT', stderrTail: raw.stderr, durationMs: raw.durationMs };
      }
    }
    return { ok: true, text, json, durationMs: raw.durationMs, providerMeta: spec.meta?.(raw.stdout) };
  };

  const first = await attempt();
  if (first.ok) return first;
  if (first.error === 'TIMEOUT' || first.error === 'BAD_OUTPUT' || first.error === 'CRASH') {
    return attempt(); // exactly one retry
  }
  return first;
}
