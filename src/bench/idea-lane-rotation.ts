import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import type { ProviderId } from '../providers/types.js';
import { makeRunId, resolveRoles, RunCtx, setupProviders, type ProviderHandle } from '../orchestration/context.js';
import { executeRun } from '../orchestration/engine.js';
import { DecisionGraph } from '../schemas/index.js';
import { RunWriter } from '../storage/runs.js';
import { runIdeaRefinement } from '../workflows/idea-refinement.js';
import { DecisionInsightAdjudication, IdeaV3CaseManifest, scoreDecisionInsights } from './scoring/decision-insights.js';

export type LaneRotation = 'agy-market' | 'codex-market';

const ROTATIONS: Array<{ rotation: LaneRotation; s4: [ProviderId, ProviderId] }> = [
  { rotation: 'agy-market', s4: ['agy', 'codex'] },
  { rotation: 'codex-market', s4: ['codex', 'agy'] },
];

export interface IdeaLaneBenchPlan {
  cases: string[];
  runs: Array<{ case: string; rotation: LaneRotation; s4: [ProviderId, ProviderId] }>;
  estimatedCalls: number;
  resumedFrom?: string; // set when a prior campaign file was found and its pairs are kept
}

export const LaneRotationObservation = z.object({
  case_id: z.string().min(1),
  rotation: z.enum(['agy-market', 'codex-market']),
  run_id: z.string().min(1),
  decision_critical_recall: z.number().min(0).max(1).nullable(),
  evidence_precision: z.number().min(0).max(1).nullable(),
  json_repair_rate: z.number().min(0).max(1),
  latency_ms: z.number().nonnegative(),
  unique_supported_contributions: z.object({
    agy: z.number().int().nonnegative(),
    codex: z.number().int().nonnegative(),
  }),
});
export type LaneRotationObservation = z.infer<typeof LaneRotationObservation>;

const LaneRotationResult = z.object({
  at: z.string().min(1),
  observations: z.array(LaneRotationObservation),
});

export interface LaneRunTarget {
  case_id: string;
  input: string;
  rotation: LaneRotation;
  s4: [ProviderId, ProviderId];
}

type LaneExecutor = (target: LaneRunTarget) => Promise<LaneRotationObservation>;

async function loadBuildCases(root: string): Promise<Array<{ id: string; input: string }>> {
  const dir = join(root, 'bench', 'sets', 'idea-refinement', 'build');
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map(async (name) => {
    const manifest = IdeaV3CaseManifest.parse(JSON.parse(await readFile(join(dir, name, 'case.json'), 'utf8')));
    return { id: manifest.id, input: await readFile(join(dir, name, manifest.input_file), 'utf8') };
  }));
}

// Only real `idea-lanes-YYYY-MM-DD.json` campaign files — an archived/renamed run is never resumed by accident.
const LANE_CAMPAIGN = /^idea-lanes-\d{4}-\d{2}-\d{2}\.json$/;

/** Latest dated campaign file under <root>/bench/results, or null when none exists. */
export async function findLatestLaneResults(root: string): Promise<string | null> {
  const dir = join(root, 'bench', 'results');
  try {
    const latest = (await readdir(dir)).filter((name) => LANE_CAMPAIGN.test(name)).sort().pop();
    return latest ? join(dir, latest) : null;
  } catch {
    return null;
  }
}

async function loadPriorObservations(path: string): Promise<LaneRotationObservation[]> {
  try {
    return LaneRotationResult.parse(JSON.parse(await readFile(path, 'utf8'))).observations;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error; // a corrupt checkpoint fails loud — silently starting fresh would re-pay the whole matrix
  }
}

async function resolveResume(root: string, opts: { resultsPath?: string; resume?: boolean }): Promise<{ path: string | null; prior: LaneRotationObservation[] }> {
  const path = opts.resultsPath ?? (opts.resume ? await findLatestLaneResults(root) : null);
  return { path, prior: opts.resume && path ? await loadPriorObservations(path) : [] };
}

/** Narrow to one named build case (metered single-case runs); an unknown id fails loud, never runs 0 pairs. */
function filterCases<T extends { id: string }>(cases: T[], caseId?: string): T[] {
  if (!caseId) return cases;
  const picked = cases.filter((item) => item.id === caseId);
  if (picked.length === 0) throw new Error(`unknown case "${caseId}" — build cases: ${cases.map((item) => item.id).join(', ')}`);
  return picked;
}

/** A rotation sample is valid only when both scout seats actually produced output. A `low_diversity` run
 *  (a seat died; the survivor was resampled) would silently poison the lane comparison if recorded. */
