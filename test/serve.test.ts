// HD2 acceptance — `aiki serve` core (shell + status + history, no runs).
// The provider layer is mocked so no real CLI/smoke calls happen; the server guards are exercised
// against a stub FlightDeck; the leak regression greps whole response bodies for filesystem paths.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Detection, FlagProfile, Smoke } from '../src/providers/types.js';

// ── provider layer mock (deterministic, zero real calls) ──────────────────
const detect = vi.fn<(id: string) => Promise<Detection>>();
const probeFlags = vi.fn<(id: string) => Promise<FlagProfile>>();
const smokeTest = vi.fn<(id: string, flags: FlagProfile) => Promise<Smoke>>();

vi.mock('../src/providers/detect.js', () => ({ detect: (id: string) => detect(id) }));
vi.mock('../src/providers/probe.js', () => ({ probeFlags: (id: string) => probeFlags(id) }));
vi.mock('../src/providers/smoke.js', () => ({ smokeTest: (id: string, flags: FlagProfile) => smokeTest(id, flags) }));

import { providerStatusView, quorumView, threadTitle } from '../src/serve/projections.js';
import { DeckError, FlightDeck } from '../src/serve/flight-deck.js';
import { createHandler, hostAllowed } from '../src/serve/server.js';
import type { ProviderRow } from '../src/cli/doctor.js';

