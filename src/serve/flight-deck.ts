// The only `aiki serve` seam that reaches engine, storage, config, and attachment guards.
// Browser-facing values leave through the strict projections in this directory.

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { runDoctorChecks, type ProviderRow } from '../cli/doctor.js';
import { estimateRun } from '../cli/run.js';
import { readSmokeCache, isFresh, entryToSmoke } from '../config/smoke-cache.js';
import { loadLayeredConfig, type AikiConfig } from '../config/config.js';
import { run as runEngine, type RunOptions, type RunOutcome } from '../orchestration/engine.js';
import { buildEvidencePack, EvidencePack, type EvidencePack as EvidencePackT } from '../orchestration/evidence-pack.js';
import { buildReaderProjection, sanitizeReaderText } from '../orchestration/decision-dossier.js';
import { sanitizeLocalPaths } from '../orchestration/sanitize-paths.js';
import { defaultBudgetFor, defaultDeadlineFor, type CallCategory } from '../orchestration/modes.js';
import { extractPublicUrls, snapshotUrlSources, validatePublicUrl } from '../orchestration/url-sources.js';
import { makeRunId, StageError, type ClarifyChoice, type RunEvents } from '../orchestration/context.js';
import type { DecisionReportJson } from '../orchestration/stages/s10-render.js';
import { IDEA_STAGES } from '../workflows/idea-refinement.js';
import { homeAikiRoot } from '../storage/paths.js';
import { readJsonArtifact, runDir } from '../storage/runs-read.js';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import type { GrillAnswer, RunBriefDraft, UrlSourceSet } from '../schemas/index.js';
import {
  WorkspaceSnapshot,
  SettingsView,
  ThreadDetail,
  SendInput,
  SendOutcome,
  SafeReportProjection,
  ReceiptView,
  providerStatusView,
  quorumView,
  orderProviders,
  threadTitle,
  type DeckAction,
  type ProviderStatusView,
  type SafeReportProjection as SafeReportProjectionT,
  type SendInput as SendInputT,
  type SendOutcome as SendOutcomeT,
  type ReceiptView as ReceiptViewT,
  type ThreadListItemView,
} from './projections.js';
import { appendThread, appendTurn, legacyThreads, legacyThreadDetail, readThreads, readTurns, type ThreadEntry } from './threads.js';
import { allowanceKey, GateTable, type GateCardView, type GateDecision, type GateKind } from './gates.js';
import { FrameBus, type DeckFrame, type HelloFrame, type StageRow } from './frames.js';

type Runner = (workflow: 'idea-refinement', input: string, opts?: RunOptions) => Promise<RunOutcome>;

export interface FlightDeckOpts {
  runsRoot: string;
  version: string;
  runner?: Runner;
  buildPack?: typeof buildEvidencePack;
  snapshotUrls?: typeof snapshotUrlSources;
  validateUrl?: typeof validatePublicUrl;
  now?: () => Date;
}

export class DeckError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DeckError';
  }
}

interface ActiveRun {
  id: string;
  threadId: string;
  input: SendInputT;
  thread: ThreadEntry;
  bus: FrameBus;
  abort: AbortController;
  budget: number;
  startedAt: number;
  calls: number;
  replays: number;
  repairs: number;
  callMs: Partial<Record<ProviderId, number>>;
  callCount: Partial<Record<ProviderId, number>>;
  inflight: Map<string, { category: CallCategory; replayed: boolean }>;
  worker?: Promise<void>;
}

export class FlightDeck {
  private readonly gates = new GateTable();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly reports = new Map<string, SafeReportProjectionT>();
  private readonly workers = new Set<Promise<void>>();
  private activeRunId?: string;

  constructor(private readonly opts: FlightDeckOpts) {}

  async bootstrap(): Promise<WorkspaceSnapshot> {
    const cfg = await loadLayeredConfig();
    const providers = await this.providerViews(false, cfg);
    return WorkspaceSnapshot.parse({
      version: this.opts.version,
      providers,
      quorum: quorumView(providers),
      threads: await this.threadList(),
      settings: this.settingsView(cfg),
    });
  }

