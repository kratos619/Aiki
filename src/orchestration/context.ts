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
import type { CallRecord, GrillAnswer, IdeaMode, RunBriefDraft, RunMeta, UrlSourceSet } from '../schemas/index.js';
import type { Adapter, FlagProfile, NormalizedUsage, ProviderId, ReadOnlyFlag, RunResultAdapter } from '../providers/types.js';
import { PROVIDER_IDS } from '../providers/types.js';
import { ADAPTERS } from '../providers/adapters.js';
import { extractJson } from '../providers/adapter-core.js';
import { detect } from '../providers/detect.js';
import { probeFlags } from '../providers/probe.js';
import type { RunWriter } from '../storage/runs.js';
import { replayKey } from '../storage/replay.js';
import type { EvidencePack } from './evidence-pack.js';
import { callCategory, defaultBudgetFor, defaultDeadlineFor, IDEA_MODE_PLANS, isOptionalStage, LEGACY_DEFAULT_BUDGET, type CallCategory } from './modes.js';

export type WorkflowId = 'idea-refinement' | 'code-review';

/**
 * Optional observation/interaction seam for the TUI (T8). Entirely additive: headless runs pass no
 * `events`, so the engine does not block on user input. `grill` and `clarify` are the interactive
 * preflight points; when absent, the contract records headless defaults and the majority reading.
 */
/** The user's answer to a preflight clarification: pick one reading, combine them, or type their own. */
export type ClarifyChoice =
  | { kind: 'pick'; index: number }
  | { kind: 'both' }
  | { kind: 'text'; text: string };

export interface RunEvents {
  onStart?(runId: string, dir: string): void;
  onStageStart?(id: string): void;
  onStageEnd?(id: string, status: 'done' | 'failed' | 'skipped'): void;
  /** Fired around every budgeted provider call (serve deck telemetry). Additive: headless/TUI runs
   *  pass neither, so nothing changes for them. `replayed` calls are free resume-cache hits. */
  onCallStart?(provider: ProviderId, stage: string, category: CallCategory, replayed: boolean): void;
  onCallEnd?(provider: ProviderId, stage: string, ms: number, ok: boolean, replayed: boolean): void;
  /** Ask the user to answer the merged contextual questions before the expensive stages run. */
  grill?(brief: RunBriefDraft): Promise<GrillAnswer[]>;
  /** Ask the user to resolve diverging preflight interpretations. */
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

/** Legacy/code-review fallback. Idea-refinement defaults are adaptive by explicit mode (R6). */
export const DEFAULT_BUDGET = LEGACY_DEFAULT_BUDGET;
// §19 was 10 min; raised to 20 (user-authorized 2026-07-06). Evidence: a real Opus judge (S9) on a
// 9-dispute idea ran ~360s and the whole run was ~14 min → the 10-min wall-clock aborted a legitimate run.
export const DEFAULT_DEADLINE_MS = 20 * 60 * 1000; // wall-clock cap
// §7.1 was 180s; raised to 300 (user-authorized 2026-07-06) for the deep-reasoning judge; raised to 900
// (2026-07-13) after the spawn timeout became actually enforced and killed a LEGITIMATE deep call: codex's
// S4 analysis of a hard build case ran ~10 min to a valid output (run 20260713-1341, 13:44→13:54). 900s
// per attempt covers observed deep work; the wall-clock deadline above remains the outer bound.
export const DEFAULT_CALL_TIMEOUT_MS = 900_000;

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
  analyst: ProviderId; // retained for config/backward compatibility; preflight uses two scout readings
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
  mode?: IdeaMode; // idea-refinement only; default council
  budget?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  events?: RunEvents; // TUI observation/interaction seam (T8); absent = headless
  now?: () => number; // injectable clock (tests)
  replay?: Map<string, string>; // resume (V6.3): (provider,prompt)→prior output; matched calls skip the model
  evidencePack?: EvidencePack; // R4: user-scoped local paths + hashes; contents are not copied
  allowBlockedSources?: boolean; // v6 T10: proceed past an unreadable supplied URL (default: stop and ask)
  urlSources?: UrlSourceSet; // v6 T10b: snapshot already taken (and user-approved) by the CLI — don't refetch
  autoDecision?: RunMeta['auto_decision']; // v7 Phase B: set by the CLI when `--mode auto` resolved the mode
}

