// `aiki show <run-id>` (§5) — print a stored run's final report; `--raw` lists artifact files.
// A partial/aborted run (no final-report.md) falls back to a short summary from meta.json (grilled
// 2026-07-04). Run-id arg is resolved by suffix/substring (no arg → latest).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { RunMeta } from '../schemas/index.js';
import { listArtifacts, readFinalReport, readJsonArtifact, resolveRunId, runDir } from '../storage/runs-read.js';
import { writeCouncilHtml } from '../council/view.js';

/** Open a file in the OS default handler. Detached + unref so aiki can exit immediately. */
function openInBrowser(path: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [path], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => process.stderr.write(`could not auto-open — open it manually: ${path}\n`));
  child.unref();
}

/** Emit the resolution error for a failed run-id match. */
function reportMatchError(match: Extract<Awaited<ReturnType<typeof resolveRunId>>, { ok: false }>): void {
  if (match.kind === 'none') {
    process.stderr.write('no runs found under .aiki/runs/ — run one first (`aiki run idea-refinement …`)\n');
  } else if (match.kind === 'no-match') {
    process.stderr.write(`no run matches "${match.arg}". Omit the id for the most recent run.\n`);
  } else {
    process.stderr.write(`"${match.arg}" is ambiguous — matches:\n${match.candidates.map((c) => `  ${c}`).join('\n')}\n`);
  }
}

/** Short summary for a run with no final report (aborted/partial). */
function partialSummary(runId: string, meta: RunMeta | null, artifacts: string[]): string {
  const stages = artifacts.filter((f) => /^\d\d?[-/]/.test(f)).map((f) => f.split('/')[0]);
  const uniqueStages = [...new Set(stages)];
  const lines = [`  run ${runId} — incomplete (no final report)`];
  if (meta) {
    lines.push(`  workflow:     ${meta.workflow}`);
    lines.push(`  exit status:  ${meta.exit_status}${meta.aborted ? ' (aborted:true)' : ''}`);
    lines.push(`  calls:        ${meta.call_count}/${meta.budget.limit}`);
    if (meta.flags?.length) lines.push(`  flags:        ${meta.flags.join(', ')}`);
  } else {
    lines.push('  meta.json absent — run likely crashed before finalize.');
  }
  lines.push(`  stages on disk: ${uniqueStages.join(', ') || '(none)'}`);
  lines.push(`  → inspect partial artifacts:  aiki show ${runId} --raw`);
  return lines.join('\n');
}

export async function show(runArg: string | undefined, opts: { raw?: boolean; html?: boolean; open?: boolean; root?: string } = {}): Promise<number> {
  const root = opts.root ?? '.aiki';
  const match = await resolveRunId(runArg, root);
  if (!match.ok) {
    reportMatchError(match);
    return 1;
  }
  const dir = runDir(match.runId, root);

  if (opts.html) {
    const path = await writeCouncilHtml(match.runId, dir);
    if (!path) {
      process.stderr.write(`cannot render council view for ${match.runId}: missing or unreadable meta.json\n`);
      return 1;
    }
    const abs = resolve(path);
    process.stdout.write(`${abs}\n`);
    if (opts.open) openInBrowser(abs);
    return 0;
  }

  if (opts.raw) {
    const files = await listArtifacts(dir);
    process.stdout.write(`${dir}\n${files.map((f) => `  ${f}`).join('\n')}\n`);
    return 0;
  }

  const report = await readFinalReport(dir);
  if (report !== null) {
    process.stdout.write(report.endsWith('\n') ? report : `${report}\n`);
    return 0;
  }

  // No final report → partial/aborted run: summarize instead of failing.
  const [meta, artifacts] = await Promise.all([readJsonArtifact<RunMeta>(dir, 'meta.json'), listArtifacts(dir)]);
  process.stdout.write(`\n${partialSummary(match.runId, meta, artifacts)}\n\n`);
  return 0;
}
