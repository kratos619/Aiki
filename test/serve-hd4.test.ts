// HD4 acceptance — one-call follow-ups, re-convene, and replay-based resume.
// Every provider/engine seam is injected; these tests never invoke a real CLI.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AikiConfig } from '../src/config/config.js';
import type { ProviderHandle } from '../src/orchestration/context.js';
import { SafeReportProjection } from '../src/serve/projections.js';
import { DeckError, FlightDeck, type FlightDeckOpts } from '../src/serve/flight-deck.js';
import { runFollowup } from '../src/serve/followup.js';
import { appendThread, appendTurn, readThreads, readTurns } from '../src/serve/threads.js';

type Runner = NonNullable<FlightDeckOpts['runner']>;
type FollowupRunner = NonNullable<FlightDeckOpts['followupRunner']>;

describe('HD4 follow-up chat', () => {
  let root: string;
  let home: string;
  const previousHome = process.env.AIKI_HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-hd4-'));
    home = await mkdtemp(join(tmpdir(), 'aiki-hd4-home-'));
    process.env.AIKI_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('uses one read-only adapter call and defaults the responder to the judge', async () => {
    const adapterRun = vi.fn(async () => ({ ok: true as const, text: 'Use the smaller pilot.', durationMs: 42 }));
    const handle: ProviderHandle = {
      id: 'codex',
      adapter: { id: 'codex', run: adapterRun },
      flags: { id: 'codex', jsonOutput: true, readOnlyFlag: 'sandbox', model: 'gpt-test' },
      readOnly: 'sandbox',
      version: 'test',
    };
    const report = SafeReportProjection.parse({
      runId: 'run-1', verdict: { tone: 'conditions', label: 'Proceed with conditions' },
      headline: 'Pilot before committing', bottomLine: 'Evidence supports a bounded trial.', sections: [],
      warnings: [], caveats: [], features: [], milestones: [], sources: [], nextStep: 'Define the pilot.',
      receipt: { mode: 'Full Council', calls: 8, budget: 12, replays: 0, durationMs: 100, repairs: 0, providers: [], warnings: [] },
    });

    const result = await runFollowup(
      { question: 'What should we do first?', report, config: { roles: { judge: 'codex' } } },
      { setupProviders: async () => [handle], cwd: root },
    );

    expect(result).toEqual({ provider: 'codex', answer: 'Use the smaller pilot.', callMs: 42 });
    expect(adapterRun).toHaveBeenCalledTimes(1);
    expect(adapterRun.mock.calls[0]![0]).toMatchObject({ expectJson: false, readOnly: true, research: false, cwd: root });
    expect(adapterRun.mock.calls[0]![0].prompt).toContain('What should we do first?');
    expect(adapterRun.mock.calls[0]![0].prompt).toContain('Pilot before committing');
  });

  it('appends a labeled single-call reply, then re-convenes through the normal decision flow', async () => {
    const seeded = await seedCompletedThread(root);
    const followupRunner: FollowupRunner = vi.fn(async ({ onCallStart, onCallEnd }) => {
      onCallStart?.('agy');
      onCallEnd?.('agy', 73, true);
      return { provider: 'agy', answer: 'Start with /Users/gaurav/private/hosted-replay.', callMs: 73 };
    });
    const decisionRunner: Runner = vi.fn();
    const deck = new FlightDeck({
      runsRoot: root,
      version: 'test',
      runner: decisionRunner,
      followupRunner,
      snapshotUrls: async () => ({ sources: [] }),
    });

    const sent = await deck.send({
      threadId: seeded.threadId,
      text: 'What is the first demo step?',
      mode: 'quick',
      kind: 'followup',
      attachments: [],
    });
    const frames = await drive(deck, sent.runId, 'allow_once');

    expect(followupRunner).toHaveBeenCalledTimes(1);
    expect(frames.find((frame) => frame.t === 'turn' && frame.turn.kind === 'followup')).toMatchObject({
      turn: { provider: 'agy', providerName: 'Gemini', answer: 'Start with ~/private/hosted-replay.', label: 'follow-up · Gemini · 1 call · no council' },
    });
    expect(JSON.stringify(frames)).not.toContain('/Users/');
    expect(frames.filter((frame) => frame.t === 'call' && frame.phase === 'end')).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ t: 'done', status: 'ok' });

    const persisted = (await readTurns(root, seeded.threadId)).at(-1);
    expect(persisted).toMatchObject({ kind: 'followup', question: 'What is the first demo step?', provider: 'agy', call_ms: 73 });
    const detail = await deck.thread(seeded.threadId);
    expect(detail?.turns.at(-1)).toMatchObject({ kind: 'followup', label: 'follow-up · Gemini · 1 call · no council' });

    const reconvened = await deck.send({
      threadId: seeded.threadId,
      text: 'Re-evaluate that answer with the full council.',
      mode: 'council',
      kind: 'decision',
      attachments: [],
    });
    expect(reconvened.threadId).toBe(seeded.threadId);
    await drive(deck, reconvened.runId, 'deny');
    expect(decisionRunner).not.toHaveBeenCalled();
  });

  it('rejects follow-up before a completed run with a friendly composer hint', async () => {
    const now = new Date().toISOString();
    await appendThread(root, { id: 'empty-thread', title: 'No answer yet', created_at: now, updated_at: now, status: 'idle', run_ids: [] });
    const followupRunner: FollowupRunner = vi.fn();
    const deck = new FlightDeck({ runsRoot: root, version: 'test', followupRunner });

    await expect(deck.send({ threadId: 'empty-thread', text: 'And then?', mode: 'quick', kind: 'followup', attachments: [] }))
      .rejects.toMatchObject<Partial<DeckError>>({ status: 400, message: expect.stringContaining('Convene a decision first') });
    expect(followupRunner).not.toHaveBeenCalled();
  });

  it('resumes a failed run into a fresh run with cached calls', async () => {
    const oldRunId = '20260718-1200-idea-refinement-dead';
    const now = new Date().toISOString();
    await appendThread(root, { id: 'resume-thread', title: 'Resume me', created_at: now, updated_at: now, status: 'failed', run_ids: [oldRunId] });
    await appendTurn(root, 'resume-thread', { kind: 'user_message', text: 'Should we ship?', attachments: [], mode: 'council' });
    await appendTurn(root, 'resume-thread', { kind: 'run_ref', run_id: oldRunId, mode: 'council' });
    await seedFailedRun(root, oldRunId);
    const reportFixture = await readFile(join(process.cwd(), 'test/fixtures/c289/10-decision-report.json'), 'utf8');
    const runner: Runner = vi.fn(async (_workflow, _input, opts = {}) => {
      const dir = join(root, 'runs', opts.runId!);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '10-decision-report.json'), reportFixture, 'utf8');
      return { ok: true, aborted: false, runId: opts.runId!, dir, callCount: 0 };
    });
    const deck = new FlightDeck({ runsRoot: root, version: 'test', runner });

    const resumed = await deck.act(oldRunId, { t: 'resume' });
    expect(resumed).toMatchObject({ threadId: 'resume-thread', status: 'gating' });
    expect(resumed?.runId).not.toBe(oldRunId);
    const frames = await drive(deck, resumed!.runId, 'allow_once');

    expect(frames.find((frame) => frame.t === 'gate')).toMatchObject({ gate: { kind: 'resume' } });
    expect(runner).toHaveBeenCalledWith('idea-refinement', 'Should we ship?', expect.objectContaining({
      resumedFrom: oldRunId,
      replay: expect.any(Map),
    }));
    expect((runner.mock.calls[0]![2]?.replay as Map<string, string>).size).toBe(1);
    expect((await readThreads(root)).find((thread) => thread.id === 'resume-thread')?.status).toBe('idle');
  });

  it('keeps old role configs valid while accepting the optional responder', () => {
    expect(AikiConfig.safeParse({ roles: { judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] } }).success).toBe(true);
    expect(AikiConfig.safeParse({ roles: { responder: 'agy' } }).success).toBe(true);
  });
});

