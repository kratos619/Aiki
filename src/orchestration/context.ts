// Run context + engine primitives (§6). A run is a single-threaded walk through typed stages;
// `RunCtx` carries everything a stage needs and is the ONLY thing that spends the call budget.
//
// Invariants enforced here:
// - Budget guard (§6, §19): a provider call that would exceed the budget throws `BudgetExceeded`
//   BEFORE spawning anything; the run then fails gracefully with partial artifacts + meta.
// - Wall-clock deadline (§19): checked before every call and between stages → `DeadlineExceeded`.
//   A single in-flight call is separately bounded by the adapter's per-call timeout (process-tree
//   kill), so the run cannot hang past deadline + one call timeout. (Mid-call abort is post-v1.)
// - Full audit (§15): every call's exact prompt and raw output are written under `raw/`.

import { randomBytes } from 'node:crypto';
import type { CallRecord, RunMeta } from '../schemas/index.js';
import type { Adapter, FlagProfile, ProviderId, ReadOnlyFlag, RunResultAdapter } from '../providers/types.js';
import { PROVIDER_IDS } from '../providers/types.js';
import { ADAPTERS } from '../providers/adapters.js';
import { extractJson } from '../providers/adapter-core.js';
import { detect } from '../providers/detect.js';
import { probeFlags } from '../providers/probe.js';
import type { RunWriter } from '../storage/runs.js';
import { replayKey } from '../storage/replay.js';

export type WorkflowId = 'idea-refinement' | 'code-review';

/**
 * Optional observation/interaction seam for the TUI (T8). Entirely additive: headless runs pass no
 * `events`, so the engine behaves exactly as without it. `clarify` is the one interactive point —
 * present only in the TUI; when absent, S2 falls back to the majority cluster (headless).
 */
/** The user's answer to an S2 clarification: pick one reading, combine them all, or type their own. */
export type ClarifyChoice =
  | { kind: 'pick'; index: number }
  | { kind: 'both' }
  | { kind: 'text'; text: string };

export interface RunEvents {
  onStart?(runId: string, dir: string): void;
  onStageStart?(id: string): void;
  onStageEnd?(id: string, status: 'done' | 'failed' | 'skipped'): void;
  /** Ask the user to resolve diverging S2 interpretations (pick / combine / type their own). */
  clarify?(question: string, options: string[]): Promise<ClarifyChoice>;
}

/** Declarative timeline row for a workflow's stages (T8). The TUI renders the pending skeleton from
 *  the per-workflow manifest and resolves each row's provider(s) from `RoleMap` via `role`. */
export interface StageInfo {
  id: string; // 'S1'..'S10' — matches the runStage/event ids
  label: string; // human label for the timeline
  role: 'analyst' | 'judge' | 'verifier' | 's4' | 'all' | null; // whose chip(s) show; null = deterministic (—)
}

/** Bracket a stage call with the TUI's start/end events (no-op headless). A thrown StageError marks
 *  the row `failed` and re-propagates unchanged — the engine's failure handling is untouched. */
export async function runStage<T>(ctx: RunCtx, id: string, fn: () => Promise<T>): Promise<T> {
  ctx.events?.onStageStart?.(id);
  try {
    const result = await fn();
    ctx.events?.onStageEnd?.(id, 'done');
    return result;
  } catch (e) {
    ctx.events?.onStageEnd?.(id, 'failed');
    throw e;
  }
}

export const DEFAULT_BUDGET = 12; // §19 said 9, but that never summed: full idea-refinement pipeline is
// S1(1)+S2(3)+S3(1)+S4(2)+S7-grouping(1)+S8(1)+S9(1) = 10 min, 11 with S8's 2nd pass, 11–12 with the
// routine agy-S2 §14 repair. 9 aborts right before the judge. 12 = full run + 1 repair, still a real
// cap (a repair-storm fails gracefully + flagged). Overridable via `--budget` / config (T9). (T7 decision.)
// §19 was 10 min; raised to 20 (user-authorized 2026-07-06). Evidence: a real Opus judge (S9) on a
// 9-dispute idea ran ~360s and the whole run was ~14 min → the 10-min wall-clock aborted a legitimate run.
export const DEFAULT_DEADLINE_MS = 20 * 60 * 1000; // wall-clock cap
// §7.1 was 180s; raised to 300 (user-authorized 2026-07-06). The adapter retries a TIMEOUT once, so 180s
// gave a 360s ceiling and the deep-reasoning judge blew it (observed exactly 360.1s → TIMEOUT). 300s per
// attempt covers the Opus judge; the wall-clock deadline above remains the outer bound.
const DEFAULT_CALL_TIMEOUT_MS = 300_000;

