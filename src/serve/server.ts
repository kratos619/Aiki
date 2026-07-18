// `aiki serve` HTTP server (plan §3.1). Native node:http, static files + JSON API + (HD3) SSE.
// Zero new dependencies. Security posture (kept from the v1 rules):
//   - binds 127.0.0.1 only (never a public interface);
//   - Host header must be localhost/127.0.0.1 (blocks DNS-rebinding);
//   - a per-boot random deckToken is injected into the shell and required on every mutating POST/PATCH;
//   - one active run at a time — a second Convene returns 409 (HD3 sets the lock).
// Nothing path-bearing is ever serialized out: every response body is a projections.ts view.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { z, ZodError } from 'zod';
import { DeckAction, SendInput } from './projections.js';
import { DeckError, type FlightDeck } from './flight-deck.js';
import { encodeSse } from './frames.js';

export interface ServeOptions {
  flightDeck: FlightDeck;
  staticDir: string; // absolute dir of the built serve-ui assets
  port?: number; // explicit port (fails loud if occupied); unset → scan PORT_SCAN
  host?: string; // bind address; default 127.0.0.1
}

export interface RunningServer {
  port: number;
  deckToken: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4173;
const PORT_SCAN_END = 4183;
const HOST = '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Build the request handler around a FlightDeck. Exported for tests (drive it without a socket). */
export function createHandler(opts: { flightDeck: FlightDeck; staticDir: string; deckToken: string; port: number }) {
  const { flightDeck, staticDir, deckToken, port } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!hostAllowed(req, port)) return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // Mutating requests must carry the per-boot deck token (same-origin CSRF guard).
      if (method === 'POST' || method === 'PATCH') {
        if (req.headers['x-deck-token'] !== deckToken) return send(res, 403, { error: 'bad deck token' });
      }

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return await sendShell(res, staticDir, deckToken);
      }
      if (method === 'GET' && path === '/api/bootstrap') {
        return send(res, 200, await flightDeck.bootstrap());
      }
      if (method === 'GET' && path === '/api/settings') {
        return send(res, 200, await flightDeck.settings());
      }
      if (method === 'GET' && path.startsWith('/api/threads/')) {
        const id = decodeURIComponent(path.slice('/api/threads/'.length));
        const detail = await flightDeck.thread(id);
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'no such thread' });
      }
      if (method === 'POST' && path === '/api/providers/check') {
        const { fresh } = z.object({ fresh: z.boolean() }).strict().parse(await readJson(req));
        return send(res, 200, await flightDeck.checkProviders(fresh));
      }
      if (method === 'POST' && path === '/api/messages') {
        return send(res, 202, await flightDeck.send(SendInput.parse(await readJson(req))));
      }
      const runRoute = path.match(/^\/api\/runs\/([^/]+)\/(events|actions|report)$/);
      if (runRoute) {
        const runId = decodeURIComponent(runRoute[1]!);
        const route = runRoute[2]!;
        if (method === 'GET' && route === 'events') return await sendEvents(req, res, flightDeck, runId);
        if (method === 'POST' && route === 'actions') {
          const outcome = await flightDeck.act(runId, DeckAction.parse(await readJson(req)));
          return send(res, 200, outcome ?? { ok: true });
        }
        if (method === 'GET' && route === 'report') return send(res, 200, await flightDeck.report(runId));
        return send(res, 405, { error: 'method not allowed' });
      }
      if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // Static asset (css/js/png) from the serve-ui dir.
      if (method === 'GET') return await sendStatic(res, staticDir, path);
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (e instanceof DeckError) return send(res, e.status, { error: e.message });
      if (e instanceof ZodError) return send(res, 400, { error: 'invalid request' });
      send(res, 500, { error: 'internal error' });
    }
  };
}

/** Start listening on 127.0.0.1. Explicit port that is busy fails loud; otherwise scan 4173–4183. */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const deckToken = randomBytes(16).toString('hex');
  const host = opts.host ?? HOST;
  const handler = (port: number) => createHandler({ flightDeck: opts.flightDeck, staticDir: opts.staticDir, deckToken, port });

  const tryPort = (port: number): Promise<Server | null> =>
    new Promise((resolve, reject) => {
      const server = createHttpServer(handler(port));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') resolve(null);
        else reject(err);
      });
      server.listen(port, host, () => resolve(server));
    });

  if (opts.port !== undefined) {
    const server = await tryPort(opts.port);
    if (!server) throw new Error(`port ${opts.port} is already in use`);
    return running(server, opts.port, deckToken, opts.flightDeck);
  }
  for (let port = DEFAULT_PORT; port <= PORT_SCAN_END; port++) {
    const server = await tryPort(port);
    if (server) return running(server, port, deckToken, opts.flightDeck);
  }
  throw new Error(`no free port in ${DEFAULT_PORT}–${PORT_SCAN_END}`);
}

function running(server: Server, port: number, deckToken: string, flightDeck: FlightDeck): RunningServer {
  return {
    port,
    deckToken,
    close: async () => {
      await flightDeck.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Host allowlist: localhost / 127.0.0.1, with or without the served port. Blocks DNS-rebinding. */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost']);
  return ok.has(host);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

async function sendShell(res: ServerResponse, staticDir: string, deckToken: string): Promise<void> {
  let html: string;
  try {
    html = await readFile(join(staticDir, 'index.html'), 'utf8');
  } catch {
    return send(res, 500, { error: 'serve-ui not built (run npm run build)' });
  }
  const injected = html.replace('__DECK_TOKEN__', deckToken);
  res.writeHead(200, { 'content-type': MIME['.html'], 'x-content-type-options': 'nosniff' });
  res.end(injected);
}

async function sendStatic(res: ServerResponse, staticDir: string, path: string): Promise<void> {
  // Contain the read inside staticDir (no traversal out via ../).
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(staticDir, rel);
  if (!file.startsWith(staticDir)) return send(res, 403, { error: 'forbidden path' });
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > 1_000_000) throw new DeckError(413, 'request body too large');
    chunks.push(part);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DeckError(400, 'invalid JSON');
  }
}

async function sendEvents(req: IncomingMessage, res: ServerResponse, flightDeck: FlightDeck, runId: string): Promise<void> {
  const raw = req.headers['last-event-id'];
  const parsed = Number.parseInt(Array.isArray(raw) ? raw[0] ?? '0' : raw ?? '0', 10);
  const after = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const abort = new AbortController();
  const frames = flightDeck.frames(runId, after, abort.signal);
  const first = await frames.next(); // surface an unknown run before committing a 200 SSE response
  res.once('close', () => abort.abort());
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  res.flushHeaders?.();
  if (!first.done) res.write(encodeSse(first.value));
  for await (const frame of frames) res.write(encodeSse(frame));
  res.end();
}