export class RunCtx {
  readonly runId: string;
  readonly workflow: WorkflowId;
  readonly mode: IdeaMode;
  readonly roles: RoleMap;
  readonly writer: RunWriter;
  readonly cwd: string;
  readonly events?: RunEvents;
  readonly evidencePack?: EvidencePack;
  readonly allowBlockedSources?: boolean;
  readonly urlSources?: UrlSourceSet;
  readonly isAuto: boolean;
  readonly budget: { limit: number; used: number };
  readonly calls: CallRecord[] = [];
  /** Logical provider-call stages, including resume cache hits. Used by bounded protocol caps. */
  readonly attemptedStages: string[] = [];
  /** §16 report-header flags accumulated by stages (S4 → low_diversity, S7 → low_diversity,
   *  S9 → synthesis_suspect). Folded into meta.json at finalize by `buildMeta`. */
  readonly flags = new Set<NonNullable<RunMeta['flags']>[number]>();

  private readonly handles: Map<ProviderId, ProviderHandle>;
  private readonly signal?: AbortSignal;
  private readonly deadlineMs: number;
  private readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly replay?: Map<string, string>; // resume replay cache (V6.3)
  private autoDecision?: RunMeta['auto_decision']; // v7 Phase B/D: routing record + output escalation receipt
  private fastPathActive: boolean;
  private seq = 0; // monotonic per-call counter for raw/ filenames (== budget.used on a fresh run)

  constructor(opts: RunCtxOpts) {
    this.runId = opts.runId;
    this.workflow = opts.workflow;
    this.mode = opts.mode ?? 'council';
    this.roles = opts.roles;
    this.writer = opts.writer;
    this.cwd = opts.cwd;
    this.events = opts.events;
    this.evidencePack = opts.evidencePack;
    this.allowBlockedSources = opts.allowBlockedSources;
    this.urlSources = opts.urlSources;
    this.isAuto = opts.autoDecision !== undefined;
    this.fastPathActive = this.mode === 'quick'
      && opts.autoDecision?.resolved === 'quick'
      && opts.autoDecision.fast_path === true;
    this.budget = { limit: opts.budget ?? defaultBudgetFor(opts.workflow, this.mode), used: 0 };
    this.handles = new Map(opts.handles.map((h) => [h.id, h]));
    this.signal = opts.signal;
    this.deadlineMs = opts.deadlineMs ?? defaultDeadlineFor(opts.workflow, this.mode);
    this.now = opts.now ?? Date.now;
    this.deadlineAt = this.now() + this.deadlineMs;
    this.replay = opts.replay;
    this.autoDecision = opts.autoDecision ? { ...opts.autoDecision } : undefined;
  }

  get fastPath(): boolean {
    return this.fastPathActive;
  }

  get autoEscalationReasons(): string[] {
    return this.autoDecision?.escalation_reasons ?? [];
  }

