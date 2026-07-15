// `aiki resume <session-id>` (V6.3) — continue a killed/timed-out run from where it stopped, without
// re-spending the calls that already succeeded. It re-runs the pipeline into a FRESH run, replaying every
// completed (provider, prompt) from the old run's raw/ outputs; only the failed stage onward hits a model.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run as runEngine } from '../orchestration/engine.js';
import type { WorkflowId } from '../orchestration/context.js';
import { ConfigError, loadLayeredConfig } from '../config/config.js';
import { resolveRunsRoot } from '../storage/paths.js';
import { buildReplayCache } from '../storage/replay.js';
import { findSession } from '../storage/sessions.js';
import { readJsonArtifact, resolveRunId, runDir } from '../storage/runs-read.js';
import type { RunMeta } from '../schemas/index.js';
import { EvidencePack, type EvidencePack as EvidencePackT } from '../orchestration/evidence-pack.js';

export async function resumeCommand(runArg: string | undefined, opts: { root?: string } = {}): Promise<number> {
  if (!runArg) {
    process.stderr.write('usage: aiki resume <session-id>   (see `aiki sessions`)\n');
    return 1;
  }
  const root = opts.root ?? '.aiki';

  // Locate the run: prefer the global registry (finds it across locations), else the current root.
  let oldId: string;
  let oldDir: string;
  let workflow: WorkflowId;
  let cwd: string | undefined;
  const sess = await findSession(runArg);
  if (sess && 'ambiguous' in sess) {
    process.stderr.write(`"${runArg}" is ambiguous — matches:\n${sess.ambiguous.map((c) => `  ${c}`).join('\n')}\n`);
    return 1;
  }
  if (sess) {
    oldId = sess.id;
    workflow = sess.workflow as WorkflowId;
    oldDir = join(sess.runsRoot, 'runs', sess.id);
    cwd = sess.cwd;
  } else {
    const match = await resolveRunId(runArg, root);
    if (!match.ok) {
      process.stderr.write(`no run matches "${runArg}" (checked the session registry and ${root}/runs).\n`);
      return 1;
    }
    oldId = match.runId;
    oldDir = runDir(match.runId, root);
    const meta = await readJsonArtifact<RunMeta>(oldDir, 'meta.json');
    if (!meta) {
      process.stderr.write(`cannot read meta.json for ${oldId} — nothing to resume.\n`);
      return 1;
    }
    workflow = meta.workflow;
  }
  const previousMeta = await readJsonArtifact<RunMeta>(oldDir, 'meta.json');
  if (!previousMeta) {
    process.stderr.write(`cannot read meta.json for ${oldId} — nothing to resume.\n`);
    return 1;
  }

  // Recover the original input the run was started with.
  const inputFile = workflow === 'code-review' ? 'diff.patch' : 'idea.md';
  let input: string;
  try {
    input = await readFile(join(oldDir, 'inputs', inputFile), 'utf8');
  } catch {
    process.stderr.write(`cannot recover the input (inputs/${inputFile}) for ${oldId} — nothing to resume.\n`);
    return 1;
  }
  let evidencePack: EvidencePackT | undefined;
  const savedEvidencePack = await readJsonArtifact(oldDir, 'inputs/evidence-pack.json');
  if (savedEvidencePack) {
    const parsed = EvidencePack.safeParse(savedEvidencePack);
    if (!parsed.success) {
      process.stderr.write(`cannot validate inputs/evidence-pack.json for ${oldId} — nothing to resume.\n`);
      return 1;
    }
    evidencePack = parsed.data;
  }

  const replay = await buildReplayCache(oldDir);
  if (replay.size === 0) {
    process.stderr.write(`no completed calls found for ${oldId} — start a fresh run instead.\n`);
    return 1;
  }

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

  process.stdout.write(`  resuming ${oldId} (${workflow}) — replaying ${replay.size} completed call(s); only the rest will hit a model.\n`);
  const outcome = await runEngine(workflow, input, {
    mode: previousMeta.mode,
    budget: cfg.budget,
    deadlineMs: cfg.deadlineMs,
    roleOverrides: cfg.roles,
    cwd: workflow === 'code-review' ? cwd : undefined, // code-review reviewers run at the repo root
    runsRoot: await resolveRunsRoot(),
    replay,
    resumedFrom: oldId,
    providerModels: cfg.models,
    evidencePack,
  });

  if (outcome.ok) {
    process.stdout.write(`\n  ✔ resumed run ${outcome.runId} complete — ${outcome.callCount} new provider call(s)\n  artifacts: ${outcome.dir}\n\n`);
    return 0;
  }
  process.stderr.write(
    `\n  ✖ resumed run ${outcome.runId} failed [${outcome.error?.code}]: ${outcome.error?.message}\n` +
      (outcome.dir ? `  partial artifacts: ${outcome.dir} — you can \`aiki resume ${outcome.runId}\` again\n` : '') +
      '\n',
  );
  return 1;
}
