// Git plumbing for the code-review workflow (§12.2, T10). This is aiki's OWN read-only git usage
// (compute the diff to review) — not a provider spawn, so it doesn't go through the adapter machinery.
//
// Range semantics: THREE-DOT (`base...head`) = the merge-base diff, i.e. only what HEAD added since it
// diverged from base. That's what "review this branch/PR" means and avoids noise when base moved ahead
// (grilled 2026-07-04).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** Absolute path of the repo root containing `cwd`, or null if `cwd` isn't inside a git work tree. */
export async function repoToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Compute the unified diff to review: `git diff --unified=3 <base>...<head>` (three-dot merge-base). */
export async function computeDiff(base: string, head: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['diff', '--unified=3', `${base}...${head}`], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    throw new GitError(`git diff ${base}...${head} failed: ${(e as Error).message.split('\n')[0]}`);
  }
}

/**
 * Pure: the set of files present at HEAD that the diff touches — parsed from `+++ b/<path>` lines
 * (a `+++ /dev/null` marks a deletion, which has no HEAD file, so it is skipped). These are exactly
 * the files a finding is allowed to reference (§12.2 "file appears in the diff").
 */
export function parseDiffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const path = line.slice(4).trim();
    if (path === '/dev/null') continue;
    files.add(path.startsWith('b/') ? path.slice(2) : path);
  }
  return [...files];
}