const readyDet = (id: 'claude' | 'codex' | 'agy', version = '1.0.0'): Detection => ({ id, status: 'READY', version });
const flags = (id: 'claude' | 'codex' | 'agy'): FlagProfile => ({ id, jsonOutput: true, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' });
const okSmoke: Smoke = { ok: true, nonce: 'n', durationMs: 800 };

function allReady() {
  detect.mockImplementation(async (id) => readyDet(id as any));
  probeFlags.mockImplementation(async (id) => flags(id as any));
  smokeTest.mockImplementation(async () => okSmoke);
}

// ── pure projections ──────────────────────────────────────────────────────

describe('provider status projection', () => {
  const row = (over: Partial<ProviderRow>): ProviderRow => ({ det: readyDet('claude'), flags: flags('claude'), ...over });

  it('green Ready only after a passed smoke', () => {
    expect(providerStatusView(row({ smoke: okSmoke }), null).kind).toBe('ready');
    expect(providerStatusView(row({ smoke: okSmoke }), null).tone).toBe('green');
  });

  it('detected-but-unsmoked stays amber (never claims Ready)', () => {
    const v = providerStatusView(row({}), null);
    expect(v.kind).toBe('detected');
    expect(v.tone).toBe('amber');
  });

  it('maps auth/quota/other smoke failures to amber/amber/red', () => {
    expect(providerStatusView(row({ smoke: { ok: false, error: 'AUTH', nonce: 'n', durationMs: 5 } }), null).kind).toBe('login_required');
    expect(providerStatusView(row({ smoke: { ok: false, error: 'QUOTA', nonce: 'n', durationMs: 5 } }), null).kind).toBe('quota_limited');
    const failed = providerStatusView(row({ smoke: { ok: false, error: 'CRASH', nonce: 'n', durationMs: 5 } }), null);
    expect(failed.kind).toBe('check_failed');
    expect(failed.tone).toBe('red');
  });

  it('not installed is red with the install hint as the fix', () => {
    const v = providerStatusView({ det: { id: 'codex', status: 'NOT_INSTALLED', hint: 'npm i -g codex' } }, null);
    expect(v.kind).toBe('not_installed');
    expect(v.tone).toBe('red');
    expect(v.fix).toBe('npm i -g codex');
  });

  it('a provider with no read-only flag is refused (safety_unavailable)', () => {
    const v = providerStatusView(row({ flags: { id: 'claude', jsonOutput: true, readOnlyFlag: 'none' } }), null);
    expect(v.kind).toBe('safety_unavailable');
    expect(v.tone).toBe('red');
  });

  it('shows the configured model id (never the agy binary in the name)', () => {
    const v = providerStatusView({ det: readyDet('agy'), flags: flags('agy'), smoke: okSmoke }, 'gemini-3.1-pro');
    expect(v.name).toBe('Gemini');
    expect(v.model).toBe('gemini-3.1-pro');
  });
});

describe('quorum projection', () => {
  const v = (kind: string) => ({ id: 'claude', name: 'Claude', kind, label: '', tone: 'green', model: null, version: null, cached: false, fix: null }) as any;
  it('before any smoke, reports detected count, not "unavailable"', () => {
    const q = quorumView([v('detected'), v('detected'), v('detected')]);
    expect(q.tone).toBe('neutral');
    expect(q.label).toContain('detected');
  });
  it('3 ready → green council ready', () => {
    expect(quorumView([v('ready'), v('ready'), v('ready')]).tone).toBe('green');
  });
  it('2 ready → amber degraded', () => {
    expect(quorumView([v('ready'), v('ready'), v('login_required')]).tone).toBe('amber');
  });
});

describe('thread title', () => {
  it('strips a home path a user may have typed and clips to a word boundary', () => {
    expect(threadTitle('/Users/gaurav/secret idea about scheduling')).not.toContain('/Users');
    expect(threadTitle('a'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});

// ── FlightDeck bootstrap: no smoke without the fresh flag ──────────────────

describe('FlightDeck bootstrap (HD2 acceptance)', () => {
  let root: string;
  let home: string;
  const prevHome = process.env.AIKI_HOME;

  beforeEach(async () => {
    vi.clearAllMocks();
    allReady();
    root = await mkdtemp(join(tmpdir(), 'aiki-serve-'));
    home = await mkdtemp(join(tmpdir(), 'aiki-home-'));
    process.env.AIKI_HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = prevHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('bootstrap detects providers but NEVER runs a smoke call', async () => {
    const fd = new FlightDeck({ runsRoot: root, version: '9.9.9' });
    const snap = await fd.bootstrap();
    expect(smokeTest).not.toHaveBeenCalled();
    expect(snap.version).toBe('9.9.9');
    expect(snap.providers).toHaveLength(3);
    // No cached smoke exists → all providers are "detected" (amber), never "ready".
    expect(snap.providers.every((p) => p.kind === 'detected')).toBe(true);
    expect(snap.quorum.tone).toBe('neutral');
  });

  it('checkProviders(fresh) is the only path that runs a smoke', async () => {
    const fd = new FlightDeck({ runsRoot: root, version: '9.9.9' });
    const views = await fd.checkProviders(true);
    expect(smokeTest).toHaveBeenCalledTimes(3);
    expect(views.every((p) => p.kind === 'ready')).toBe(true);
  });

  it('legacy sessions.jsonl runs appear in the thread history', async () => {
    // Seed a completed idea run in a repo runsRoot + register it in the home sessions file.
    const runId = '20260101-1200-idea-refinement-abcd';
    const dir = join(root, 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '00-original.md'), 'Should we self-host the EMR?\nmore text', 'utf8');
    await writeFile(join(dir, 'final-report.md'), 'The verdict.', 'utf8');
    const session = { id: runId, workflow: 'idea-refinement', cwd: root, runsRoot: root, startedAt: '2026-01-01T12:00:00.000Z', status: 'ok' };
    await writeFile(join(home, 'sessions.jsonl'), `${JSON.stringify(session)}\n`, 'utf8');

    const fd = new FlightDeck({ runsRoot: root, version: '9.9.9' });
    const snap = await fd.bootstrap();
    expect(snap.threads).toHaveLength(1);
    expect(snap.threads[0]!.title).toContain('Should we self-host');
    expect(snap.threads[0]!.legacy).toBe(true);
    expect(snap.threads[0]!.status).toBe('complete');

    const detail = await fd.thread(runId);
    expect(detail?.turns[0]).toMatchObject({ kind: 'report_md', markdown: 'The verdict.' });
  });

  it('no response projection leaks a filesystem path', async () => {
    const runId = '20260101-1200-idea-refinement-leak';
    const dir = join(root, 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '00-original.md'), 'A normal idea', 'utf8');
    await writeFile(join(dir, 'final-report.md'), 'Verdict body.', 'utf8');
    await writeFile(join(home, 'sessions.jsonl'), `${JSON.stringify({ id: runId, workflow: 'idea-refinement', cwd: root, runsRoot: root, startedAt: '2026-01-01T12:00:00.000Z', status: 'ok' })}\n`, 'utf8');

    const fd = new FlightDeck({ runsRoot: root, version: '9.9.9' });
    const bodies = [
      JSON.stringify(await fd.bootstrap()),
      JSON.stringify(await fd.settings()),
      JSON.stringify(await fd.thread(runId)),
    ].join('\n');
    expect(bodies).not.toContain(root);
    expect(bodies).not.toContain(home);
    expect(bodies).not.toMatch(/\/(Users|home|tmp|private)\//);
    expect(bodies).not.toContain('/runs/');
  });
});

// ── server guards (stub FlightDeck) ────────────────────────────────────────

/** Minimal in-memory request/response pair for driving createHandler without a socket.
 *  createHandler only touches req.{method,url,headers} (+ iterates the body for POST) and
 *  res.{writeHead,end}, so plain stand-ins suffice. */
function fakeReqRes(method: string, url: string, headers: Record<string, string>, body?: string) {
  const req: any = body !== undefined
    ? Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers })
    : { method, url, headers };
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const res: any = {
    statusCode: 0,
    body: '',
    writeHead(status: number, hdrs: Record<string, string>) { this.statusCode = status; this.headers = hdrs; return this; },
    end(payload?: any) { if (payload != null) this.body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload); resolve(); return this; },
  };
  return { req, res, done, text: () => res.body as string };
}

const stubDeck = {
  bootstrap: vi.fn(async () => ({ ok: 'bootstrap' })),
  checkProviders: vi.fn(async () => [{ checked: true }]),
  settings: vi.fn(async () => ({ settings: true })),
  thread: vi.fn(async (id: string) => (id === 'known' ? { id } : null)),
  send: vi.fn(async () => ({ threadId: 't1', runId: 'r1', status: 'gating' })),
  act: vi.fn(async () => undefined),
  report: vi.fn(async () => ({ report: true })),
  frames: vi.fn(async function* (id: string) {
    if (id === 'unknown') throw new DeckError(404, 'no such run');
  }),
} as any;

function handler(port = 4173) {
  return createHandler({ flightDeck: stubDeck, staticDir: '/nonexistent', deckToken: 'secret', port });
}

describe('server guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hostAllowed accepts localhost/127.0.0.1 (± port), rejects anything else', () => {
    const mk = (host?: string) => ({ headers: { host } }) as any;
    expect(hostAllowed(mk('127.0.0.1:4173'), 4173)).toBe(true);
    expect(hostAllowed(mk('localhost:4173'), 4173)).toBe(true);
    expect(hostAllowed(mk('evil.example.com'), 4173)).toBe(false);
    expect(hostAllowed(mk(undefined), 4173)).toBe(false);
  });

  it('rejects a forbidden Host with 403', async () => {
    const { req, res, done, text } = fakeReqRes('GET', '/api/bootstrap', { host: 'evil.com' });
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(403);
    expect(text()).toContain('forbidden host');
  });

  it('rejects a mutating POST without the deck token', async () => {
    const { req, res, done } = fakeReqRes('POST', '/api/providers/check', { host: 'localhost:4173' }, '{"fresh":true}');
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(403);
    expect(stubDeck.checkProviders).not.toHaveBeenCalled();
  });

  it('accepts a POST with the correct deck token', async () => {
    const { req, res, done } = fakeReqRes('POST', '/api/providers/check', { host: 'localhost:4173', 'x-deck-token': 'secret' }, '{"fresh":true}');
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(stubDeck.checkProviders).toHaveBeenCalledWith(true);
  });

  it('GET bootstrap returns the projection', async () => {
    const { req, res, done, text } = fakeReqRes('GET', '/api/bootstrap', { host: '127.0.0.1:4173' });
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(text())).toEqual({ ok: 'bootstrap' });
  });

  it('unknown thread → 404', async () => {
    const { req, res, done } = fakeReqRes('GET', '/api/threads/unknown', { host: '127.0.0.1:4173' });
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(404);
  });

  it('validates and starts a decision message', async () => {
    const input = { text: 'Choose a path', mode: 'quick', kind: 'decision', attachments: [] };
    const { req, res, done, text } = fakeReqRes('POST', '/api/messages', { host: 'localhost:4173', 'x-deck-token': 'secret' }, JSON.stringify(input));
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(text())).toMatchObject({ runId: 'r1', status: 'gating' });
    expect(stubDeck.send).toHaveBeenCalledWith(input);
  });

  it('maps the one-active-run guard to HTTP 409', async () => {
    stubDeck.send.mockRejectedValueOnce(new DeckError(409, 'council already in session'));
    const input = { text: 'Second decision', mode: 'quick', kind: 'decision', attachments: [] };
    const { req, res, done, text } = fakeReqRes('POST', '/api/messages', { host: 'localhost:4173', 'x-deck-token': 'secret' }, JSON.stringify(input));
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(409);
    expect(text()).toContain('council already in session');
  });

  it('returns the fresh run id produced by a resume action', async () => {
    stubDeck.act.mockResolvedValueOnce({ threadId: 't1', runId: 'r2', status: 'gating' });
    const { req, res, done, text } = fakeReqRes(
      'POST',
      '/api/runs/r1/actions',
      { host: 'localhost:4173', 'x-deck-token': 'secret' },
      JSON.stringify({ t: 'resume' }),
    );
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(text())).toEqual({ threadId: 't1', runId: 'r2', status: 'gating' });
  });

  it('unknown SSE run fails as 404 before event-stream headers are sent', async () => {
    const { req, res, done, text } = fakeReqRes('GET', '/api/runs/unknown/events', { host: 'localhost:4173' });
    await handler()(req, res);
    await done;
    expect(res.statusCode).toBe(404);
    expect(text()).toContain('no such run');
  });
});
