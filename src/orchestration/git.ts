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

async function gitStdout(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function chooseDefaultBranch(originHead: string | null, refs: string[]): string | null {
  const trimmed = originHead?.trim();
  if (trimmed) return trimmed;
  for (const name of ['main', 'master']) {
    if (refs.includes(name)) return name;
    if (refs.includes(`origin/${name}`)) return `origin/${name}`;
  }
  return null;
}

export async function detectDefaultBranch(cwd: string): Promise<string | null> {
  const originHead = await gitStdout(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  const refsRaw = await gitStdout(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], cwd);
  return chooseDefaultBranch(originHead, refsRaw ? refsRaw.split('\n').filter(Boolean) : []);
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

async function mergeBase(base: string, head: string, cwd: string): Promise<string> {
  const mb = await gitStdout(['merge-base', base, head], cwd);
  if (!mb) throw new GitError(`git merge-base ${base} ${head} failed`);
  return mb;
}

async function untrackedFiles(cwd: string): Promise<string[]> {
  const raw = await gitStdout(['ls-files', '--others', '--exclude-standard'], cwd);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

async function diffUntrackedFile(file: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as Error & { stdout?: string };
    if (err.stdout) return err.stdout;
    throw e;
  }
}

/** Diff from the merge-base to the current working tree, including staged, unstaged, and untracked files. */
export async function computeWorkingTreeDiff(base: string, cwd: string): Promise<string> {
  try {
    const mb = await mergeBase(base, 'HEAD', cwd);
    const { stdout } = await exec('git', ['diff', '--unified=3', mb], { cwd, maxBuffer: 32 * 1024 * 1024 });
    const extra = await Promise.all((await untrackedFiles(cwd)).map((f) => diffUntrackedFile(f, cwd)));
    return [stdout, ...extra].filter(Boolean).join('\n');
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError(`git diff working tree against ${base} failed: ${(e as Error).message.split('\n')[0]}`);
  }
}

export async function changedFilesSinceDefault(base: string, cwd: string): Promise<number> {
  try {
    const mb = await mergeBase(base, 'HEAD', cwd);
    const { stdout } = await exec('git', ['diff', '--name-only', mb], { cwd, maxBuffer: 32 * 1024 * 1024 });
    const files = new Set([...stdout.split('\n').filter(Boolean), ...await untrackedFiles(cwd)]);
    return files.size;
  } catch {
    return 0;
  }
}

export interface RepoStatus {
  root: string;
  name: string;
  defaultBranch: string | null;
  changedFiles: number;
}

export async function detectRepoStatus(cwd: string): Promise<RepoStatus | null> {
  const root = await repoToplevel(cwd);
  if (!root) return null;
  const defaultBranch = await detectDefaultBranch(root);
  const changedFiles = defaultBranch ? await changedFilesSinceDefault(defaultBranch, root) : 0;
  return { root, name: root.split('/').filter(Boolean).at(-1) ?? root, defaultBranch, changedFiles };
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
