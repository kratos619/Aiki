import type { Detection, ProviderId, RunFn } from './types.js';
import { runCommand } from './spawn.js';

const DETECT_TIMEOUT_MS = 5000;

const INSTALL_HINT: Record<ProviderId, string> = {
  claude: "not on PATH — install: npm i -g @anthropic-ai/claude-code",
  codex: "not on PATH — install: npm i -g @openai/codex",
  gemini: "not on PATH — install: npm i -g @google/gemini-cli",
};

/** Pull a semver-ish token out of a `--version` line (formats vary per CLI). */
export function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/\d+\.\d+\.\d+[\w.-]*/);
  return m ? m[0] : undefined;
}

/** Detection: PATH lookup + `--version`, 5s timeout, no model calls (§8). */
export async function detect(id: ProviderId, run: RunFn = runCommand): Promise<Detection> {
  const r = await run(id, ['--version'], DETECT_TIMEOUT_MS);
  if (r.notFound) {
    return { id, status: 'NOT_INSTALLED', hint: INSTALL_HINT[id] };
  }
  const version = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  return { id, status: 'READY', version };
}