export class BudgetExceeded extends Error {
  constructor(limit: number) {
    super(`call budget exhausted (limit ${limit})`);
    this.name = 'BudgetExceeded';
  }
}

export class DeadlineExceeded extends Error {
  constructor(deadlineMs: number) {
    super(`run wall-clock deadline exceeded (${deadlineMs}ms)`);
    this.name = 'DeadlineExceeded';
  }
}

/** Raised by a stage when a provider call fails unrecoverably (post adapter retry) or output is
 *  unusable after the §14 repair retry. Carries the provider taxonomy code for meta/reporting. */
export class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string, // ProviderError | 'QUORUM' | 'ABORT'
    message: string,
  ) {
    super(`${stage}: ${message}`);
    this.name = 'StageError';
  }
}

/** A ready provider: adapter + resolved flags + how read-only is enforced + detected version. */
export interface ProviderHandle {
  id: ProviderId;
  adapter: Adapter;
  flags: FlagProfile;
  readOnly: ReadOnlyFlag;
  version: string | null;
}

/** Default role assignment for a workflow (§10). `s4` = the fan-out analyst/reviewer seats. */
export interface RoleMap {
  analyst: ProviderId; // S1 intent + S3 prompt-gen (+ one S4 seat)
  judge: ProviderId; // S9 adjudication — must not author an S4 output (§10)
  verifier: ProviderId; // S8 cross-exam
  s4: ProviderId[]; // S4 fan-out seats
}

export interface RunCtxOpts {
  runId: string;
  workflow: WorkflowId;
  handles: ProviderHandle[];
  roles: RoleMap;
  writer: RunWriter;
  cwd: string; // working dir for provider calls (run inputs dir for non-repo workflows)
  budget?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  events?: RunEvents; // TUI observation/interaction seam (T8); absent = headless
  now?: () => number; // injectable clock (tests)
  replay?: Map<string, string>; // resume (V6.3): (provider,prompt)→prior output; matched calls skip the model
}

export class RunCtx {
  readonly runId: string;
  readonly workflow: WorkflowId;
  readonly roles: RoleMap;
  readonly writer: RunWriter;
  readonly cwd: string;
  readonly events?: RunEvents;
  readonly budget: { limit: number; used: number };
  readonly calls: CallRecord[] = [];
  /** §16 report-header flags accumulated by stages (S4 → low_diversity, S7 → low_diversity,
   *  S9 → synthesis_suspect). Folded into meta.json at finalize by `buildMeta`. */
  readonly flags = new Set<NonNullable<RunMeta['flags']>[number]>();

  private readonly handles: Map<ProviderId, ProviderHandle>;
  private readonly signal?: AbortSignal;
  private readonly deadlineMs: number;
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly replay?: Map<string, string>; // resume replay cache (V6.3)
  private seq = 0; // monotonic per-call counter for raw/ filenames (== budget.used on a fresh run)

  constructor(opts: RunCtxOpts) {
    this.runId = opts.runId;
    this.workflow = opts.workflow;
    this.roles = opts.roles;
    this.writer = opts.writer;
    this.cwd = opts.cwd;
    this.events = opts.events;
    this.budget = { limit: opts.budget ?? DEFAULT_BUDGET, used: 0 };
    this.handles = new Map(opts.handles.map((h) => [h.id, h]));
    this.signal = opts.signal;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = opts.now ?? Date.now;
    this.deadlineAt = this.now() + this.deadlineMs;
    this.replay = opts.replay;
  }

  /** Provider ids available this run (READY at setup). */
  available(): ProviderId[] {
    return [...this.handles.keys()];
  }

  /** True once the run's abort signal has fired (Ctrl+C). Lets the finalizer record `aborted:true`
   *  even when the triggering error surfaced as something else (e.g. a killed in-flight call). */
  get aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  handle(id: ProviderId): ProviderHandle {
    const h = this.handles.get(id);
    if (!h) throw new StageError('setup', 'QUORUM', `provider ${id} not available`);
    return h;
  }

