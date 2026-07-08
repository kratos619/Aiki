// Bench harness (§17, T11). Runs the four arms on a versioned task set, scores each against the case's
// seeded bugs, and writes bench/results/<suite>-<date>.json. Cases + arms run SEQUENTIALLY and results
// are written INCREMENTALLY after each case, so a mid-run quota stop keeps completed work (grill 2026-07-04).
// The bench itself is metered — verified by a scripted-adapter e2e; the real 4-arm run is the user's.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRunId, resolveRoles, RunCtx, setupProviders, type ProviderHandle, type RoleMap } from '../orchestration/context.js';
import { executeRun } from '../orchestration/engine.js';
import { RunWriter } from '../storage/runs.js';
import type { Finding } from '../schemas/index.js';
import type { ProviderId } from '../providers/types.js';
import { ARMS, ARM_IDS, type ArmId } from './arms.js';
import { BugManifest, scoreRun, type SeededBug } from './scoring/seeded-bugs.js';
import { BenchResult, summarize, type ArmScore, type CaseResult } from './results.js';

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

/** A/B/C need claude (the fixed single model); D needs claude+codex reviewers; E needs agy+codex
 *  reviewers + claude judge (the Opus-thrift variant). */
function armAvailable(arm: ArmId, available: string[]): boolean {
  if (arm === 'D') return available.includes('claude') && available.includes('codex');
  if (arm === 'E') return available.includes('agy') && available.includes('codex') && available.includes('claude');
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
  // Arm C's synthesis judge stays same-model; Arm E swaps the product pipeline's roles to the
  // Opus-thrift config (agy+codex hunt, claude judge). D uses code-review defaults.
  const overrides: Partial<RoleMap> | undefined =
    arm === 'C' ? { judge: 'claude' }
    : arm === 'E' ? { s4: ['agy', 'codex'], judge: 'claude' }
    : undefined;
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
  // A scored outcome can still hide a mid-run provider failure: fault-tolerant arms (D) finish on the
  // surviving providers when a reviewer crashes (e.g. Opus quota mid-run), so the result is NOT the
  // registered pipeline. Don't score it as clean — mark it error so a `--resume` run retries it.
  const failed = ctx.calls.filter((call) => call.error);
  if (failed.length > 0) {
    const detail = failed.map((call) => `${call.provider}@${call.stage}=${call.error}`).join(', ');
    return { arm, status: 'error', runId, reason: `DEGRADED: provider call failed mid-run (${detail})`, calls: ctx.calls.length, wallMs };
  }
  // Persist the exact findings the scorer saw — single-call arms (A/B) have no review-map artifact,
  // so this is what `aiki resolve` annotates for FP labels (precision's denominator = this list).
  await ctx.writer.writeRaw('bench-findings.json', JSON.stringify(findings, null, 2));
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
  resume?: boolean; // continue the latest matching results file: keep scored case×arm pairs, retry the rest
  handles?: ProviderHandle[]; // injectable (tests); default = setupProviders()
}

/** Approx claude/Opus calls each arm makes per case — for the pre-run quota estimate (§19). Not exact:
 *  §14 JSON repairs can add a few, and D's cross-exam/judge vary; deliberately a round upper-ish figure. */
export const CLAUDE_CALLS_PER_CASE: Record<ArmId, number> = { A: 1, B: 1, C: 4, D: 2, E: 1 };

/** ≈ claude/Opus calls for a list of case×arm pairs (the quota-sensitive cost the user cares about). */
export function estimateClaudeCalls(pairs: { arm: ArmId }[]): number {
  return pairs.reduce((n, p) => n + (CLAUDE_CALLS_PER_CASE[p.arm] ?? 0), 0);
}

/** Resume target: continue the most-recent results file for this suite/set (so a run can be spread across
 *  Opus windows, even across midnight); otherwise a fresh dated file. */