  /** Phase D: retain initial fast-path eligibility in meta, but stop rendering it as single-pass. */
  markAutoEscalated(reasons: string[]): void {
    if (!this.autoDecision || reasons.length === 0) return;
    this.fastPathActive = false;
    this.autoDecision = {
      ...this.autoDecision,
      escalation_reasons: [...new Set([...(this.autoDecision.escalation_reasons ?? []), ...reasons])],
    };
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

  /** Calls optional stages may still spend after preserving this mode's required tail calls. */
  optionalCallsRemaining(): number {
    if (this.workflow !== 'idea-refinement') return 0;
    if (this.isAuto) return 0; // Phase D adaptive topology owns its single optional challenge directly.
    const plan = IDEA_MODE_PLANS[this.mode];
    const logicalUsed = this.attemptedStages.filter(isOptionalStage).length;
    const protocolRoom = Math.max(0, plan.optionalCalls - logicalUsed);
    const budgetRoom = Math.max(0, this.budget.limit - this.budget.used - plan.reservedCalls);
    return Math.min(protocolRoom, budgetRoom);
  }

  /** Actual-call receipt. Resume replay is free and therefore intentionally absent. */
  receipt(): NonNullable<RunMeta['receipt']> {
    const receipt = { discovery: 0, verification: 0, repair: 0, planning: 0 };
    for (const call of this.calls) receipt[call.category ?? callCategory(call.stage)]++;
    return receipt;
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
    this.attemptedStages.push(stage);
    const seq = ++this.seq;
    await this.writer.writeRaw(`${stage}-${handle.id}-${seq}.prompt.txt`, req.prompt);

    // Resume (V6.3): if this exact (provider, prompt) already succeeded in the run we're resuming,
    // replay its output — no real call, no budget spend. Only never-completed calls hit the model.
    const cachedOut = this.replay?.get(replayKey(handle.id, req.prompt));
    const category = callCategory(stage);
    const replayed = cachedOut !== undefined;
    if (!replayed && this.budget.used + 1 > this.budget.limit) throw new BudgetExceeded(this.budget.limit);
    this.events?.onCallStart?.(handle.id, stage, category, replayed);
    let res: RunResultAdapter;
    if (cachedOut !== undefined) {
      res = { ok: true, text: cachedOut, json: req.expectJson ? extractJson(cachedOut) : undefined, durationMs: 0 };
    } else {
      this.budget.used++;
      res = await handle.adapter.run(
        {
          prompt: req.prompt,
          cwd: req.cwd ?? this.cwd,
          timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          expectJson: req.expectJson,
          readOnly: true,
          research: this.workflow === 'idea-refinement' && this.mode !== 'quick' && stage.startsWith('S4'),
          signal: this.signal, // Ctrl+C kills the in-flight child (T8); undefined headless
        },
        handle.flags,
      );
      // Only REAL calls count toward the ledger/budget; a replayed call is free and already recorded in
      // the run it came from. raw/ below still logs the replayed prompt+output for a full audit.
      this.calls.push({
        provider: handle.id,
        stage,
        category: callCategory(stage),
        durationMs: res.durationMs,
        usage: (res.ok && res.usage) || estimateUsage(req.prompt, res.ok ? res.text : ''),
        ...(res.ok ? {} : { error: res.error }),
      });
    }

    await this.writer.writeRaw(
      `${stage}-${handle.id}-${seq}.out`,
      res.ok ? res.text : `[${res.error}]\n${res.stderrTail}`,
    );
    this.events?.onCallEnd?.(handle.id, stage, res.durationMs, res.ok, replayed);
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
    const usage_totals = this.sumUsage();
    return {
      run_id: this.runId,
      workflow: this.workflow,
      ...(this.workflow === 'idea-refinement' ? { mode: this.mode } : {}),
      provider_versions,
      flag_profiles,
      roles,
      read_only,
      calls: this.calls,
      call_count: this.calls.length,
      budget: { limit: this.budget.limit, used: this.budget.used },
      receipt: this.receipt(),
      ...(usage_totals ? { usage_totals } : {}),
      ...(this.autoDecision ? { auto_decision: this.autoDecision } : {}),
      exit_status: exitStatus,
      aborted,
      ...(allFlags.length ? { flags: allFlags } : {}),
    };
  }

  /** Sum per-call usage into run totals. Undefined when no call carries usage (empty run). */
  private sumUsage(): RunMeta['usage_totals'] {
    let inputTokens = 0, outputTokens = 0, reportedCalls = 0, estimatedCalls = 0, reportedCostUsd = 0, anyCost = false;
    for (const c of this.calls) {
      if (!c.usage) continue;
      inputTokens += c.usage.inputTokens ?? 0;
      outputTokens += c.usage.outputTokens ?? 0;
      if (c.usage.estimated) estimatedCalls++;
      else reportedCalls++;
      if (c.usage.reportedCostUsd !== undefined) { reportedCostUsd += c.usage.reportedCostUsd; anyCost = true; }
    }
    if (reportedCalls === 0 && estimatedCalls === 0) return undefined;
    return { inputTokens, outputTokens, reportedCalls, estimatedCalls, ...(anyCost ? { reportedCostUsd } : {}) };
  }
}

/** ponytail: chars/4 heuristic, labeled estimated — good enough until a provider reports. */
function estimateUsage(prompt: string, out: string): NormalizedUsage {
  return { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(out.length / 4), estimated: true };
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
