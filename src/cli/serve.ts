// `aiki serve` — open the chat workspace on localhost. Resolves the built serve-ui assets, builds a
// FlightDeck over the hybrid runs root, starts the server, and (unless --no-open) opens the browser.
// The process stays up until Ctrl+C; there are no paid calls until the user convenes a run in the UI.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlightDeck } from '../serve/flight-deck.js';
import { startServer } from '../serve/server.js';
import { openInBrowser } from '../council/open.js';
import { resolveRunsRoot } from '../storage/paths.js';
import { VERSION } from './version.js';

/** Locate the serve-ui assets: dist/serve-ui next to this module (built), else repo-root serve-ui (dev). */
function resolveStaticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/cli
  const built = join(here, '..', 'serve-ui'); // dist/serve-ui
  if (existsSync(join(built, 'index.html'))) return built;
  return join(here, '..', '..', 'serve-ui'); // repo-root serve-ui (running from src)
}

export async function serveCommand(opts: { port?: number; open?: boolean } = {}): Promise<number> {
  const runsRoot = await resolveRunsRoot();
  const log = (line: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    process.stdout.write(`  \x1b[2m${time}\x1b[0m  ${line}\n`);
  };
  const flightDeck = new FlightDeck({ runsRoot, version: VERSION, log });
  const staticDir = resolveStaticDir();

  let server;
  try {
    server = await startServer({ flightDeck, staticDir, port: opts.port });
  } catch (e) {
    process.stderr.write(`aiki serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const url = `http://127.0.0.1:${server.port}`;
  process.stdout.write(`\n  aiki workspace → ${url}\n  (Ctrl+C to stop)\n\n`);
  if (opts.open !== false) openInBrowser(url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close().finally(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}
