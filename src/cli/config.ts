// `aiki config` (§5/§128) — print the effective config (defaults merged with .aiki/config.json);
// `--edit` opens .aiki/config.json in $VISUAL/$EDITOR, creating it with `{}` if missing.

import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, effectiveConfig, loadLayeredConfig } from '../config/config.js';

const ROOT = '.aiki';
const CONFIG_PATH = join(ROOT, 'config.json');

/** Open the config file in the user's editor, creating an empty `{}` scaffold first if it's missing. */
async function editConfig(): Promise<number> {
  await mkdir(ROOT, { recursive: true });
  try {
    await access(CONFIG_PATH);
  } catch {
    await writeFile(CONFIG_PATH, '{}\n', 'utf8');
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    process.stdout.write(`no $VISUAL/$EDITOR set — edit ${CONFIG_PATH} manually.\n`);
    return 0;
  }
  const parts = editor.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);
  return new Promise<number>((res) => {
    const child = spawn(cmd, [...args, CONFIG_PATH], { stdio: 'inherit' });
    child.on('exit', (code) => res(code ?? 0));
    child.on('error', () => {
      process.stderr.write(`failed to launch editor "${editor}" — edit ${CONFIG_PATH} manually.\n`);
      res(1);
    });
  });
}

export async function config(opts: { edit?: boolean } = {}): Promise<number> {
  if (opts.edit) return editConfig();

  try {
    const eff = effectiveConfig(await loadLayeredConfig()); // global ~/.aiki base + this project's .aiki
    process.stdout.write(`${JSON.stringify(eff, null, 2)}\n`);
    process.stderr.write('(roles shown are config pins; the actual per-run assignment also depends on which providers are available)\n');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
