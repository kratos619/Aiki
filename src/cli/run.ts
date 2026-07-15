// `aiki run <workflow> [input]` (§5) — headless run. idea-refinement takes inline text or a file path;
// code-review computes a git diff from --base/--head (or reads --diff) and reviews it at the repo root.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { renderTerminalSummary, type DecisionReportJson } from '../orchestration/stages/s10-render.js';
import { run as runEngine } from '../orchestration/engine.js';
import type { RoleMap, WorkflowId } from '../orchestration/context.js';
import { ConfigError, loadLayeredConfig } from '../config/config.js';
import { computeDiff, detectDefaultBranch, GitError, repoToplevel } from '../orchestration/git.js';
import { resolveRunsRoot } from '../storage/paths.js';
import { openCouncilHtml } from '../council/open.js';
import { buildEvidencePack, type EvidencePack } from '../orchestration/evidence-pack.js';
import { IdeaModeSchema, type IdeaMode } from '../schemas/index.js';
import { defaultBudgetFor, defaultDeadlineFor, IDEA_MODE_PLANS, inferIdeaMode } from '../orchestration/modes.js';

const WORKFLOWS: WorkflowId[] = ['idea-refinement', 'code-review'];

export interface RunFlags {
  budget?: number;
  base?: string;
  head?: string;
  diff?: string; // path to a patch file (alternative to --base/--head)
  cheap?: boolean; // code-review: agy+codex reviewers, claude judge (Opus-thrift; experimental — bench Arm E)
  yes?: boolean; // skip the run-cost confirmation (also skipped when non-interactive)
  evidence?: string; // idea-refinement: user-scoped local source file/directory
  mode?: string; // idea-refinement: quick | council | research
}

/** Rough provider-call estimate for the run-cost preview (V5). Approximate — the real count varies with
 *  §14 repairs, cross-exam skips, and quorum. `opus` = the Claude/Opus subset (the metered-cost driver). */
export interface RunEstimate {
  calls: number;
  opus: number;
  minCalls?: number;
  reserved?: number;
}

export function estimateRun(workflow: WorkflowId, opts: { cheap?: boolean; mode?: IdeaMode } = {}): RunEstimate {
  if (workflow === 'code-review') return { calls: 5, opus: opts.cheap ? 1 : 2 };
  const mode = opts.mode ?? 'council';
  const plan = IDEA_MODE_PLANS[mode];
  return {
    calls: plan.maxCalls,
    opus: mode === 'quick' ? 1 : 2,
    minCalls: mode === 'research' ? 8 : plan.baseCalls,
    reserved: plan.reservedCalls,
  };
}

