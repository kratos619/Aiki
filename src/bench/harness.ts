// Bench harness (§17, T11). Runs the four arms on a versioned task set, scores each against the case's
// seeded bugs, and writes bench/results/<suite>-<date>.json. Cases + arms run SEQUENTIALLY and results
// are written INCREMENTALLY after each case, so a mid-run quota stop keeps completed work (grill 2026-07-04).
// The bench itself is metered — verified by a scripted-adapter e2e; the real 4-arm run is the user's.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRunId, resolveRoles, RunCtx, setupProviders, type ProviderHandle } from '../orchestration/context.js';
import { executeRun } from '../orchestration/engine.js';
import { RunWriter } from '../storage/runs.js';
import type { Finding } from '../schemas/index.js';
import type { ProviderId } from '../providers/types.js';
import { ARMS, type ArmId } from './arms.js';
import { BugManifest, scoreRun, type SeededBug } from './scoring/seeded-bugs.js';
import { summarize, type ArmScore, type BenchResult, type CaseResult } from './results.js';

interface BenchCase {
  name: string;
  dir: string; // absolute — the reviewer's cwd (source files live here so file:line resolves)
  diff: string;
  bugs: SeededBug[];
}

/** Load every case dir under bench/sets/<suite>/<set>/ (each = {diff.patch, bugs.json, source files}). */
export async function loadCases(suite: string, set: string, root = process.cwd()): Promise<BenchCase[]> {
  const base = join(root, 'bench', 'sets', suite, set);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const cases: BenchCase[] = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(base, e.name);
    const diff = await readFile(join(dir, 'diff.patch'), 'utf8');
    const bugs = BugManifest.parse(JSON.parse(await readFile(join(dir, 'bugs.json'), 'utf8'))).bugs;
    cases.push({ name: e.name, dir, diff, bugs });
  }
  return cases;
}

/** A/B/C need claude (the fixed single model); D needs the two reviewers. */
function armAvailable(arm: ArmId, available: string[]): boolean {
  if (arm === 'D') return available.includes('claude') && available.includes('codex');
  return available.includes('claude');
}

/** Precision from FP labels in feedback.jsonl for this run, or null if the run hasn't been adjudicated. */
async function readPrecision(runId: string, reported: number, root = process.cwd()): Promise<number | null> {
  if (reported === 0) return null;
  try {
    const lines = (await readFile(join(root, '.aiki', 'feedback.jsonl'), 'utf8')).trim().split('\n');
    const forRun = lines.map((l) => JSON.parse(l)).filter((e) => e.run_id === runId && e.item_type === 'finding');
    if (forRun.length === 0) return null;
    const fp = forRun.filter((e) => e.verdict === 'false-positive').length;
    return (reported - fp) / reported;
  } catch {
    return null;
  }
}

async function runArmOnCase(arm: ArmId, c: BenchCase, handles: ProviderHandle[], available: ProviderId[], root: string): Promise<ArmScore> {
  const runId = makeRunId('code-review');
  const overrides = arm === 'C' ? ({ judge: 'claude' } as const) : undefined; // Arm C's synthesis judge stays same-model
  const roles = resolveRoles('code-review', available, overrides);
  const ctx = new RunCtx({ runId, workflow: 'code-review', handles, roles, writer: new RunWriter(runId, join(root, '.aiki')), cwd: c.dir });

  const started = Date.now();
  let findings: Finding[] = [];
  const outcome = await executeRun(ctx, c.diff, async (cx, input) => {
    findings = await ARMS[arm](cx, input);
  });
  const wallMs = Date.now() - started;

  if (!outcome.ok) {
    return { arm, status: 'error', runId, reason: `${outcome.error?.code}: ${outcome.error?.message}`, calls: ctx.calls.length, wallMs };
  }
  const s = scoreRun(findings, c.bugs);
  return {
    arm,
    status: 'scored',
    runId,
    seeded: s.seeded,
    matched: s.matched,
    recall: s.recall,
    reported: s.reported,
    unmatched: s.unmatched,
    precision: await readPrecision(runId, s.reported, root),
    calls: ctx.calls.length,
    wallMs,
  };
}

export interface BenchOptions {
  suite?: string; // 'code-review'
  set?: string; // 'build' | 'holdout'
  arms?: ArmId[];
  root?: string;
  handles?: ProviderHandle[]; // injectable (tests); default = setupProviders()
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const suite = opts.suite ?? 'code-review';
  const set = opts.set ?? 'build';
  const arms = opts.arms ?? (['A', 'B', 'C', 'D'] as ArmId[]);
  const root = opts.root ?? process.cwd();
  const handles = opts.handles ?? (await setupProviders());
  const available = handles.map((h) => h.id);

  const cases = await loadCases(suite, set, root);
  const resultsDir = join(root, 'bench', 'results');
  await mkdir(resultsDir, { recursive: true });
  const path = join(resultsDir, `${suite}-${new Date().toISOString().slice(0, 10)}.json`);

  const result: BenchResult = { suite, set, at: new Date().toISOString(), arms, cases: [], summary: [] };
  for (const c of cases) {
    const caseResult: CaseResult = { case: c.name, seeded: c.bugs.length, arms: [] };
    for (const arm of arms) {
      if (!armAvailable(arm, available)) {
        caseResult.arms.push({ arm, status: 'skipped', reason: `required provider(s) unavailable` });
        continue;
      }
      caseResult.arms.push(await runArmOnCase(arm, c, handles, available, root));
    }
    result.cases.push(caseResult);
    result.summary = summarize(result.cases, arms);
    await writeIncremental(path, result); // survive a mid-run quota stop
  }
  return result;
}

/** Atomic incremental write (temp + rename). */
async function writeIncremental(path: string, result: BenchResult): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Render the per-arm summary table (recall micro/macro, precision, calls, wall-clock). */
export function renderTable(result: BenchResult): string {
  const L: string[] = [];
  L.push(`bench ${result.suite} — set ${result.set} — ${result.cases.length} case(s)`);
  L.push('');
  L.push('| Arm | Recall (micro) | Recall (macro) | Matched/Seeded | Reported | Unmatched(FP?) | Precision | Calls | Wall(s) |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of result.summary) {
    const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
    const prec = r.precision === null ? '—' : pct(r.precision);
    L.push(`| ${r.arm} | ${pct(r.recall)} | ${pct(r.recallMacro)} | ${r.matched}/${r.seeded} | ${r.reported} | ${r.unmatched} | ${prec} | ${r.calls} | ${(r.wallMs / 1000).toFixed(1)} |`);
  }
  L.push('');
  L.push('Precision "—" = not yet adjudicated (label false positives with `aiki resolve <run>`).');
  return L.join('\n');
}