async function seedCompletedThread(root: string) {
  const threadId = 'thread-complete';
  const runId = '20260718-1100-idea-refinement-done';
  const now = new Date().toISOString();
  await appendThread(root, { id: threadId, title: 'Workspace decision', created_at: now, updated_at: now, status: 'idle', run_ids: [runId] });
  await appendTurn(root, threadId, { kind: 'user_message', text: 'Should we build the workspace?', attachments: [], mode: 'council' });
  await appendTurn(root, threadId, { kind: 'run_ref', run_id: runId, mode: 'council' });
  const dir = join(root, 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '10-decision-report.json'), await readFile(join(process.cwd(), 'test/fixtures/c289/10-decision-report.json')), 'utf8');
  return { threadId, runId };
}

async function seedFailedRun(root: string, runId: string) {
  const dir = join(root, 'runs', runId);
  await mkdir(join(dir, 'inputs'), { recursive: true });
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'inputs', 'idea.md'), 'Should we ship?', 'utf8');
  await writeFile(join(dir, 'raw', 'S0-claude-1.prompt.txt'), 'prompt', 'utf8');
  await writeFile(join(dir, 'raw', 'S0-claude-1.out'), 'answer', 'utf8');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    run_id: runId,
    workflow: 'idea-refinement',
    mode: 'council',
    provider_versions: {},
    flag_profiles: {},
    roles: {},
    read_only: {},
    calls: [],
    call_count: 0,
    budget: { limit: 12, used: 0 },
    receipt: { discovery: 0, verification: 0, repair: 0, planning: 0 },
    exit_status: 'failed',
    aborted: false,
  }), 'utf8');
}

async function drive(deck: FlightDeck, runId: string, decision: 'allow_once' | 'deny') {
  const frames: any[] = [];
  for await (const frame of deck.frames(runId)) {
    frames.push(frame);
    if (frame.t === 'gate' && frame.gate.scopes) {
      await deck.act(runId, { t: 'gate', gateId: frame.gate.id, decision });
    }
  }
  return frames;
}
