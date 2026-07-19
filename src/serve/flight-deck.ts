// The only `aiki serve` seam that reaches engine, storage, config, and attachment guards.
// Browser-facing values leave through the strict projections in this directory.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runDoctorChecks, type ProviderRow } from '../cli/doctor.js';
import { estimateRun } from '../cli/run.js';
import { readSmokeCache, isFresh, entryToSmoke } from '../config/smoke-cache.js';
import { loadConfig, loadLayeredConfig, type AikiConfig } from '../config/config.js';
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
import { buildReplayCache } from '../storage/replay.js';
import { readJsonArtifact, runDir } from '../storage/runs-read.js';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import { RunMeta, UrlSourceSet, type GrillAnswer, type RunBriefDraft, type UrlSourceSet as UrlSourceSetT } from '../schemas/index.js';
import {
  WorkspaceSnapshot,
  SettingsView,
  SettingsPatch,
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
  type SettingsPatch as SettingsPatchT,
} from './projections.js';
import { appendThread, appendTurn, legacyThreads, legacyThreadDetail, readThreads, readTurns, type ThreadEntry } from './threads.js';
import { allowanceKey, GateTable, type GateCardView, type GateDecision, type GateKind } from './gates.js';
import { FrameBus, type DeckFrame, type HelloFrame, type StageRow } from './frames.js';
import { runFollowup, type FollowupRunner } from './followup.js';

type Runner = (workflow: 'idea-refinement', input: string, opts?: RunOptions) => Promise<RunOutcome>;

export interface FlightDeckOpts {
  runsRoot: string;
  version: string;
  runner?: Runner;
  buildPack?: typeof buildEvidencePack;
  snapshotUrls?: typeof snapshotUrlSources;
  validateUrl?: typeof validatePublicUrl;
  followupRunner?: FollowupRunner;
  now?: () => Date;
  /** Optional sink for human-readable run progress lines (the serve CLI wires this to the terminal). */
  log?: (line: string) => void;
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
  resume?: ResumeInput;
  worker?: Promise<void>;
}

interface ResumeInput {
  fromRunId: string;
  replay: Map<string, string>;
  evidencePack?: EvidencePackT;
  urlSources?: UrlSourceSetT;
  allowBlockedSources: boolean;
}

export class FlightDeck {
  private readonly gates = new GateTable();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly reports = new Map<string, SafeReportProjectionT>();
  private readonly workers = new Set<Promise<void>>();
  private activeRunId?: string;

  constructor(private readonly opts: FlightDeckOpts) {}

  async bootstrap(): Promise<WorkspaceSnapshot> {
    const [cfg, local] = await Promise.all([loadLayeredConfig(this.opts.runsRoot), loadConfig(this.opts.runsRoot)]);
    const providers = await this.providerViews(false, cfg);
    return WorkspaceSnapshot.parse({
      version: this.opts.version,
      providers,
      quorum: quorumView(providers),
      threads: await this.threadList(),
      settings: this.settingsView(cfg, local),
    });
  }

  async checkProviders(fresh: boolean): Promise<ProviderStatusView[]> {
    const cfg = await loadLayeredConfig(this.opts.runsRoot);
    const { rows } = await runDoctorChecks({ smoke: true, fresh });
    return orderProviders(rows.map((row) => providerStatusView(row, modelFor(row.det.id, cfg))));
  }

  async settings(): Promise<SettingsView> {
    const [cfg, local] = await Promise.all([loadLayeredConfig(this.opts.runsRoot), loadConfig(this.opts.runsRoot)]);
    return this.settingsView(cfg, local);
  }

