// Engine run wrapper (§6). Sets up the run folder, walks a workflow's stage composition, and — no
// matter how the run ends — finalizes a valid `meta.json` with the exit status. A fatal error
// (budget/deadline/abort/bad-output/quorum) becomes a graceful failure: partial artifacts on disk
// stay valid (RunWriter atomic writes) and meta records what happened (§6, §19).

import { dirname, resolve } from 'node:path';
import { BudgetExceeded, DeadlineExceeded, StageError, makeRunId, resolveRoles, setupProviders, RunCtx, type RoleMap, type RunEvents, type WorkflowId } from './context.js';
import type { ProviderId } from '../providers/types.js';
import { RunWriter } from '../storage/runs.js';
import { recordSession, updateSessionStatus } from '../storage/sessions.js';
import { runIdeaRefinement } from '../workflows/idea-refinement.js';
import { runCodeReview } from '../workflows/code-review.js';
import type { EvidencePack } from './evidence-pack.js';
import type { IdeaMode } from '../schemas/index.js';

export type WorkflowFn = (ctx: RunCtx, input: string) => Promise<void>;

const WORKFLOWS: Record<WorkflowId, WorkflowFn> = {
  'idea-refinement': runIdeaRefinement,
  'code-review': runCodeReview,
};

export interface RunOutcome {
  ok: boolean;
  runId: string;
  dir: string;
  callCount: number;
  error?: { code: string; message: string };
}

function classifyError(e: unknown): { code: string; aborted: boolean } {
  if (e instanceof BudgetExceeded) return { code: 'BUDGET', aborted: false };
  if (e instanceof DeadlineExceeded) return { code: 'DEADLINE', aborted: false };
  if (e instanceof StageError) return { code: e.code, aborted: e.code === 'ABORT' };
  return { code: 'CRASH', aborted: false };
}

/** Execute a workflow within an already-built RunCtx. Writes 00-original.md, runs the stages, and
 *  finalizes meta.json in both the success and failure paths. */
export async function executeRun(ctx: RunCtx, input: string, fn: WorkflowFn): Promise<RunOutcome> {
  await ctx.writer.init();
  await ctx.writer.writeText('original', input);
  ctx.events?.onStart?.(ctx.runId, ctx.writer.dir);

  const base = { runId: ctx.runId, dir: ctx.writer.dir };
  try {
    await fn(ctx, input);
    await ctx.writer.writeMeta(ctx.buildMeta('ok', false));
    return { ok: true, ...base, callCount: ctx.calls.length };
  } catch (e) {
    const classified = classifyError(e);
    // A fired abort signal wins: record `aborted` even if the surfacing error was e.g. a killed
    // in-flight call classified as CRASH/QUORUM (§472/§603 — Ctrl+C leaves aborted:true meta).
    const aborted = ctx.aborted || classified.aborted;
    // Best-effort finalize: never let a meta-write failure mask the original error.
    await ctx.writer.writeMeta(ctx.buildMeta(aborted ? 'aborted' : 'failed', aborted)).catch(() => {});
    return { ok: false, ...base, callCount: ctx.calls.length, error: { code: classified.code, message: e instanceof Error ? e.message : String(e) } };
  }
}

export interface RunOptions {
  mode?: IdeaMode; // idea-refinement protocol; default council
  budget?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  events?: RunEvents; // TUI seam (T8); absent = headless
  roleOverrides?: Partial<RoleMap>; // §10 override seam; config loading is T9
  cwd?: string; // provider-call working dir; code-review sets the repo root (T10). Default = run dir.
  runsRoot?: string; // where to write .aiki/runs (hybrid: repo vs ~/.aiki). Default = '.aiki' (cwd-relative).
  replay?: Map<string, string>; // resume (V6.3): prior (provider,prompt)→output; matched calls skip the model.
  resumedFrom?: string; // resume: the run id this one continues (recorded in the session registry).
  providerModels?: Partial<Record<ProviderId, string>>; // V8: per-provider model → CLI `--model <id>`.
  evidencePack?: EvidencePack; // idea-refinement: user-scoped source paths + sha256 manifest
}

/**
 * Top-level headless entry (backs `aiki run`): detect+probe providers, check quorum (§8), assign
 * roles (§10), build the RunCtx, and execute the workflow. No smoke test here — a dead provider
 * surfaces as a call failure handled by the stage's quorum logic.
 */
export async function run(workflow: WorkflowId, input: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const handles = await setupProviders(opts.providerModels);
  const requiredProviders = workflow === 'idea-refinement' && opts.mode === 'quick' ? 1 : 2;
  if (handles.length < requiredProviders) {
    return {
      ok: false,
      runId: '(none)',
      dir: '',
      callCount: 0,
      error: { code: 'QUORUM', message: `need ≥${requiredProviders} provider${requiredProviders === 1 ? '' : 's'}, found ${handles.length} — run \`aiki doctor\`` },
    };
  }

  const runId = makeRunId(workflow);
  const roles = resolveRoles(workflow, handles.map((h) => h.id), opts.roleOverrides);
  const writer = new RunWriter(runId, opts.runsRoot);
  const ctx = new RunCtx({
    runId,
    workflow,
    mode: opts.mode,
    handles,
    roles,
    writer,
    cwd: opts.cwd ?? writer.dir, // code-review passes the repo root so reviewers can read the tree
    budget: opts.budget,
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
    events: opts.events,
    replay: opts.replay,
    evidencePack: opts.evidencePack,
  });

  // Register the session (V6.3) so `aiki sessions`/`resume` can find it from anywhere. run() is a
  // real-CLI entry (setupProviders); tests use executeRun directly and never touch the global registry.
  await recordSession({
    id: runId,
    workflow,
    cwd: opts.cwd ?? writer.dir,
    runsRoot: resolve(dirname(dirname(writer.dir))),
    startedAt: new Date().toISOString(),
    status: 'running',
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
  });
  const outcome = await executeRun(ctx, input, WORKFLOWS[workflow]);
  await updateSessionStatus(runId, outcome.ok ? 'ok' : 'failed');
  return outcome;
}