export function assertLaneRunDiversity(flags: readonly string[] | undefined, label: string): void {
  if (flags?.includes('low_diversity')) {
    throw new Error(`${label}: run completed low_diversity (a scout seat died) — not a valid rotation sample; re-run when both providers are healthy`);
  }
}

export async function planIdeaLaneBench(opts: { root?: string; handles?: ProviderHandle[]; resultsPath?: string; resume?: boolean; caseId?: string } = {}): Promise<IdeaLaneBenchPlan> {
  const root = opts.root ?? process.cwd();
  const handles = opts.handles ?? await setupProviders();
  const available = new Set(handles.map((handle) => handle.id));
  const cases = filterCases(await loadBuildCases(root), opts.caseId);
  const { path, prior } = await resolveResume(root, opts);
  const done = new Set(prior.map((item) => `${item.case_id}:${item.rotation}`));
  const runnable = ROTATIONS.filter(({ s4 }) => available.has('claude') && s4.every((provider) => available.has(provider)));
  const runs = cases.flatMap((item) => runnable.map(({ rotation, s4 }) => ({ case: item.id, rotation, s4 })))
    .filter((run) => !done.has(`${run.case}:${run.rotation}`));
  return {
    cases: cases.map((item) => item.id),
    runs,
    estimatedCalls: runs.length * 13,
    resumedFrom: prior.length ? path ?? undefined : undefined,
  };
}

async function executeLaneRun(target: LaneRunTarget, handles: ProviderHandle[], root: string): Promise<LaneRotationObservation> {
  const ids = handles.map((handle) => handle.id);
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', ids, { judge: 'claude', s4: target.s4 });
  const writer = new RunWriter(runId, join(root, '.aiki'));
  // Bench runs are the deep path: hard cases legitimately run ~18 min and the 20-min default leaves no
  // headroom (per-call timeout now bounds any single hang). 45 min so a healthy deep run is never
  // killed by headroom; the per-call timeout is still the real safety bound.
  const ctx = new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, deadlineMs: 45 * 60 * 1000 });
  const started = Date.now();
  const outcome = await executeRun(ctx, target.input, runIdeaRefinement);
  if (!outcome.ok) throw new Error(`${target.case_id}/${target.rotation} failed: ${outcome.error?.code}: ${outcome.error?.message}`);
  const meta = JSON.parse(await readFile(join(outcome.dir, 'meta.json'), 'utf8')) as { flags?: string[] };
  assertLaneRunDiversity(meta.flags, `${target.case_id}/${target.rotation}`);
  const graph = DecisionGraph.parse(JSON.parse(await readFile(join(outcome.dir, '07-decision-graph.json'), 'utf8')));
  const positions = new Map(graph.positions.map((position) => [position.id, position]));
  const unique = { agy: 0, codex: 0 };
  for (const claim of graph.claims.filter((item) => item.state === 'UNIQUE' && item.evidence_state === 'SUPPORTED')) {
    const provider = positions.get(claim.position_ids[0]!)?.provider;
    if (provider === 'agy' || provider === 'codex') unique[provider]++;
  }
  return LaneRotationObservation.parse({
    case_id: target.case_id,
    rotation: target.rotation,
    run_id: outcome.runId,
    decision_critical_recall: null,
    evidence_precision: null,
    json_repair_rate: ctx.calls.length ? ctx.calls.filter((call) => call.stage.endsWith('-repair')).length / ctx.calls.length : 0,
    latency_ms: Date.now() - started,
    unique_supported_contributions: unique,
  });
}

export async function runIdeaLaneBench(opts: {
  root?: string;
  handles?: ProviderHandle[];
  resultsPath?: string;
  execute?: LaneExecutor;
  resume?: boolean;
  caseId?: string;
} = {}): Promise<{ path: string; observations: LaneRotationObservation[] }> {
  const root = opts.root ?? process.cwd();
  const handles = opts.handles ?? await setupProviders();
  const available = new Set(handles.map((handle) => handle.id));
  const cases = filterCases(await loadBuildCases(root), opts.caseId);
  const targets = cases.flatMap((item) => ROTATIONS
    .filter(({ s4 }) => available.has('claude') && s4.every((provider) => available.has(provider)))
    .map(({ rotation, s4 }) => ({ case_id: item.id, input: item.input, rotation, s4 })));
  const resumed = await resolveResume(root, opts);
  const path = resumed.path ?? join(root, 'bench', 'results', `idea-lanes-${new Date().toISOString().slice(0, 10)}.json`);
  const done = new Set(resumed.prior.map((item) => `${item.case_id}:${item.rotation}`));
  const execute = opts.execute ?? ((target: LaneRunTarget) => executeLaneRun(target, handles, root));
  const observations: LaneRotationObservation[] = [...resumed.prior];
  await mkdir(dirname(path), { recursive: true });
  for (const target of targets) {
    if (done.has(`${target.case_id}:${target.rotation}`)) continue; // already paid for — keep, don't re-run
    observations.push(LaneRotationObservation.parse(await execute(target)));
    const result = LaneRotationResult.parse({ at: new Date().toISOString(), observations });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await rename(tmp, path);
  }
  return { path, observations };
}