async function resolveCampaign(resultsDir: string, suite: string, set: string, resume: boolean): Promise<{ path: string; prior?: BenchResult }> {
  const dated = join(resultsDir, `${suite}-${new Date().toISOString().slice(0, 10)}.json`);
  if (!resume) return { path: dated };
  // Only real `<suite>-YYYY-MM-DD.json` campaign files — so an archived/renamed run (e.g.
  // `<suite>-2026-07-04.void.json`) is ignored and won't be resumed by accident.
  const campaign = new RegExp(`^${suite}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
  let names: string[] = [];
  try {
    names = (await readdir(resultsDir)).filter((f) => campaign.test(f));
  } catch {
    return { path: dated };
  }
  names.sort(); // ISO date in the name → lexical order is chronological
  for (const name of names.reverse()) {
    try {
      const parsed = BenchResult.safeParse(JSON.parse(await readFile(join(resultsDir, name), 'utf8')));
      if (parsed.success && parsed.data.suite === suite && parsed.data.set === set) {
        return { path: join(resultsDir, name), prior: parsed.data };
      }
    } catch {
      /* skip an unparseable/partial file, try the next-most-recent */
    }
  }
  return { path: dated };
}

/** Map of `case::arm` → the prior ArmScore for pairs already `scored` (resume reuses these; error/skipped are retried). */
function priorScored(prior: BenchResult | undefined): Map<string, ArmScore> {
  const done = new Map<string, ArmScore>();
  for (const pc of prior?.cases ?? []) {
    for (const a of pc.arms) if (a.status === 'scored') done.set(`${pc.case}::${a.arm}`, a);
  }
  return done;
}

export interface BenchPlan {
  suite: string;
  set: string;
  arms: ArmId[];
  cases: string[]; // every case name in the set
  toRun: { case: string; arm: ArmId }[]; // pairs that will actually execute (drives the estimate)
  skipCompleted: number; // pairs kept from a prior run (resume)
  skipUnavailable: number; // pairs skipped because required provider(s) are absent
  estClaudeCalls: number; // ≈ Opus calls for toRun
  resultsPath: string;
  resumedFrom?: string; // set when a prior matching results file was found and will be continued
}

/** Dry-run: resolve what a `runBench` with these options would execute + its ≈Opus cost. No model calls. */
export async function planBench(opts: BenchOptions = {}): Promise<BenchPlan> {
  const suite = opts.suite ?? 'code-review';
  const set = opts.set ?? 'build';
  const arms = opts.arms ?? [...ARM_IDS];
  const root = opts.root ?? process.cwd();
  const handles = opts.handles ?? (await setupProviders());
  const available = handles.map((h) => h.id);

  const cases = await loadCases(suite, set, root);
  const resultsDir = join(root, 'bench', 'results');
  const { path, prior } = await resolveCampaign(resultsDir, suite, set, !!opts.resume);
  const done = priorScored(prior);

  const toRun: { case: string; arm: ArmId }[] = [];
  let skipCompleted = 0;
  let skipUnavailable = 0;
  for (const c of cases) {
    for (const arm of arms) {
      if (opts.resume && done.has(`${c.name}::${arm}`)) skipCompleted++;
      else if (!armAvailable(arm, available)) skipUnavailable++;
      else toRun.push({ case: c.name, arm });
    }
  }
  return {
    suite,
    set,
    arms,
    cases: cases.map((c) => c.name),
    toRun,
    skipCompleted,
    skipUnavailable,
    estClaudeCalls: estimateClaudeCalls(toRun),
    resultsPath: path,
    resumedFrom: prior ? path : undefined,
  };
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const suite = opts.suite ?? 'code-review';
  const set = opts.set ?? 'build';
  const arms = opts.arms ?? [...ARM_IDS];
  const root = opts.root ?? process.cwd();
  const handles = opts.handles ?? (await setupProviders());
  const available = handles.map((h) => h.id);

  const cases = await loadCases(suite, set, root);
  const resultsDir = join(root, 'bench', 'results');
  await mkdir(resultsDir, { recursive: true });
  const { path, prior } = await resolveCampaign(resultsDir, suite, set, !!opts.resume);
  const done = opts.resume ? priorScored(prior) : new Map<string, ArmScore>();

  const result: BenchResult = { suite, set, at: new Date().toISOString(), arms, cases: [], summary: [] };
  for (const c of cases) {
    const caseResult: CaseResult = { case: c.name, seeded: c.bugs.length, arms: [] };
    for (const arm of arms) {
      const kept = done.get(`${c.name}::${arm}`);
      if (kept) {
        caseResult.arms.push(kept); // resume: keep already-scored work across quota windows
        continue;
      }
      if (!armAvailable(arm, available)) {
        caseResult.arms.push({ arm, status: 'skipped', reason: `required provider(s) unavailable` });
        continue;
      }
      caseResult.arms.push(await runArmOnCase(arm, c, handles, available, root));
    }
    // Carry forward prior scored pairs for arms NOT requested this run — else a narrower `--arms`
    // re-run (e.g. C-only after B,D) would rewrite the campaign file without the paid-for B/D data.
    const priorCase = prior?.cases.find((pc) => pc.case === c.name);
    for (const a of priorCase?.arms ?? []) {
      if (a.status === 'scored' && !arms.includes(a.arm)) caseResult.arms.push(a);
    }
    result.cases.push(caseResult);
    result.summary = summarize(result.cases, arms);
    // Survive a mid-run stop: write processed cases + the prior file's not-yet-reprocessed cases
    // (a kill mid-loop must not drop prior scored data for later cases from the campaign file).
    const processed = new Set(result.cases.map((x) => x.case));
    const pending = (prior?.cases ?? []).filter((pc) => !processed.has(pc.case));
    await writeIncremental(path, { ...result, cases: [...result.cases, ...pending] });
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