  async checkProviders(fresh: boolean): Promise<ProviderStatusView[]> {
    const cfg = await loadLayeredConfig();
    const { rows } = await runDoctorChecks({ smoke: true, fresh });
    return orderProviders(rows.map((row) => providerStatusView(row, modelFor(row.det.id, cfg))));
  }

  async settings(): Promise<SettingsView> {
    return this.settingsView(await loadLayeredConfig());
  }

  async thread(id: string): Promise<ThreadDetail | null> {
    const entry = (await readThreads(this.opts.runsRoot)).find((item) => item.id === id);
    if (!entry) return legacyThreadDetail(id);
    const turns: ThreadDetail['turns'] = [];
    for (const turn of await readTurns(this.opts.runsRoot, id)) {
      if (turn.kind === 'user_message') {
        turns.push({
          kind: 'user_message',
          text: sanitizeLocalPaths(turn.text),
          attachments: turn.attachments.map(attachmentLabel),
          mode: turn.mode,
        });
      } else if (turn.kind === 'run_ref') {
        try {
          turns.push({ kind: 'report', report: await this.report(turn.run_id) });
        } catch {
          turns.push({ kind: 'note', text: 'This council run has not produced a final answer yet.' });
        }
      } else if (turn.kind === 'followup') {
        turns.push({ kind: 'note', text: `${DISPLAY_NAME[turn.provider as ProviderId] ?? turn.provider}: ${sanitizeLocalPaths(turn.answer)}` });
      } else if (turn.kind === 'error') {
        turns.push({ kind: 'note', text: sanitizeLocalPaths(turn.message) });
      }
    }
    return ThreadDetail.parse({ id: entry.id, title: entry.title, legacy: false, turns });
  }

  /** Start a decision worker and return immediately; gates and progress arrive over frames(). */
  async send(raw: SendInputT): Promise<SendOutcomeT> {
    const input = SendInput.parse(raw);
    if (input.kind === 'followup') throw new DeckError(400, 'Follow-up turns arrive in HD4; convene a decision for now.');
    if (this.activeRunId && !this.runs.get(this.activeRunId)?.bus.done) {
      throw new DeckError(409, 'council already in session');
    }

    const cfg = await loadLayeredConfig();
    const existing = input.threadId
      ? (await readThreads(this.opts.runsRoot)).find((item) => item.id === input.threadId)
      : undefined;
    if (input.threadId && !existing) throw new DeckError(404, 'no such thread');

    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const threadId = existing?.id ?? `thread-${randomUUID()}`;
    const runId = makeRunId('idea-refinement', this.opts.now?.() ?? new Date());
    const budget = cfg.budget ?? defaultBudgetFor('idea-refinement', input.mode);
    const thread: ThreadEntry = {
      id: threadId,
      title: existing?.title ?? threadTitle(input.text),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      status: 'running',
      run_ids: [...(existing?.run_ids ?? []), runId],
    };
    await appendThread(this.opts.runsRoot, thread);
    await appendTurn(this.opts.runsRoot, threadId, {
      kind: 'user_message', text: input.text,
      attachments: input.attachments.map((item) => item.kind === 'file' ? item.path : item.url),
      mode: input.mode,
    });

    const stages: StageRow[] = IDEA_STAGES.map((stage) => ({ id: stage.id, label: stage.label, status: 'pending', seat: null }));
    const active: ActiveRun = {
      id: runId, threadId, input, thread, budget,
      bus: new FrameBus(runId, input.mode, stages, budget),
      abort: new AbortController(), startedAt: Date.now(), calls: 0, replays: 0, repairs: 0,
      callMs: {}, callCount: {}, inflight: new Map(),
    };
    this.runs.set(runId, active);
    this.activeRunId = runId;
    active.bus.emit({
      t: 'turn',
      turn: { kind: 'user_message', text: sanitizeLocalPaths(input.text), attachments: input.attachments.map(attachmentLabel), mode: input.mode },
    });
    const worker = this.executeDecision(active, cfg).finally(() => {
      this.workers.delete(worker);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    });
    active.worker = worker;
    this.workers.add(worker);
    return SendOutcome.parse({ threadId, runId, status: 'gating' });
  }