  /** Raise a §16 report-header flag; deduped, folded into meta at finalize. */
  addFlag(flag: NonNullable<RunMeta['flags']>[number]): void {
    this.flags.add(flag);
  }

  /** Guard: throw if aborted or past the wall-clock deadline. Called before every provider call. */
  guard(): void {
    if (this.signal?.aborted) throw new StageError('run', 'ABORT', 'aborted');
    if (this.now() > this.deadlineAt) throw new DeadlineExceeded(this.deadlineMs);
  }

  /**
   * Make one budgeted provider call. Decrements budget (throws `BudgetExceeded` if it would go
   * over), records a `CallRecord`, and dumps the exact prompt + raw output under `raw/` (§15).
   */
  async call(
    handle: ProviderHandle,
    req: { prompt: string; expectJson: boolean; timeoutMs?: number; cwd?: string },
    stage: string,
  ): Promise<RunResultAdapter> {
    this.guard();
    const seq = ++this.seq;
    await this.writer.writeRaw(`${stage}-${handle.id}-${seq}.prompt.txt`, req.prompt);

    // Resume (V6.3): if this exact (provider, prompt) already succeeded in the run we're resuming,
    // replay its output — no real call, no budget spend. Only never-completed calls hit the model.
    const cachedOut = this.replay?.get(replayKey(handle.id, req.prompt));
    let res: RunResultAdapter;
    if (cachedOut !== undefined) {
      res = { ok: true, text: cachedOut, json: req.expectJson ? extractJson(cachedOut) : undefined, durationMs: 0 };
    } else {
      if (this.budget.used + 1 > this.budget.limit) throw new BudgetExceeded(this.budget.limit);
      this.budget.used++;
      res = await handle.adapter.run(
        {
          prompt: req.prompt,
          cwd: req.cwd ?? this.cwd,
          timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          expectJson: req.expectJson,
          readOnly: true,
          signal: this.signal, // Ctrl+C kills the in-flight child (T8); undefined headless
        },
        handle.flags,
      );
      // Only REAL calls count toward the ledger/budget; a replayed call is free and already recorded in
      // the run it came from. raw/ below still logs the replayed prompt+output for a full audit.
      this.calls.push({
        provider: handle.id,
        stage,
        durationMs: res.durationMs,
        ...(res.ok ? {} : { error: res.error }),
      });
    }

    await this.writer.writeRaw(
      `${stage}-${handle.id}-${seq}.out`,
      res.ok ? res.text : `[${res.error}]\n${res.stderrTail}`,
    );
    return res;
  }

  /** Assemble the run's `meta.json` payload (§15) from the handles + call ledger accumulated so
   *  far. Called at finalize (success) and in the failure path (partial artifacts stay valid). */
  buildMeta(exitStatus: RunMeta['exit_status'], aborted: boolean, flags?: RunMeta['flags']): RunMeta {
    const provider_versions: Record<string, string> = {};
    const flag_profiles: Record<string, FlagProfile> = {};
    const read_only: Record<string, ReadOnlyFlag> = {};
    for (const h of this.handles.values()) {
      if (h.version) provider_versions[h.id] = h.version;
      flag_profiles[h.id] = h.flags;
      read_only[h.id] = h.readOnly;
    }
    // Roles record: the three singular roles plus one `s4_<n>` entry per fan-out seat (T6).
    const roles: Record<string, ProviderId> = {
      analyst: this.roles.analyst,
      judge: this.roles.judge,
      verifier: this.roles.verifier,
    };
    this.roles.s4.forEach((id, i) => (roles[`s4_${i + 1}`] = id));
    // Fold stage-raised flags in with any explicitly passed by the caller; dedupe.
    const allFlags = [...new Set([...(flags ?? []), ...this.flags])];
    return {
      run_id: this.runId,
      workflow: this.workflow,
      provider_versions,
      flag_profiles,
      roles,
      read_only,
      calls: this.calls,
      call_count: this.calls.length,
      budget: { limit: this.budget.limit, used: this.budget.used },
      exit_status: exitStatus,
      aborted,
      ...(allFlags.length ? { flags: allFlags } : {}),
    };
  }
}

/** Run-fatal errors abort the whole run; everything else (e.g. a single provider failure in a
 *  fan-out) is handled locally by the stage (drop provider, check quorum). */
