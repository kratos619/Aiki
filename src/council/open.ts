// Open a finished run's council HTML in the OS browser. Shared by `aiki show --open`, the headless
// `aiki run` success path, and the TUI. Best-effort: auto-open is a convenience, never a run failure.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeCouncilHtml } from './view.js';

/** Open a file in the OS default handler. Detached + unref so aiki can exit immediately. */
export function openInBrowser(path: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [path], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => process.stderr.write(`could not auto-open — open it manually: ${path}\n`));
  child.unref();
}

/** Render a finished run's council HTML and open it. Never throws — returns the absolute path, or null. */
export async function openCouncilHtml(runId: string, dir: string): Promise<string | null> {
  try {
    const path = await writeCouncilHtml(runId, dir);
    if (!path) return null;
    const abs = resolve(path);
    openInBrowser(abs);
    return abs;
  } catch {
    return null;
  }
}
