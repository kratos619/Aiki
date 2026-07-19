// HD3 acceptance: every live frame is driven offline through an injected runner. No provider CLI
// or smoke test is invoked; the real c289 decision report pins the reader-safe projection boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlightDeck, DeckError, type FlightDeckOpts } from '../src/serve/flight-deck.js';
import { FrameBus } from '../src/serve/frames.js';
import { readThreads } from '../src/serve/threads.js';

type Runner = NonNullable<FlightDeckOpts['runner']>;

describe('HD3 live orchestration', () => {
  let root: string;
  let home: string;
  const previousHome = process.env.AIKI_HOME;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-serve-live-'));
    home = await mkdtemp(join(tmpdir(), 'aiki-serve-home-'));
    process.env.AIKI_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('scripted run drives the structured deck and returns a reader-safe verdict', async () => {
    const attachment = join(root, 'brief.md');
    await writeFile(attachment, 'User supplied evidence.', 'utf8');
    let providerCalls = 0;
    const runner: Runner = async (_workflow, _input, opts = {}) => {
      const events = opts.events!;
      const dir = join(root, 'runs', opts.runId!);
      await mkdir(dir, { recursive: true });
      events.onStageStart?.('S0');
      events.onCallStart?.('codex', 'S0-read-a', 'discovery', false);
      providerCalls++;
      events.onCallEnd?.('codex', 'S0-read-a', 25, true, false);
      await events.clarify?.('Which reading?', ['Build it now', 'Prototype first']);
      await events.grill?.({ questions: [{ id: 'Q1', question: 'What is the deadline?' }] } as any);
      events.onStageEnd?.('S0', 'done');
      events.onStageStart?.('S7');
      await writeFile(join(dir, '07-decision-graph.json'), JSON.stringify({
        positions: [{ id: 'P1' }, { id: 'P2' }], evidence: [{ id: 'E1' }],
        claims: [{ state: 'DISAGREEMENT' }, { state: 'CONSENSUS' }],
      }), 'utf8');
      events.onStageEnd?.('S7', 'done');
      events.onCallStart?.('claude', 'S9-repair', 'repair', false);
      providerCalls++;
      events.onCallEnd?.('claude', 'S9-repair', 40, true, false);
      events.onStageStart?.('S10');
      await writeFile(join(dir, '10-decision-report.json'), await readFile(join('test', 'fixtures', 'c289', '10-decision-report.json'), 'utf8'), 'utf8');
      events.onStageEnd?.('S10', 'done');
      return { ok: true, aborted: false, runId: opts.runId!, dir, callCount: providerCalls };
    };
    const deck = new FlightDeck({
      runsRoot: root, version: 'test', runner,
      validateUrl: async (url) => url,
      snapshotUrls: async () => ({ sources: [] }),
    });
    const sent = await deck.send({ text: 'Should we build the workspace?', mode: 'council', kind: 'decision', attachments: [{ kind: 'file', path: attachment }] });
    const frames = await drive(deck, sent.runId, (gate) => {
      if (gate.scopes) return { t: 'gate', gateId: gate.id, decision: 'allow_once' } as const;
      return { t: 'answer', gateId: gate.id, value: gate.kind === 'clarify' ? 1 : 'Two weeks' } as const;
    });

    expect(providerCalls).toBe(2);
    expect(new Set(frames.map((frame) => frame.t))).toEqual(new Set([
      'hello', 'turn', 'gate', 'gate_resolved', 'stage', 'call', 'counters', 'report_ready', 'receipt', 'done',
    ]));
    expect(frames.map((frame) => frame.seq)).toEqual([...frames.map((frame) => frame.seq)].sort((a, b) => a - b));
    expect(frames.at(-1)).toMatchObject({ t: 'done', status: 'ok' });

    const report = await deck.report(sent.runId);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/\bG\d+\b/);
    expect(serialized).not.toMatch(/\/(Users|home|tmp|private)\//);
    expect(serialized).not.toMatch(/ACCEPTED_WITH_CONDITIONS|MODEL_KNOWLEDGE|UNVERIFIED|TARGET_CAP|NOT_COMPUTABLE/);
    expect(report.headline.length).toBeGreaterThan(0);
    expect(report.receipt.calls).toBeGreaterThan(0);
  });

  it('spend denial makes zero provider calls', async () => {
    let providerCalls = 0;
    const runner: Runner = vi.fn(async (_workflow, _input, opts = {}) => {
      providerCalls++;
      return { ok: true, aborted: false, runId: opts.runId!, dir: '', callCount: 1 };
    });
    const deck = new FlightDeck({ runsRoot: root, version: 'test', runner, snapshotUrls: async () => ({ sources: [] }) });
    const sent = await deck.send({ text: 'A decision', mode: 'quick', kind: 'decision', attachments: [] });
    const frames = await drive(deck, sent.runId, (gate) => ({ t: 'gate', gateId: gate.id, decision: 'deny' }));
    expect(providerCalls).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(frames.at(-1)).toMatchObject({ t: 'done', status: 'aborted' });
  });

  it('allow-for-session skips the second identical file gate', async () => {
    const attachment = join(root, 'same.md');
    await writeFile(attachment, 'same material', 'utf8');
    const runner: Runner = vi.fn();
    const deck = new FlightDeck({ runsRoot: root, version: 'test', runner, snapshotUrls: async () => ({ sources: [] }) });

    const first = await deck.send({ text: 'First', mode: 'quick', kind: 'decision', attachments: [{ kind: 'file', path: attachment }] });
    const firstKinds: string[] = [];
    await drive(deck, first.runId, (gate) => {
      firstKinds.push(gate.kind);
      return { t: 'gate', gateId: gate.id, decision: gate.kind === 'file' ? 'allow_session' : 'deny' };
    });
    const second = await deck.send({ text: 'Second', mode: 'quick', kind: 'decision', attachments: [{ kind: 'file', path: attachment }] });
    const secondKinds: string[] = [];
    await drive(deck, second.runId, (gate) => {
      secondKinds.push(gate.kind);
      return { t: 'gate', gateId: gate.id, decision: 'deny' };
    });

    expect(firstKinds).toEqual(['file', 'spend']);
    expect(secondKinds).toEqual(['spend']);
    expect(runner).not.toHaveBeenCalled();
  });

  it('cancel aborts the worker and persists a cancelled thread registry entry', async () => {
    const runner: Runner = async (_workflow, _input, opts = {}) => {
      opts.events?.onStageStart?.('S0');
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, aborted: true, runId: opts.runId!, dir: '', callCount: 0, error: { code: 'ABORT', message: 'aborted' } };
    };
    const deck = new FlightDeck({ runsRoot: root, version: 'test', runner, snapshotUrls: async () => ({ sources: [] }) });
    const sent = await deck.send({ text: 'Cancel me', mode: 'quick', kind: 'decision', attachments: [] });
    let cancelled = false;
    const frames = await drive(deck, sent.runId, (gate) => ({ t: 'gate', gateId: gate.id, decision: 'allow_once' }), async (frame) => {
      if (!cancelled && frame.t === 'stage' && frame.status === 'running') {
        cancelled = true;
        await deck.act(sent.runId, { t: 'cancel' });
      }
    });
    expect(frames.at(-1)).toMatchObject({ t: 'done', status: 'aborted' });
    expect((await readThreads(root)).find((thread) => thread.id === sent.threadId)?.status).toBe('cancelled');
  });

  it('rejects a second Convene while the first run is gating', async () => {
    const deck = new FlightDeck({ runsRoot: root, version: 'test', snapshotUrls: async () => ({ sources: [] }) });
    const first = await deck.send({ text: 'First', mode: 'quick', kind: 'decision', attachments: [] });
    await expect(deck.send({ text: 'Second', mode: 'quick', kind: 'decision', attachments: [] }))
      .rejects.toMatchObject<Partial<DeckError>>({ status: 409 });
    await deck.act(first.runId, { t: 'cancel' });
    for await (const _frame of deck.frames(first.runId)) { /* drain through done */ }
  });
});

describe('FrameBus reconnect', () => {
  it('replays hello + frames after Last-Event-ID in monotonic sequence', () => {
    const bus = new FrameBus('run-1', 'council', [], 12);
    bus.emit({ t: 'stage', id: 'S0', label: 'Preflight', status: 'running' });
    bus.emit({ t: 'counters', positions: 2 });
    const replay = [bus.helloFrame(1), ...bus.replaySince(1)];
    expect(replay.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(replay[0]).toMatchObject({ t: 'hello', snapshot: { lastSeq: 2 } });
  });
});

async function drive(
  deck: FlightDeck,
  runId: string,
  actionFor: (gate: any) => any,
  onFrame?: (frame: any) => Promise<void>,
) {
  const frames: any[] = [];
  for await (const frame of deck.frames(runId)) {
    frames.push(frame);
    await onFrame?.(frame);
    if (frame.t === 'gate' && frame.gate.kind !== 'attention') await deck.act(runId, actionFor(frame.gate));
  }
  return frames;
}
