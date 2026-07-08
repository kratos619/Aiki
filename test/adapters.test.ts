import { describe, it, expect } from 'vitest';
import { classify, extractJson, filterEnv } from '../src/providers/adapter-core.js';
import { claude } from '../src/providers/claude.js';
import { agy } from '../src/providers/agy.js';
import { codex } from '../src/providers/codex.js';
import type { FlagProfile, RawResult, RunRequest, SpawnCaptureFn } from '../src/providers/types.js';

const raw = (o: Partial<RawResult>): RawResult => ({
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  notFound: false,
  durationMs: 5,
  ...o,
});

// A fake spawn that returns a scripted RawResult per call, and records argv.
function scriptedSpawn(results: RawResult[]) {
  const calls: { bin: string; args: string[] }[] = [];
  const fn: SpawnCaptureFn = async (bin, args) => {
    calls.push({ bin, args });
    return results[calls.length - 1] ?? results[results.length - 1]!;
  };
  return { fn, calls };
}

const CLAUDE_FLAGS: FlagProfile = { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' };
const AGY_FLAGS: FlagProfile = { id: 'agy', jsonOutput: false, readOnlyFlag: 'sandbox' };
const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  prompt: 'hi',
  cwd: '/repo',
  timeoutMs: 1000,
  expectJson: true,
  ...over,
});

describe('filterEnv', () => {
  it('strips credential-looking keys, keeps the rest', () => {
    const out = filterEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', MY_TOKEN: 'y', GH_SECRET: 'z', HOME: '/h' });
    expect(out.PATH).toBe('/bin');
    expect(out.HOME).toBe('/h');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.MY_TOKEN).toBeUndefined();
    expect(out.GH_SECRET).toBeUndefined();
  });
});

describe('classify', () => {
  it('NOT_FOUND when binary missing', () => expect(classify(raw({ notFound: true }))).toBe('NOT_FOUND'));
  it('TIMEOUT when timed out', () => expect(classify(raw({ timedOut: true, code: null }))).toBe('TIMEOUT'));
  it('AUTH on login/expired stderr', () => expect(classify(raw({ code: 1, stderr: 'Error: please run login' }))).toBe('AUTH'));
  it('AUTH on ineligible-tier stderr (agy/gemini)', () =>
    expect(classify(raw({ code: 1, stderr: 'IneligibleTierError: no longer supported' }))).toBe('AUTH'));
  it('QUOTA on rate-limit stderr', () => expect(classify(raw({ code: 1, stderr: 'HTTP 429 rate limit exceeded' }))).toBe('QUOTA'));
  it('CRASH on nonzero exit with generic stderr', () => expect(classify(raw({ code: 2, stderr: 'segfault' }))).toBe('CRASH'));
  it('OK on clean exit', () => expect(classify(raw({ code: 0 }))).toBe('OK'));
  it('OK on clean exit even when stderr transcript contains auth/quota words (codex case)', () =>
    // codex mirrors prompt+result to stderr; a successful run must not be misread as AUTH/QUOTA.
    expect(classify(raw({ code: 0, stderr: 'user\nplease login and check the rate limit quota\ncodex\n{"ok":true}' }))).toBe('OK'));
});

