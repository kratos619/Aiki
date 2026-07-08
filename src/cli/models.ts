// `aiki models` (V8) — show which model each provider can run and your current per-provider pins.
// Only agy exposes a `models` command (verified 2026-07-06, docs/PROVIDER_NOTES.md); claude/codex take
// any id via `--model` but don't enumerate, so we say "type any id". Listing is free (no inference).

import { execFile } from 'node:child_process';
import { PROVIDER_IDS, DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import { detect } from '../providers/detect.js';
import { loadLayeredConfig } from '../config/config.js';
import { homeAikiRoot } from '../storage/paths.js';

/** Models the CLI can enumerate, or null if it has no list command. `agy models` blocks on stdin without
 *  a TTY (the known agy trap — see PROVIDER_NOTES), so we close the child's stdin. */
function listModels(id: ProviderId): Promise<string[] | null> {
  if (id !== 'agy') return Promise.resolve(null); // only agy has a `models` subcommand
  return new Promise((resolve) => {
    const child = execFile('agy', ['models'], { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    });
    child.stdin?.end();
  });
}

/** Build the `aiki models` report as a string (so the TUI can render it too, not just stdout). */
export async function formatModels(): Promise<string> {
  const cfg = await loadLayeredConfig();
  const models = cfg.models ?? {};
  const out: string[] = ['Models — aiki passes your choice to each CLI as `--model <id>`.', ''];

  for (const id of PROVIDER_IDS) {
    const det = await detect(id);
    const pinned = models[id];
    const current = pinned ? `pinned: ${pinned}` : 'CLI default';
    if (det.status !== 'READY') {
      out.push(`${DISPLAY_NAME[id]} (${id}) — not installed`, '');
      continue;
    }
    out.push(`${DISPLAY_NAME[id]} (${id}) · ${current}`);
    const list = await listModels(id);
    if (list && list.length) list.forEach((m) => out.push(`    ${m}`));
    else out.push("    (this CLI doesn't list models — set any id it accepts)");
    out.push('');
  }

  out.push('Set a model in .aiki/config.json (this project) or ' + homeAikiRoot() + '/config.json (global):');
  out.push('  { "models": { "agy": "Gemini 3.1 Pro (High)", "claude": "opus", "codex": "gpt-5-codex" } }');
  return out.join('\n');
}

export async function modelsCommand(): Promise<number> {
  process.stdout.write(`${await formatModels()}\n`);
  return 0;
}