  async updateSettings(raw: SettingsPatchT): Promise<SettingsView> {
    const patch = SettingsPatch.parse(raw);
    const root = this.opts.runsRoot === homeAikiRoot() ? homeAikiRoot() : this.opts.runsRoot;
    await loadLayeredConfig(this.opts.runsRoot); // validate every active layer before touching either file
    const next: AikiConfig = { ...(await loadConfig(root)) };

    if (patch.models) {
      const models: NonNullable<AikiConfig['models']> = { ...next.models };
      for (const id of ['claude', 'codex', 'agy'] as const) {
        const value = patch.models[id];
        if (value === undefined) continue;
        if (value === null) delete models[id];
        else models[id] = value;
      }
      if (Object.keys(models).length) next.models = models;
      else delete next.models;
    }

    if (patch.roles) {
      const roles: NonNullable<AikiConfig['roles']> = { ...next.roles };
      for (const role of ['analyst', 'judge', 'verifier', 'responder'] as const) {
        const value = patch.roles[role];
        if (value === undefined) continue;
        if (value === null) delete roles[role];
        else roles[role] = value;
      }
      if (patch.roles.s4 !== undefined) {
        if (patch.roles.s4 === null) delete roles.s4;
        else roles.s4 = patch.roles.s4;
      }
      if (Object.keys(roles).length) next.roles = roles;
      else delete next.roles;
    }

    await mkdir(root, { recursive: true });
    const path = join(root, 'config.json');
    const tmp = join(root, `config.json.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return this.settings();
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
        const provider = turn.provider as ProviderId;
        const providerName = DISPLAY_NAME[provider] ?? turn.provider;
        turns.push({ kind: 'user_message', text: sanitizeLocalPaths(turn.question), attachments: [], mode: 'followup' });
        turns.push({
          kind: 'followup', question: sanitizeLocalPaths(turn.question), answer: sanitizeLocalPaths(turn.answer),
          provider, providerName, label: `follow-up · ${providerName} · 1 call · no council`, callMs: turn.call_ms,
        });
      } else if (turn.kind === 'error') {
        turns.push({ kind: 'note', text: sanitizeLocalPaths(turn.message) });
      }
    }
    let resumeRunId: string | null = null;
    const latestRunId = entry.run_ids.at(-1);
    if ((entry.status === 'failed' || entry.status === 'cancelled') && latestRunId) {
      const meta = RunMeta.safeParse(await readJsonArtifact(runDir(latestRunId, this.opts.runsRoot), 'meta.json'));
      if (meta.success && meta.data.workflow === 'idea-refinement' && (await buildReplayCache(runDir(latestRunId, this.opts.runsRoot))).size) {
        resumeRunId = latestRunId;
      }
    }
    return ThreadDetail.parse({ id: entry.id, title: entry.title, legacy: false, resumeRunId, turns });
  }

  /** Start a decision worker and return immediately; gates and progress arrive over frames(). */
  async send(raw: SendInputT): Promise<SendOutcomeT> {
    const input = SendInput.parse(raw);
    if (this.activeRunId && !this.runs.get(this.activeRunId)?.bus.done) {
      throw new DeckError(409, 'council already in session');
    }

    const cfg = await loadLayeredConfig(this.opts.runsRoot);
    const existing = input.threadId
      ? (await readThreads(this.opts.runsRoot)).find((item) => item.id === input.threadId)
      : undefined;
    if (input.threadId && !existing) throw new DeckError(404, 'no such thread');

    return input.kind === 'followup'
      ? this.startFollowup(input, cfg, existing)
      : this.startDecision(input, cfg, existing);
  }

  private async startDecision(input: SendInputT, cfg: AikiConfig, existing?: ThreadEntry, resume?: ResumeInput): Promise<SendOutcomeT> {
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
    if (!resume) {
      await appendTurn(this.opts.runsRoot, threadId, {
        kind: 'user_message', text: input.text,
        attachments: input.attachments.map((item) => item.kind === 'file' ? item.path : item.url),
        mode: input.mode,
      });
    }

    const stages: StageRow[] = IDEA_STAGES.map((stage) => ({ id: stage.id, label: stage.label, status: 'pending', seat: null }));
    const active: ActiveRun = {
      id: runId, threadId, input, thread, budget, resume,
      bus: new FrameBus(runId, input.mode, stages, budget),
      abort: new AbortController(), startedAt: Date.now(), calls: 0, replays: 0, repairs: 0,
      callMs: {}, callCount: {}, inflight: new Map(),
    };
    this.runs.set(runId, active);
    this.activeRunId = runId;
    if (!resume) {
      active.bus.emit({
        t: 'turn',
        turn: { kind: 'user_message', text: sanitizeLocalPaths(input.text), attachments: input.attachments.map(attachmentLabel), mode: input.mode },
      });
    }
    const worker = this.executeDecision(active, cfg).finally(() => {
      this.workers.delete(worker);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    });
    active.worker = worker;
    this.workers.add(worker);
    return SendOutcome.parse({ threadId, runId, status: 'gating' });
  }

  private async startFollowup(input: SendInputT, cfg: AikiConfig, existing?: ThreadEntry): Promise<SendOutcomeT> {
    if (!existing) throw new DeckError(400, 'Convene a decision first, then ask a follow-up about its answer.');
    if (input.attachments.length) throw new DeckError(400, 'Attachments need a new council decision; use Re-convene instead.');

    let report: SafeReportProjectionT | undefined;
    for (const runId of [...existing.run_ids].reverse()) {
      try {
        report = await this.report(runId);
        break;
      } catch {
        // A partial run has no report; keep looking for the latest completed decision in the thread.
      }
    }
    if (!report) throw new DeckError(400, 'Convene a decision first, then ask a follow-up about its answer.');

    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const runId = `followup-${randomUUID()}`;
    const thread: ThreadEntry = { ...existing, updated_at: now, status: 'running' };
    await appendThread(this.opts.runsRoot, thread);
    const active: ActiveRun = {
      id: runId, threadId: thread.id, input, thread, budget: 1,
      bus: new FrameBus(runId, 'followup', [], 1),
      abort: new AbortController(), startedAt: Date.now(), calls: 0, replays: 0, repairs: 0,
      callMs: {}, callCount: {}, inflight: new Map(),
    };
    this.runs.set(runId, active);
    this.activeRunId = runId;
    active.bus.emit({
      t: 'turn',
      turn: { kind: 'user_message', text: sanitizeLocalPaths(input.text), attachments: [], mode: 'followup' },
    });
    const worker = this.executeFollowup(active, cfg, report).finally(() => {
      this.workers.delete(worker);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    });
    active.worker = worker;
    this.workers.add(worker);
    return SendOutcome.parse({ threadId: thread.id, runId, status: 'gating' });
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

  async act(runId: string, action: DeckAction): Promise<SendOutcomeT | void> {
    if (action.t === 'resume') return this.resume(runId);
    const active = this.runs.get(runId);
    if (!active) throw new DeckError(404, 'no such run');
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
    this.log(`⏵ ${summary}`);
    active.bus.emit({ t: 'gate_resolved', gateId: action.gateId, summary });
    await appendTurn(this.opts.runsRoot, active.threadId, {
      kind: 'gate_receipt', gate_kind: gate.kind, summary, decision: action.t === 'gate' ? action.decision : 'answered',
    });
  }

  private async resume(oldRunId: string): Promise<SendOutcomeT> {
    if (this.activeRunId && !this.runs.get(this.activeRunId)?.bus.done) {
      throw new DeckError(409, 'council already in session');
    }
    const thread = (await readThreads(this.opts.runsRoot)).find((entry) => entry.run_ids.includes(oldRunId));
    if (!thread) throw new DeckError(404, 'no resumable decision found');
    if (thread.status !== 'failed' && thread.status !== 'cancelled') {
      throw new DeckError(400, 'Only a failed or cancelled council run can be resumed.');
    }

    const oldDir = runDir(oldRunId, this.opts.runsRoot);
    const parsedMeta = RunMeta.safeParse(await readJsonArtifact(oldDir, 'meta.json'));
    if (!parsedMeta.success || parsedMeta.data.workflow !== 'idea-refinement') {
      throw new DeckError(400, 'This run does not have valid decision metadata to resume.');
    }
    let input: string;
    try {
      input = await readFile(join(oldDir, 'inputs', 'idea.md'), 'utf8');
    } catch {
      throw new DeckError(400, 'This run does not have its original decision input to resume.');
    }
    const replay = await buildReplayCache(oldDir);
    if (!replay.size) throw new DeckError(400, 'No completed calls were cached; convene a fresh decision instead.');

    let evidencePack: EvidencePackT | undefined;
    const savedPack = await readJsonArtifact(oldDir, 'inputs/evidence-pack.json');
    if (savedPack) {
      const parsed = EvidencePack.safeParse(savedPack);
      if (!parsed.success) throw new DeckError(400, 'The saved evidence manifest is invalid; resume was refused.');
      evidencePack = parsed.data;
    }
    let urlSources: UrlSourceSetT | undefined;
    const savedSources = await readJsonArtifact(oldDir, '00a-url-sources.json');
    if (savedSources) {
      const parsed = UrlSourceSet.safeParse(savedSources);
      if (!parsed.success) throw new DeckError(400, 'The saved URL snapshot is invalid; resume was refused.');
      urlSources = parsed.data;
    }

    const cfg = await loadLayeredConfig(this.opts.runsRoot);
    const mode = parsedMeta.data.mode === 'quick' ? 'quick' : 'council';
    return this.startDecision(
      { threadId: thread.id, text: input, mode, kind: 'decision', attachments: [] },
      cfg,
      thread,
      {
        fromRunId: oldRunId,
        replay,
        evidencePack,
        urlSources,
        allowBlockedSources: urlSources?.sources.some((source) => source.status !== 'FETCHED') ?? false,
      },
    );
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
      confidence: { score: Math.round((raw.verdict.confidence ?? 0) * 100), label: raw.verdict.confidenceLabel ?? 'Low' },
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
      this.log(`▶ convening ${active.input.mode} council · ${active.id}`);
      const estimate = estimateRun('idea-refinement', { mode: active.input.mode });
      let evidencePack = active.resume?.evidencePack;
      let urlSources: UrlSourceSetT = active.resume?.urlSources ?? { sources: [] };
      let allowBlockedSources = active.resume?.allowBlockedSources ?? false;

      if (active.resume) {
        const estimatedNew = Math.max(1, estimate.calls - active.resume.replay.size);
        const decision = await this.permission(active, 'resume', 'Resume this council?', [
          `${active.resume.replay.size} completed call${active.resume.replay.size === 1 ? '' : 's'} cached and replayed free`,
          `estimated new spend: up to ${estimatedNew} provider call${estimatedNew === 1 ? '' : 's'} · budget cap ${active.budget}`,
        ], allowanceKey('resume', active.resume.fromRunId));
        if (decision === 'deny') return this.finishCancelled(active, 'Resume denied. No provider calls were made.');
      } else {
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
        urlSources = await (this.opts.snapshotUrls ?? snapshotUrlSources)(urlInput);
        const unreadable = urlSources.sources.filter((source) => source.status !== 'FETCHED');
        if (unreadable.length) {
          const decision = await this.permission(active, 'blocked', 'Run without an unreadable page?', unreadable.map((source) => `${source.url} · ${source.error ?? source.status}`), allowanceKey('blocked', unreadable.map((source) => source.url).join('|')));
          if (decision === 'deny') return this.finishCancelled(active, 'Blocked source was not waived. No provider calls were made.');
          allowBlockedSources = true;
        }

        const calls = estimate.minCalls && estimate.minCalls !== estimate.calls ? `${estimate.minCalls}–${estimate.calls}` : `${estimate.calls}`;
        const spend = await this.permission(active, 'spend', 'Convene the council?', [
          `${active.input.mode === 'quick' ? 'Quick' : 'Full Council'} · about ${calls} provider calls`,
          `budget cap ${active.budget} · about ${estimate.opus} Claude/Opus`,
        ], allowanceKey('spend', `${active.input.mode}:${active.budget}:${calls}`));
        if (spend === 'deny') return this.finishCancelled(active, 'Spend denied. No provider calls were made.');
      }

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
        replay: active.resume?.replay,
        resumedFrom: active.resume?.fromRunId,
        events: this.runEvents(active),
      });
      await this.refreshCounters(active);
      if (outcome.ok) {
        const report = await this.report(active.id);
        this.log(`✓ verdict: ${report.verdict.label}${report.confidence ? ` · confidence ${report.confidence.score} (${report.confidence.label})` : ''} · ${active.calls} calls`);
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

  private async executeFollowup(active: ActiveRun, cfg: AikiConfig, report: SafeReportProjectionT): Promise<void> {
    try {
      const spend = await this.permission(active, 'spend', 'Answer this follow-up?', [
        '1 provider call · no council',
        'Uses the completed council report as context',
      ], allowanceKey('spend', 'followup:1'));
      if (spend === 'deny') return this.finishFollowupCancelled(active);

      active.bus.setLifecycle('running');
      let ended = false;
      const onCallStart = (provider: ProviderId) => {
        active.bus.emit({ t: 'call', provider, stage: 'followup', phase: 'start', category: 'planning', replayed: false });
      };
      const onCallEnd = (provider: ProviderId, ms: number, ok: boolean) => {
        ended = true;
        active.calls++;
        active.callCount[provider] = (active.callCount[provider] ?? 0) + 1;
        active.callMs[provider] = (active.callMs[provider] ?? 0) + ms;
        active.bus.emit({ t: 'call', provider, stage: 'followup', phase: 'end', ms, ok, category: 'planning', replayed: false });
      };
      const result = await (this.opts.followupRunner ?? runFollowup)({
        question: active.input.text,
        report,
        config: cfg,
        signal: active.abort.signal,
        onCallStart,
        onCallEnd,
      });
      if (!ended) {
        onCallStart(result.provider);
        onCallEnd(result.provider, result.callMs, true);
      }
      const answer = sanitizeLocalPaths(result.answer);
      const providerName = DISPLAY_NAME[result.provider];
      const turn = {
        kind: 'followup' as const,
        question: sanitizeLocalPaths(active.input.text),
        answer,
        provider: result.provider,
        providerName,
        label: `follow-up · ${providerName} · 1 call · no council`,
        callMs: result.callMs,
      };
      await appendTurn(this.opts.runsRoot, active.threadId, {
        kind: 'followup', question: active.input.text, provider: result.provider, answer, call_ms: result.callMs,
      });
      active.bus.emit({ t: 'turn', turn });
      active.bus.emit({ t: 'receipt', receipt: this.receipt(active) });
      await this.finishThread(active, 'idle');
      active.bus.emit({ t: 'done', status: 'ok', flags: [] });
    } catch (error) {
      if (active.abort.signal.aborted) await this.finishFollowupCancelled(active);
      else await this.finishFollowupFailed(active, error instanceof Error ? error.message : String(error));
    }
  }

  /** Human-readable progress line to the serve terminal (no-op unless a log sink is wired). */
  private log(line: string): void {
    this.opts.log?.(line);
  }

  private runEvents(active: ActiveRun): RunEvents {
    const stage = (id: string) => IDEA_STAGES.find((item) => item.id === id);
    const name = (provider: ProviderId) => DISPLAY_NAME[provider] ?? provider;
    return {
      onStageStart: (id) => {
        this.log(`⏳ ${stage(id)?.label ?? id}`);
        active.bus.emit({ t: 'stage', id, label: stage(id)?.label ?? id, status: 'running' });
      },
      onStageEnd: (id, status) => {
        active.bus.emit({ t: 'stage', id, label: stage(id)?.label ?? id, status });
        if (id === 'S7') void this.refreshCounters(active);
      },
      onCallStart: (provider, callStage, category, replayed) => {
        active.inflight.set(`${provider}:${callStage}`, { category, replayed });
        this.log(`   → ${name(provider)} · ${category}${replayed ? ' (replay)' : ''}`);
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
        this.log(`   ← ${name(provider)} ${ok ? 'ok' : 'FAILED'} · ${(ms / 1000).toFixed(1)}s${replayed ? ' (replay)' : ''} · ${active.calls} calls`);
        active.bus.emit({ t: 'call', provider, stage: callStage, phase: 'end', ms, ok, category: started.category, replayed });
        if (started.category === 'repair' && !replayed) active.bus.emit({ t: 'counters', repairs: active.repairs });
      },
      clarify: async (question, options): Promise<ClarifyChoice> => {
        this.log(`⏸ awaiting your input — ${question}`);
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
    return this.gates.request(gate, key, (card) => {
      this.log(`⏸ awaiting your approval — ${title}`);
      active.bus.emit({ t: 'gate', gate: card });
    });
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
      mode: active.input.kind === 'followup'
        ? 'Follow-up · single call · no council'
        : active.input.mode === 'quick' ? 'Quick' : 'Full Council',
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

  private async finishFollowupCancelled(active: ActiveRun): Promise<void> {
    await this.finishThread(active, 'idle');
    if (!active.bus.done) {
      active.bus.emit({ t: 'receipt', receipt: this.receipt(active) });
      active.bus.emit({ t: 'done', status: 'aborted', flags: [] });
    }
  }

  private async finishFollowupFailed(active: ActiveRun, raw: string): Promise<void> {
    const message = sanitizeLocalPaths(raw);
    await this.finishThread(active, 'idle');
    await appendTurn(this.opts.runsRoot, active.threadId, { kind: 'error', message });
    if (!active.bus.done) {
      active.bus.emit({ t: 'gate', gate: { id: this.gates.gateId('attention'), kind: 'attention', title: 'Follow-up needs attention', lines: [message], fix: recoveryText(message) } });
      active.bus.emit({ t: 'receipt', receipt: this.receipt(active, [message]) });
      active.bus.emit({ t: 'done', status: 'failed', flags: [message] });
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

  private settingsView(cfg: AikiConfig, local: AikiConfig): SettingsView {
    return SettingsView.parse({
      models: { claude: cfg.models?.claude ?? null, codex: cfg.models?.codex ?? null, agy: cfg.models?.agy ?? null },
      roles: {
        ...(cfg.roles?.analyst ? { analyst: cfg.roles.analyst } : {}),
        ...(cfg.roles?.judge ? { judge: cfg.roles.judge } : {}),
        ...(cfg.roles?.verifier ? { verifier: cfg.roles.verifier } : {}),
        ...(cfg.roles?.s4 ? { s4: cfg.roles.s4 } : {}),
        ...(cfg.roles?.responder ? { responder: cfg.roles.responder } : {}),
      },
      overrides: {
        models: { claude: local.models?.claude ?? null, codex: local.models?.codex ?? null, agy: local.models?.agy ?? null },
        roles: {
          ...(local.roles?.analyst ? { analyst: local.roles.analyst } : {}),
          ...(local.roles?.judge ? { judge: local.roles.judge } : {}),
          ...(local.roles?.verifier ? { verifier: local.roles.verifier } : {}),
          ...(local.roles?.s4 ? { s4: local.roles.s4 } : {}),
          ...(local.roles?.responder ? { responder: local.roles.responder } : {}),
        },
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
