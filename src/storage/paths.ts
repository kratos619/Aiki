// Where aiki keeps its files when launched from anywhere (hybrid model, user decision 2026-07-06).
//
//   runs  → the project's `.aiki/` when you are inside a git repo, else the global `~/.aiki/`.
//           So project work stays co-located with its project, but running from home still has a home.
//   home  → `~/.aiki/` holds the global session registry (+ later: global config).
//
// Library defaults elsewhere stay `.aiki` (cwd-relative) for tests/back-compat; only the CLI entry
// points resolve the hybrid root and inject it. Kept tiny + pure-ish (one git probe) on purpose.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { repoToplevel } from '../orchestration/git.js';

/** Global aiki home — `$AIKI_HOME` if set, else `~/.aiki`. Holds the cross-location session registry. */
export function homeAikiRoot(): string {
  return process.env.AIKI_HOME ?? join(homedir(), '.aiki');
}

/** Hybrid runs root for `cwd`: `<repoRoot>/.aiki` inside a git repo, else `~/.aiki`. */
export async function resolveRunsRoot(cwd: string = process.cwd()): Promise<string> {
  const repo = await repoToplevel(cwd);
  return repo ? join(repo, '.aiki') : homeAikiRoot();
}