export function isFatal(e: unknown): boolean {
  return e instanceof BudgetExceeded || e instanceof DeadlineExceeded || (e instanceof StageError && e.code === 'ABORT');
}

// ── Provider setup + role assignment ────────────────────────────────────────

const READONLY_FROM_FLAG = (f: FlagProfile): ReadOnlyFlag => f.readOnlyFlag;

/**
 * Build handles for every provider that is READY (detect + flag probe; no model calls). Providers
 * that aren't installed are simply omitted; quorum (§8) is checked by the caller.
 */
export async function setupProviders(models?: Partial<Record<ProviderId, string>>): Promise<ProviderHandle[]> {
  const handles: ProviderHandle[] = [];
  for (const id of PROVIDER_IDS) {
    const det = await detect(id);
    if (det.status !== 'READY') continue;
    const probed = await probeFlags(id);
    const model = models?.[id]; // V8: user-chosen model → passed to the CLI as `--model <id>`
    const flags = model ? { ...probed, model } : probed;
    handles.push({ id, adapter: ADAPTERS[id], flags, readOnly: READONLY_FROM_FLAG(flags), version: det.version ?? null });
  }
  return handles;
}

/** Preference order used when a role's default provider is unavailable. */
const ANALYST_PREF: ProviderId[] = ['agy', 'codex', 'claude'];
const JUDGE_PREF: ProviderId[] = ['claude', 'agy', 'codex'];
// code-review (§271): reviewers = claude + codex (strongest code-nav, they AUTHOR findings); judge =
// agy (Gemini) so the judge never adjudicates its own finding. Verifier role is unused (S8 = mutual
// cross-exam by the two reviewers).
const CR_REVIEWERS: ProviderId[] = ['claude', 'codex'];
const CR_JUDGE_PREF: ProviderId[] = ['agy', 'claude', 'codex'];

/**
 * Default role assignment (§10, decided at T5) with graceful degradation and an override seam.
 * `overrides` is the config/flag hook (§10 "config can pin roles") — config loading itself is T9.
 *
 * idea-refinement default (3 providers): analyst=agy, judge=claude, verifier=codex, S4=[agy,codex].
 * The one hard rule kept even under degradation: the judge must not be the sole S4 author it would
 * adjudicate — with ≥2 S4 seats and judge picked outside them, that holds. Full §8/§10 fallbacks
 * (2- and 1-provider self-consistency) are firmed at T6 when S4 lands.
 */
export function resolveRoles(
  workflow: WorkflowId,
  available: ProviderId[],
  overrides?: Partial<RoleMap>,
): RoleMap {
  const has = (id: ProviderId) => available.includes(id);
  const pick = (pref: ProviderId[], avoid: ProviderId[] = []): ProviderId => {
    const chosen = pref.find((id) => has(id) && !avoid.includes(id)) ?? pref.find((id) => has(id)) ?? available[0];
    if (!chosen) throw new StageError('setup', 'QUORUM', 'no providers available for role assignment');
    return chosen;
  };

  // code-review (§271): reviewers author findings, judge must not be one of them. Verifier unused.
  if (workflow === 'code-review') {
    const reviewers = CR_REVIEWERS.filter(has);
    const s4 = overrides?.s4 ?? (reviewers.length ? reviewers : available);
    const judge = overrides?.judge ?? pick(CR_JUDGE_PREF, s4); // prefer agy, avoid the reviewers
    return {
      analyst: overrides?.analyst ?? s4[0] ?? judge, // unused in code-review (S1/S3 are deterministic)
      judge,
      verifier: overrides?.verifier ?? judge, // unused (S8 is mutual cross-exam) — kept type-valid
      s4,
    };
  }

  // idea-refinement: S4 seats = the two non-judge providers so the judge stays a non-author (§10).
  const judge = overrides?.judge ?? pick(JUDGE_PREF);
  const analyst = overrides?.analyst ?? pick(ANALYST_PREF);
  const s4 = overrides?.s4 ?? available.filter((id) => id !== judge);
  const verifier = overrides?.verifier ?? (has('codex') ? 'codex' : pick(ANALYST_PREF, [judge]));
  return { analyst, judge, verifier, s4 };
}

/** Generate a run id: `<yyyymmdd>-<hhmm>-<workflow>-<rand4>` (§15). */
export function makeRunId(workflow: WorkflowId, at: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
  return `${stamp}-${workflow}-${randomBytes(2).toString('hex')}`;
}