/** One human-authored adjudication entry: which pair it scores + the frozen R0 scorer's exact input. */
const LaneAdjudicationEntry = z
  .object({
    case_id: z.string().min(1),
    rotation: z.enum(['agy-market', 'codex-market']),
    adjudication: DecisionInsightAdjudication,
  })
  .strict();
const LaneAdjudicationFile = z.array(LaneAdjudicationEntry).min(1);

/** Import blind adjudications into a campaign file: each entry flows through the frozen R0 scorer and
 *  fills that pair's null recall/precision. One pass by design — an already-scored pair is refused, and
 *  an unknown pair fails loud rather than silently dropping a rater's work. */
export async function importLaneAdjudications(opts: {
  root?: string;
  resultsPath?: string;
  importPath: string;
}): Promise<{ path: string; scored: LaneRotationObservation[]; observations: LaneRotationObservation[] }> {
  const root = opts.root ?? process.cwd();
  const path = opts.resultsPath ?? await findLatestLaneResults(root);
  if (!path) throw new Error('no idea-lanes campaign file under bench/results/ — run the bench first');
  const prior = LaneRotationResult.parse(JSON.parse(await readFile(path, 'utf8')));
  const entries = LaneAdjudicationFile.parse(JSON.parse(await readFile(opts.importPath, 'utf8')));
  const byPair = new Map(prior.observations.map((item) => [`${item.case_id}:${item.rotation}`, item]));
  const scored: LaneRotationObservation[] = [];
  for (const entry of entries) {
    const key = `${entry.case_id}:${entry.rotation}`;
    const observation = byPair.get(key);
    if (!observation) throw new Error(`no observation for ${key} in ${path} — run that pair first`);
    if (observation.decision_critical_recall !== null || observation.evidence_precision !== null) {
      throw new Error(`${key} is already scored — blind adjudication is one pass (BENCHMARK-IDEA-V3.md)`);
    }
    const updated = scoreLaneObservation(observation, entry.adjudication);
    byPair.set(key, updated);
    scored.push(updated);
  }
  const observations = prior.observations.map((item) => byPair.get(`${item.case_id}:${item.rotation}`)!);
  const result = LaneRotationResult.parse({ at: new Date().toISOString(), observations });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
  await rename(tmp, path);
  return { path, scored, observations };
}

/** Pick only from fully adjudicated build observations; exact ties leave the default unfrozen. */
export function chooseLaneDefault(input: LaneRotationObservation[]): LaneRotation | null {
  const observations = z.array(LaneRotationObservation).parse(input);
  if (observations.length === 0 || observations.some((item) => item.decision_critical_recall === null || item.evidence_precision === null)) return null;
  const cases = new Set(observations.map((item) => item.case_id));
  const pairs = new Set(observations.map((item) => `${item.case_id}:${item.rotation}`));
  if (pairs.size !== cases.size * ROTATIONS.length || observations.length !== pairs.size) return null;
  const average = (items: LaneRotationObservation[], key: 'decision_critical_recall' | 'evidence_precision' | 'json_repair_rate' | 'latency_ms') =>
    items.reduce((sum, item) => sum + (item[key] ?? 0), 0) / items.length;
  const scores = ROTATIONS.map(({ rotation }) => {
    const items = observations.filter((item) => item.rotation === rotation);
    return {
      rotation,
      recall: average(items, 'decision_critical_recall'),
      evidence: average(items, 'evidence_precision'),
      unique: items.reduce((sum, item) => sum + item.unique_supported_contributions.agy + item.unique_supported_contributions.codex, 0) / items.length,
      repairs: average(items, 'json_repair_rate'),
      latency: average(items, 'latency_ms'),
    };
  });
  scores.sort((a, b) => b.recall - a.recall || b.evidence - a.evidence || b.unique - a.unique || a.repairs - b.repairs || a.latency - b.latency);
  const [best, other] = scores;
  if (!best || !other) return null;
  return best.recall === other.recall && best.evidence === other.evidence && best.unique === other.unique
    && best.repairs === other.repairs && best.latency === other.latency ? null : best.rotation;
}

export function scoreLaneObservation(
  observation: LaneRotationObservation,
  adjudication: DecisionInsightAdjudication,
): LaneRotationObservation {
  const score = scoreDecisionInsights(adjudication);
  return LaneRotationObservation.parse({
    ...observation,
    decision_critical_recall: score.recall,
    evidence_precision: score.precision,
  });
}
