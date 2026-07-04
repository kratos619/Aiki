// `aiki run <workflow> [input]` (§5) — headless run. idea-refinement takes inline text or a file path;
// code-review computes a git diff from --base/--head (or reads --diff) and reviews it at the repo root.

import { readFile } from 'node:fs/promises';
import { run as runEngine } from '../orchestration/engine.js';
import type { WorkflowId } from '../orchestration/context.js';
import { ConfigError, loadConfig } from '../config/config.js';
import { computeDiff, GitError, repoToplevel } from '../orchestration/git.js';

const WORKFLOWS: WorkflowId[] = ['idea-refinement', 'code-review'];

export interface RunFlags {
  budget?: number;
  base?: string;
  head?: string;
  diff?: string; // path to a patch file (alternative to --base/--head)
}

/** Resolve an idea-refinement input: an existing file path → its contents, else the arg as inline text. */
async function resolveInput(arg: string | undefined): Promise<string | null> {
  if (!arg) return null;
  try {
    return await readFile(arg, 'utf8'); // path
  } catch {
    return arg; // inline text
  }
}

/** Build the code-review input: the unified diff + the repo-root cwd reviewers run in (§12.2). Returns
 *  a `done` code for the non-run outcomes (no changes / usage / git error) so the caller can exit. */
async function resolveCodeReview(opts: RunFlags): Promise<{ text: string; cwd: string } | { done: number }> {
  const repoRoot = await repoToplevel(process.cwd());
  let diff: string;
  if (opts.diff) {
    try {
      diff = await readFile(opts.diff, 'utf8');
    } catch {
      process.stderr.write(`cannot read --diff file "${opts.diff}"\n`);
      return { done: 1 };
    }
  } else {
    if (!opts.base) {
      process.stderr.write('code-review needs --base <ref> (--head defaults to HEAD), or --diff <file>\n');
      return { done: 1 };
    }
    if (!repoRoot) {
      process.stderr.write('not inside a git repository — pass --diff <file> instead\n');
      return { done: 1 };
    }
    try {
      diff = await computeDiff(opts.base, opts.head ?? 'HEAD', repoRoot);
    } catch (e) {
      process.stderr.write(`${e instanceof GitError ? e.message : String(e)}\n`);
      return { done: 1 };
    }
  }
  if (!diff.trim()) {
    process.stdout.write('  no changes to review.\n');
    return { done: 0 };
  }
  return { text: diff, cwd: repoRoot ?? process.cwd() };
}

export async function runCommand(workflow: string, input: string | undefined, opts: RunFlags = {}): Promise<number> {
  if (!WORKFLOWS.includes(workflow as WorkflowId)) {
    process.stderr.write(`unknown workflow "${workflow}". Available: ${WORKFLOWS.join(', ')}\n`);
    return 1;
  }

  let text: string;
  let cwd: string | undefined;
  if (workflow === 'code-review') {
    const r = await resolveCodeReview(opts);
    if ('done' in r) return r.done;
    ({ text, cwd } = r);
  } else {
    const resolved = await resolveInput(input);
    if (!resolved || !resolved.trim()) {
      process.stderr.write(`no input. Usage: aiki run ${workflow} "<text>"  |  aiki run ${workflow} ./file.md\n`);
      return 1;
    }
    text = resolved;
  }

  // Precedence (§10/T9): --budget flag > config.budget > built-in default. roles/deadline are config-only.
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const outcome = await runEngine(workflow as WorkflowId, text, {
    budget: opts.budget ?? cfg.budget,
    deadlineMs: cfg.deadlineMs,
    roleOverrides: cfg.roles,
    cwd, // code-review: repo root; idea-refinement: undefined → run dir
  });

  if (outcome.ok) {
    process.stdout.write(`\n  ✔ run ${outcome.runId} complete — ${outcome.callCount} provider call(s)\n  artifacts: ${outcome.dir}\n\n`);
    return 0;
  }
  process.stderr.write(
    `\n  ✖ run ${outcome.runId} failed [${outcome.error?.code}]: ${outcome.error?.message}\n` +
      (outcome.dir ? `  partial artifacts: ${outcome.dir}\n` : '') +
      '\n',
  );
  return 1;
}