/** Thin y/N prompt (default yes). Only used on an interactive TTY. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(!/^n/i.test(a.trim()));
    });
  });
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
    if (!repoRoot) {
      process.stderr.write('not inside a git repository — pass --diff <file> instead\n');
      return { done: 1 };
    }
    const base = opts.base ?? await detectDefaultBranch(repoRoot);
    if (!base) {
      process.stderr.write('cannot detect default branch — pass --base <ref>, or --diff <file>\n');
      return { done: 1 };
    }
    try {
      diff = await computeDiff(base, opts.head ?? 'HEAD', repoRoot);
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

  let mode: IdeaMode | undefined;
  if (workflow === 'idea-refinement') {
    if (opts.mode !== undefined) {
      const parsed = IdeaModeSchema.safeParse(opts.mode);
      if (!parsed.success) {
        process.stderr.write(`unknown idea mode "${opts.mode}". Available: quick, council, research\n`);
        return 1;
      }
      mode = parsed.data;
    }
  } else if (opts.mode) {
    process.stderr.write('--mode only applies to idea-refinement.\n');
    return 1;
  }

  let text: string;
  let cwd: string | undefined;
  let evidencePack: EvidencePack | undefined;
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
    mode ??= inferIdeaMode(text);
  }

  if (opts.evidence) {
    if (workflow !== 'idea-refinement') {
      process.stderr.write('--evidence only applies to idea-refinement.\n');
      return 1;
    }
    try {
      evidencePack = await buildEvidencePack(opts.evidence);
    } catch (error) {
      process.stderr.write(`cannot load evidence pack: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // Precedence (§10/T9): --budget flag > config.budget > built-in default. roles/deadline/models are
  // config-only (layered: global ~/.aiki base, project .aiki override).
  let cfg;
  try {
    cfg = await loadLayeredConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
    throw e;
  }

  // --cheap = bench Arm E's Opus-thrift role swap (agy+codex reviewers, claude judge). code-review only;
  // takes precedence over config roles for those two seats. Experimental — see BENCHMARK.md amendment E1.
  let roleOverrides: Partial<RoleMap> | undefined = cfg.roles;
  if (opts.cheap) {
    if (workflow === 'code-review') roleOverrides = { ...cfg.roles, s4: ['agy', 'codex'], judge: 'claude' };
    else process.stderr.write('--cheap only applies to code-review; ignoring for this workflow.\n');
  }

  // Run-cost preview (V5): show the estimate; confirm interactively unless --yes or non-interactive.
  const est = estimateRun(workflow as WorkflowId, { cheap: opts.cheap, mode });
  const callEstimate = est.minCalls !== undefined && est.minCalls !== est.calls ? `${est.minCalls}–${est.calls}` : `${est.calls}`;
  const resolvedBudget = opts.budget ?? cfg.budget ?? defaultBudgetFor(workflow as WorkflowId, mode);
  const reservation = est.reserved ? `; ${est.reserved} call(s) reserved for chair + planner` : '';
  const modeLabel = mode ? ` in ${mode} mode` : '';
  const note = `  ≈${callEstimate} provider call(s)${modeLabel}, ~${est.opus} on Claude/Opus; budget ${resolvedBudget}${reservation}.`;
  if (!opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    if (!(await confirm(`${note}\n  Continue? [Y/n] `))) {
      process.stdout.write('  cancelled.\n');
      return 0;
    }
  } else {
    process.stdout.write(`${note}\n`);
  }

  const outcome = await runEngine(workflow as WorkflowId, text, {
    mode,
    budget: resolvedBudget,
    deadlineMs: cfg.deadlineMs ?? defaultDeadlineFor(workflow as WorkflowId, mode),
    roleOverrides,
    cwd, // code-review: repo root; idea-refinement: undefined → run dir
    runsRoot: await resolveRunsRoot(), // hybrid: repo .aiki when in a repo, else ~/.aiki
    providerModels: cfg.models, // V8: per-provider model → CLI --model
    evidencePack,
  });

  if (outcome.ok) {
    process.stdout.write(`\n  ✔ run ${outcome.runId} complete — ${outcome.callCount} provider call(s)\n  artifacts: ${outcome.dir}\n\n`);
    // Level-1 terminal summary from the machine-readable report (idea runs; absent for code-review).
    try {
      const report = JSON.parse(await readFile(join(outcome.dir, '10-decision-report.json'), 'utf8')) as DecisionReportJson;
      const summary = renderTerminalSummary(report, {
        markdownPath: join(outcome.dir, 'final-report.md'),
        jsonPath: join(outcome.dir, '10-decision-report.json'),
      });
      process.stdout.write(summary.split('\n').map((line) => `  ${line}`).join('\n') + '\n');
    } catch {
      /* code-review runs and pre-v4 artifacts have no decision report — the line above already links artifacts */
    }
    // Auto-open the readable report in the browser (interactive terminals only; skipped in pipes/CI).
    if (process.stdout.isTTY) {
      const html = await openCouncilHtml(outcome.runId, outcome.dir);
      if (html) process.stdout.write(`  report: ${html} — opening in your browser…\n`);
    }
    process.stdout.write('\n');
    return 0;
  }
  process.stderr.write(
    `\n  ✖ run ${outcome.runId} failed [${outcome.error?.code}]: ${outcome.error?.message}\n` +
      (outcome.dir ? `  partial artifacts: ${outcome.dir}\n` : '') +
      '\n',
  );
  return 1;
}