  /** Reconnect-safe frame source: hello at the requested cursor, then ordered buffered/live frames. */
  async *frames(runId: string, afterSeq = 0, signal?: AbortSignal): AsyncGenerator<HelloFrame | DeckFrame> {
    const active = this.runs.get(runId);
    if (!active) throw new DeckError(404, 'no such run');
    const queue: DeckFrame[] = [];
    let wake: (() => void) | undefined;
    const notify = () => { const fn = wake; wake = undefined; fn?.(); };
    const off = active.bus.listen((frame) => { queue.push(frame); notify(); });
    const onAbort = () => notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let sent = Math.min(Math.max(0, afterSeq), active.bus.latestSeq);
      yield active.bus.helloFrame(sent);
      queue.unshift(...active.bus.replaySince(sent));
      while (true) {
        let frame: DeckFrame | undefined;
        while ((frame = queue.shift())) {
          if (frame.seq <= sent) continue;
          sent = frame.seq;
          yield frame;
        }
        if (active.bus.done || active.bus.isClosed || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || active.bus.done || active.bus.isClosed || signal?.aborted) notify();
        });
      }
    } finally {
      off();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async act(runId: string, action: DeckAction): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) throw new DeckError(404, 'no such run');
    if (action.t === 'resume') throw new DeckError(400, 'Resume actions arrive in HD4.');
    if (action.t === 'cancel') {
      active.abort.abort();
      this.gates.denyAll();
      return;
    }

    const gate = this.gates.get(action.gateId);
    if (!gate) throw new DeckError(409, 'gate is no longer pending');
    if (action.t === 'gate' && !gate.scopes?.includes(action.decision)) throw new DeckError(400, 'that gate does not accept a permission decision');
    if (action.t === 'answer' && gate.scopes) throw new DeckError(400, 'that gate expects a permission decision');
    const value = action.t === 'gate' ? action.decision : action.value;
    if (!this.gates.resolve(action.gateId, value)) throw new DeckError(409, 'gate is no longer pending');
    const summary = action.t === 'gate' ? decisionSummary(action.decision) : 'Answer received';
    active.bus.emit({ t: 'gate_resolved', gateId: action.gateId, summary });
    await appendTurn(this.opts.runsRoot, active.threadId, {
      kind: 'gate_receipt', gate_kind: gate.kind, summary, decision: action.t === 'gate' ? action.decision : 'answered',
    });
  }

  async report(runId: string): Promise<SafeReportProjectionT> {
    const cached = this.reports.get(runId);
    if (cached) return cached;
    const raw = await readJsonArtifact<DecisionReportJson>(runDir(runId, this.opts.runsRoot), '10-decision-report.json');
    if (!raw?.dossier || !raw.verdict || !raw.receipt) throw new DeckError(409, 'report is not ready');
    const clean = (text: string) => sanitizeLocalPaths(sanitizeReaderText(text));
    const reader = raw.dossier.readerBrief ? buildReaderProjection(raw) : {
      headline: clean(raw.verdict.summary),
      bottomLine: clean(raw.verdict.primaryReason),
      sections: [{ heading: 'Council reasoning', summary: clean(raw.verdict.summary), bullets: raw.keyFindings.map(clean) }],
      featureBacklog: undefined,
      implementationPlan: undefined,
      caveats: raw.criticalUnknowns.map(clean),
      warnings: raw.verdict.criticalWarning ? [{ message: clean(raw.verdict.criticalWarning) }] : [],
      notices: [], snapshot: undefined, sources: [], nextStep: clean(raw.recommendedActions[0]?.action ?? 'Review the decision before acting.'),
    };
    const features = reader.featureBacklog ? [
      ...reader.featureBacklog.must.map((item) => featureView('Must', item)),
      ...reader.featureBacklog.should.map((item) => featureView('Should', item)),
      ...reader.featureBacklog.later.map((item) => featureView('Later', item)),
      ...reader.featureBacklog.wont.map((item) => ({ priority: 'Not now', feature: item.feature, userValue: '', rationale: item.reason, effort: '' })),
    ] : [];
    const receipt = ReceiptView.parse({
      mode: raw.mode === 'quick' ? 'Quick' : 'Full Council',
      calls: raw.receipt.calls,
      budget: raw.receipt.budget,
      replays: this.runs.get(runId)?.replays ?? 0,
      durationMs: raw.receipt.modelTimeMs,
      repairs: raw.receipt.categories.repair,
      providers: Object.entries(raw.receipt.byProvider)
        .filter(([id]) => id === 'claude' || id === 'codex' || id === 'agy')
        .map(([id, calls]) => ({ name: DISPLAY_NAME[id as ProviderId], calls })),
      warnings: [...reader.warnings.map((item) => item.message), ...reader.notices.map((item) => item.message)],
    });
    const projected = SafeReportProjection.parse({
      runId,
      verdict: verdictView(raw.verdict.status),
      headline: clean(reader.headline),
      bottomLine: clean(reader.bottomLine),
      sections: reader.sections.map((section) => ({ heading: clean(section.heading), summary: clean(section.summary), bullets: section.bullets.map(clean) })),
      warnings: receipt.warnings,
      caveats: reader.caveats.map(clean),
      features,
      milestones: reader.implementationPlan?.milestones.map((item) => ({
        order: item.order, timebox: clean(item.timebox), outcome: clean(item.outcome), tasks: item.tasks.map(clean), doneWhen: clean(item.acceptance_test),
      })) ?? [],
      sources: reader.sources.map((source) => ({ label: clean(source.label), ...(source.url ? { url: source.url } : {}), citedFor: source.citedFor.map(clean) })),
      nextStep: clean(reader.nextStep),
      receipt,
    });
    this.reports.set(runId, projected);
    return projected;
  }

  async close(): Promise<void> {
    const active = this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
    active?.abort.abort();
    this.gates.denyAll();
    await Promise.allSettled([...this.workers]);
    for (const run of this.runs.values()) run.bus.close();
  }

  // ── live worker ──────────────────────────────────────────────────────────────────

  private async executeDecision(active: ActiveRun, cfg: AikiConfig): Promise<void> {
    try {
      let evidencePack: EvidencePackT | undefined;
      const packs: EvidencePackT[] = [];
      for (const attachment of active.input.attachments) {
        if (attachment.kind !== 'file') continue;
        const pack = await (this.opts.buildPack ?? buildEvidencePack)(attachment.path);
        const detail = pack.files.map((file) => `${file.path} · sha256 ${file.sha256.slice(0, 12)}`);
        const decision = await this.permission(active, 'file', 'Read attached material?', detail, allowanceKey('file', `${pack.root}:${pack.files.map((file) => file.sha256).join(',')}`));
        if (decision === 'deny') return this.finishCancelled(active, 'File access denied. No provider calls were made.');
        packs.push(pack);
      }
      if (packs.length) evidencePack = EvidencePack.parse({
        root: packs.length === 1 ? packs[0]!.root : 'multiple attached files',
        files: packs.flatMap((pack) => pack.files),
      });

      const urlInput = [active.input.text, ...active.input.attachments.filter((item) => item.kind === 'url').map((item) => item.url)].join('\n');
      const urls = extractPublicUrls(urlInput);
      for (const rawUrl of urls) {
        const url = await (this.opts.validateUrl ?? validatePublicUrl)(rawUrl);
        const decision = await this.permission(active, 'url', 'Fetch attached page?', [url, 'public http(s) URL · guarded fetch · max 500 KB'], allowanceKey('url', url));
        if (decision === 'deny') return this.finishCancelled(active, 'URL access denied. No provider calls were made.');
      }
      const urlSources: UrlSourceSet = await (this.opts.snapshotUrls ?? snapshotUrlSources)(urlInput);
      const unreadable = urlSources.sources.filter((source) => source.status !== 'FETCHED');
      let allowBlockedSources = false;
      if (unreadable.length) {
        const decision = await this.permission(active, 'blocked', 'Run without an unreadable page?', unreadable.map((source) => `${source.url} · ${source.error ?? source.status}`), allowanceKey('blocked', unreadable.map((source) => source.url).join('|')));
        if (decision === 'deny') return this.finishCancelled(active, 'Blocked source was not waived. No provider calls were made.');
        allowBlockedSources = true;
      }

      const estimate = estimateRun('idea-refinement', { mode: active.input.mode });
      const calls = estimate.minCalls && estimate.minCalls !== estimate.calls ? `${estimate.minCalls}–${estimate.calls}` : `${estimate.calls}`;
      const spend = await this.permission(active, 'spend', 'Convene the council?', [
        `${active.input.mode === 'quick' ? 'Quick' : 'Full Council'} · about ${calls} provider calls`,
        `budget cap ${active.budget} · about ${estimate.opus} Claude/Opus`,
      ], allowanceKey('spend', `${active.input.mode}:${active.budget}:${calls}`));
      if (spend === 'deny') return this.finishCancelled(active, 'Spend denied. No provider calls were made.');

      active.bus.setLifecycle('running');
      await appendTurn(this.opts.runsRoot, active.threadId, { kind: 'run_ref', run_id: active.id, mode: active.input.mode });
      const outcome = await (this.opts.runner ?? runEngine)('idea-refinement', active.input.text, {
        runId: active.id,
        mode: active.input.mode,
        budget: active.budget,
        deadlineMs: cfg.deadlineMs ?? defaultDeadlineFor('idea-refinement', active.input.mode),
        roleOverrides: cfg.roles,
        providerModels: cfg.models,
        runsRoot: this.opts.runsRoot,
        signal: active.abort.signal,
        evidencePack,
        urlSources,
        allowBlockedSources,
        events: this.runEvents(active),
      });
      await this.refreshCounters(active);
      if (outcome.ok) {
        const report = await this.report(active.id);
        active.bus.emit({ t: 'report_ready', runId: active.id });
        active.bus.emit({ t: 'receipt', receipt: report.receipt });
        await this.finishThread(active, 'idle');
        active.bus.emit({ t: 'done', status: 'ok', flags: report.warnings });
      } else if (outcome.aborted || active.abort.signal.aborted) {
        await this.finishCancelled(active, 'Council cancelled. Partial artifacts were kept.');
      } else {
        await this.finishFailed(active, outcome.error?.message ?? 'The council could not complete.');
      }
    } catch (error) {
      if (active.abort.signal.aborted) await this.finishCancelled(active, 'Council cancelled. Partial artifacts were kept.');
      else await this.finishFailed(active, error instanceof Error ? error.message : String(error));
    }
  }

  private runEvents(active: ActiveRun): RunEvents {
    const stage = (id: string) => IDEA_STAGES.find((item) => item.id === id);
    return {
      onStageStart: (id) => active.bus.emit({ t: 'stage', id, label: stage(id)?.label ?? id, status: 'running' }),
      onStageEnd: (id, status) => {
        active.bus.emit({ t: 'stage', id, label: stage(id)?.label ?? id, status });
        if (id === 'S7') void this.refreshCounters(active);
      },
      onCallStart: (provider, callStage, category, replayed) => {
        active.inflight.set(`${provider}:${callStage}`, { category, replayed });
        active.bus.emit({ t: 'call', provider, stage: callStage, phase: 'start', category, replayed });
      },
      onCallEnd: (provider, callStage, ms, ok, replayed) => {
        const key = `${provider}:${callStage}`;
        const started = active.inflight.get(key) ?? { category: 'discovery' as const, replayed };
        active.inflight.delete(key);
        if (replayed) active.replays++;
        else {
          active.calls++;
          active.callCount[provider] = (active.callCount[provider] ?? 0) + 1;
          active.callMs[provider] = (active.callMs[provider] ?? 0) + ms;
          if (started.category === 'repair') active.repairs++;
        }
        active.bus.emit({ t: 'call', provider, stage: callStage, phase: 'end', ms, ok, category: started.category, replayed });
        if (started.category === 'repair' && !replayed) active.bus.emit({ t: 'counters', repairs: active.repairs });
      },
      clarify: async (question, options): Promise<ClarifyChoice> => {
        const gate: GateCardView = { id: this.gates.gateId('clarify'), kind: 'clarify', title: 'Choose the intended reading', lines: [], question, options, allowText: true };
        const value = await this.gates.request<string | number>(gate, undefined, (card) => active.bus.emit({ t: 'gate', gate: card }));
        if (active.abort.signal.aborted || value === 'deny') throw new StageError('S0', 'ABORT', 'aborted');
        if (typeof value === 'number') return { kind: 'pick', index: Math.max(0, Math.min(options.length - 1, value)) };
        if (value.trim().toLowerCase() === 'both') return { kind: 'both' };
        return { kind: 'text', text: value.trim() || options[0] || 'Use the first reading.' };
      },
      grill: async (brief: RunBriefDraft): Promise<GrillAnswer[]> => {
        const answers: GrillAnswer[] = [];
        for (const question of brief.questions) {
          const gate: GateCardView = { id: this.gates.gateId('grill'), kind: 'grill', title: 'One detail before the council starts', lines: [], questions: [{ id: question.id, prompt: question.question }] };
          const value = await this.gates.request<string | number>(gate, undefined, (card) => active.bus.emit({ t: 'gate', gate: card }));
          if (active.abort.signal.aborted || value === 'deny') throw new StageError('S0', 'ABORT', 'aborted');
          answers.push({ question_id: question.id, answer: String(value).trim() || 'Use best judgment.', source: 'user' });
        }
        return answers;
      },
    };
  }

  private permission(active: ActiveRun, kind: GateKind, title: string, lines: string[], key: string): Promise<GateDecision> {
    const gate: GateCardView = {
      id: this.gates.gateId(kind), kind, title, lines,
      scopes: ['allow_once', 'allow_session', 'deny'],
    };
    return this.gates.request(gate, key, (card) => active.bus.emit({ t: 'gate', gate: card }));
  }

  private async refreshCounters(active: ActiveRun): Promise<void> {
    if (active.bus.done) return;
    const graph = await readJsonArtifact<{ positions?: unknown[]; evidence?: unknown[]; claims?: Array<{ state?: string }> }>(runDir(active.id, this.opts.runsRoot), '07-decision-graph.json');
    if (!graph) return;
    active.bus.emit({
      t: 'counters',
      positions: graph.positions?.length ?? 0,
      evidence: graph.evidence?.length ?? 0,
      disagreements: graph.claims?.filter((claim) => claim.state === 'DISAGREEMENT').length ?? 0,
      repairs: active.repairs,
    });
  }

  private receipt(active: ActiveRun, warnings: string[] = []): ReceiptViewT {
    return ReceiptView.parse({
      mode: active.input.mode === 'quick' ? 'Quick' : 'Full Council',
      calls: active.calls,
      budget: active.budget,
      replays: active.replays,
      durationMs: Object.values(active.callMs).reduce((sum, value) => sum + (value ?? 0), 0),
      repairs: active.repairs,
      providers: (['claude', 'codex', 'agy'] as const)
        .filter((id) => active.callCount[id])
        .map((id) => ({ name: DISPLAY_NAME[id], calls: active.callCount[id] ?? 0 })),
      warnings,
    });
  }

  private async finishCancelled(active: ActiveRun, message: string): Promise<void> {
    await this.finishThread(active, 'cancelled');
    await appendTurn(this.opts.runsRoot, active.threadId, { kind: 'error', message });
    if (!active.bus.done) {
      active.bus.emit({ t: 'receipt', receipt: this.receipt(active) });
      active.bus.emit({ t: 'done', status: 'aborted', flags: [] });
    }
  }

  private async finishFailed(active: ActiveRun, raw: string): Promise<void> {
    const message = sanitizeLocalPaths(raw);
    await this.finishThread(active, 'failed');
    await appendTurn(this.opts.runsRoot, active.threadId, { kind: 'error', message });
    if (!active.bus.done) {
      active.bus.emit({ t: 'gate', gate: { id: this.gates.gateId('attention'), kind: 'attention', title: 'Council needs attention', lines: [message], fix: recoveryText(message) } });
      active.bus.emit({ t: 'receipt', receipt: this.receipt(active, [message]) });
      active.bus.emit({ t: 'done', status: 'failed', flags: [message] });
    }
  }

  private async finishThread(active: ActiveRun, status: ThreadEntry['status']): Promise<void> {
    active.thread = { ...active.thread, status, updated_at: (this.opts.now?.() ?? new Date()).toISOString() };
    await appendThread(this.opts.runsRoot, active.thread);
  }

  // ── HD2 reads ──────────────────────────────────────────────────────────────────────

  private async providerViews(fresh: boolean, cfg: AikiConfig): Promise<ProviderStatusView[]> {
    const { rows } = await runDoctorChecks({ smoke: false });
    const cache = fresh ? {} : await readSmokeCache(this.opts.runsRoot);
    const now = Date.now();
    const withCache = rows.map((row): ProviderRow => {
      if (row.det.status !== 'READY') return row;
      const entry = cache[row.det.id];
      return entry && isFresh(entry, row.det.version ?? null, now)
        ? { ...row, smoke: entryToSmoke(entry), cached: true }
        : row;
    });
    return orderProviders(withCache.map((row) => providerStatusView(row, modelFor(row.det.id, cfg))));
  }

  private async threadList(): Promise<ThreadListItemView[]> {
    const [live, legacy] = await Promise.all([readThreads(this.opts.runsRoot), legacyThreads()]);
    const liveViews: ThreadListItemView[] = live.map((thread) => ({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updated_at,
      status: thread.status === 'running' ? 'running' : thread.status === 'failed' ? 'failed' : thread.status === 'cancelled' ? 'cancelled' : 'complete',
      mode: null,
      legacy: false,
    }));
    const liveIds = new Set(liveViews.map((thread) => thread.id));
    return [...liveViews, ...legacy.filter((thread) => !liveIds.has(thread.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private settingsView(cfg: AikiConfig): SettingsView {
    return SettingsView.parse({
      models: { claude: cfg.models?.claude ?? null, codex: cfg.models?.codex ?? null, agy: cfg.models?.agy ?? null },
      roles: {
        ...(cfg.roles?.analyst ? { analyst: cfg.roles.analyst } : {}),
        ...(cfg.roles?.judge ? { judge: cfg.roles.judge } : {}),
        ...(cfg.roles?.verifier ? { verifier: cfg.roles.verifier } : {}),
        ...(cfg.roles?.s4 ? { s4: cfg.roles.s4 } : {}),
      },
      scope: this.opts.runsRoot === homeAikiRoot() ? 'global (~/.aiki/config.json)' : 'project (.aiki/config.json)',
    });
  }
}

function modelFor(id: ProviderId, cfg: AikiConfig): string | null {
  return cfg.models?.[id] ?? null;
}

function attachmentLabel(item: SendInputT['attachments'][number] | string): string {
  const value = typeof item === 'string' ? item : item.kind === 'file' ? item.path : item.url;
  return /^https?:\/\//i.test(value) ? value : basename(value);
}

function decisionSummary(decision: GateDecision): string {
  return decision === 'allow_session' ? '✓ Allowed for this session' : decision === 'allow_once' ? '✓ Allowed once' : '✕ Denied';
}

function recoveryText(message: string): string {
  if (/auth|login/i.test(message)) return 'Run the affected provider CLI once to log in, then retry.';
  if (/quota|rate limit/i.test(message)) return 'Wait for the provider quota to reset, then retry.';
  return 'Review the message, then convene again.';
}

function featureView(priority: string, item: { feature: string; user_value: string; rationale: string; effort: string }) {
  const effort = item.effort === 'S' ? 'Small' : item.effort === 'M' ? 'Medium' : item.effort === 'L' ? 'Large' : item.effort;
  return { priority, feature: item.feature, userValue: item.user_value, rationale: item.rationale, effort };
}

function verdictView(status: DecisionReportJson['verdict']['status']): { tone: 'go' | 'conditions' | 'stop' | 'inconclusive'; label: string } {
  if (status === 'ACCEPTED') return { tone: 'go', label: 'Proceed' };
  if (status === 'ACCEPTED_WITH_CONDITIONS') return { tone: 'conditions', label: 'Proceed with conditions' };
  if (status === 'REJECTED') return { tone: 'stop', label: 'Stop' };
  return { tone: 'inconclusive', label: 'Inconclusive' };
}