describe('extractJson (§14)', () => {
  it('parses whole output', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('parses fenced ```json block', () => expect(extractJson('prose\n```json\n{"a":2}\n```\nmore')).toEqual({ a: 2 }));
  it('parses first balanced object amid prose', () => expect(extractJson('here: {"a":{"b":3}} done')).toEqual({ a: { b: 3 } }));
  it('ignores braces inside strings', () => expect(extractJson('x {"s":"a}b","n":4} y')).toEqual({ s: 'a}b', n: 4 }));
  it('returns undefined when no JSON', () => expect(extractJson('no json here')).toBeUndefined());
});

describe('claude adapter', () => {
  it('builds argv with json + plan flags; extracts .result from envelope', async () => {
    const env = JSON.stringify({ type: 'result', is_error: false, result: '{"ok":true,"echo":"n"}', session_id: 's1', total_cost_usd: 0.01 });
    const { fn, calls } = scriptedSpawn([raw({ stdout: env })]);
    const res = await claude.run(req(), CLAUDE_FLAGS, { spawn: fn });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.json).toEqual({ ok: true, echo: 'n' });
      expect(res.providerMeta?.session_id).toBe('s1');
    }
    expect(calls[0]!.args).toEqual(['-p', 'hi', '--output-format', 'json', '--permission-mode', 'plan']);
  });

  it('maps envelope is_error:true to CRASH (then retries once → 2 calls)', async () => {
    const errEnv = JSON.stringify({ type: 'result', is_error: true, result: '' });
    const { fn, calls } = scriptedSpawn([raw({ stdout: errEnv }), raw({ stdout: errEnv })]);
    const res = await claude.run(req(), CLAUDE_FLAGS, { spawn: fn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('CRASH');
    expect(calls.length).toBe(2); // one retry for CRASH
  });

  it('omits read-only flag when readOnly:false', async () => {
    const env = JSON.stringify({ result: '{"ok":true}' });
    const { fn, calls } = scriptedSpawn([raw({ stdout: env })]);
    await claude.run(req({ readOnly: false }), CLAUDE_FLAGS, { spawn: fn });
    expect(calls[0]!.args).not.toContain('--permission-mode');
  });
});

describe('agy adapter', () => {
  it('builds argv with --sandbox; parses raw JSON (no envelope)', async () => {
    const { fn, calls } = scriptedSpawn([raw({ stdout: '{"ok":true,"echo":"z"}' })]);
    const res = await agy.run(req(), AGY_FLAGS, { spawn: fn });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.json).toEqual({ ok: true, echo: 'z' });
    expect(calls[0]!.args).toEqual(['-p', 'hi', '--sandbox']);
  });
});

describe('codex adapter', () => {
  const CODEX_FLAGS: FlagProfile = { id: 'codex', jsonOutput: true, readOnlyFlag: 'sandbox' };

  it('builds `exec --skip-git-repo-check -s read-only <prompt>`; parses clean stdout', async () => {
    const { fn, calls } = scriptedSpawn([raw({ stdout: '{"ok":true,"echo":"c"}' })]);
    const res = await codex.run(req(), CODEX_FLAGS, { spawn: fn });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.json).toEqual({ ok: true, echo: 'c' });
    expect(calls[0]!.args).toEqual(['exec', '--skip-git-repo-check', '-s', 'read-only', 'hi']);
  });

  it('succeeds despite auth-looking words in the stderr transcript', async () => {
    const { fn } = scriptedSpawn([raw({ code: 0, stdout: '{"ok":true}', stderr: 'user: please login\ncodex\n{"ok":true}' })]);
    const res = await codex.run(req(), CODEX_FLAGS, { spawn: fn });
    expect(res.ok).toBe(true);
  });
});

describe('retry policy (§7.2)', () => {
  it('BAD_OUTPUT retries exactly once (2 calls)', async () => {
    const { fn, calls } = scriptedSpawn([raw({ stdout: 'not json' }), raw({ stdout: 'still not json' })]);
    const res = await agy.run(req(), AGY_FLAGS, { spawn: fn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('BAD_OUTPUT');
    expect(calls.length).toBe(2);
  });

  it('BAD_OUTPUT then success on retry returns ok', async () => {
    const { fn, calls } = scriptedSpawn([raw({ stdout: 'oops' }), raw({ stdout: '{"ok":true}' })]);
    const res = await agy.run(req(), AGY_FLAGS, { spawn: fn });
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('AUTH fails fast — no retry (1 call)', async () => {
    const { fn, calls } = scriptedSpawn([raw({ code: 1, stderr: 'please login' })]);
    const res = await agy.run(req(), AGY_FLAGS, { spawn: fn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('AUTH');
    expect(calls.length).toBe(1);
  });

  it('TIMEOUT retries once (2 calls)', async () => {
    const { fn, calls } = scriptedSpawn([raw({ timedOut: true, code: null }), raw({ timedOut: true, code: null })]);
    const res = await claude.run(req(), CLAUDE_FLAGS, { spawn: fn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('TIMEOUT');
    expect(calls.length).toBe(2);
  });
});
