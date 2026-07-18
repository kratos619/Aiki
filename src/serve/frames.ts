// Deck telemetry stream for a live run (plan §3.2). Frames are strictly seq-ordered structured
// events — NEVER model prose, raw prompts, or paths (the report projection is the only text that
// crosses, and it is sanitized separately). The FrameBus keeps a ring buffer (last 500) so an SSE
// reconnect can replay everything after the client's Last-Event-ID, plus a reduced snapshot so a
// fresh connection gets the current state in one `hello` frame.

import type { ProviderId } from '../providers/types.js';
import type { CallCategory } from '../orchestration/modes.js';
import type { StageStatus } from '../tui/timeline.js';
import { z } from 'zod';
import { ReceiptView, type ReceiptView as ReceiptViewT } from './projections.js';
import { GateCardViewSchema, type GateCardView } from './gates.js';

export type RunLifecycle = 'gating' | 'running' | 'done' | 'failed' | 'aborted';

export interface StageRow {
  id: string;
  label: string;
  status: StageStatus;
  seat: ProviderId | null;
}

export interface DeckCounters {
  positions: number;
  evidence: number;
  disagreements: number;
  repairs: number;
}

export interface RunSnapshot {
  runId: string;
  mode: string;
  status: RunLifecycle;
  stages: StageRow[];
  calls: { used: number; budget: number; byProvider: Partial<Record<ProviderId, number>>; replays: number };
  counters: DeckCounters;
  gates: GateCardView[];
  flags: string[];
  lastSeq: number;
}

export type DeckFrameBody =
  | { t: 'stage'; id: string; label: string; status: StageStatus; seat?: ProviderId }
  | { t: 'call'; provider: ProviderId; stage: string; phase: 'start' | 'end'; ms?: number; ok?: boolean; category: CallCategory; replayed: boolean }
  | { t: 'counters'; positions?: number; evidence?: number; disagreements?: number; repairs?: number }
  | { t: 'gate'; gate: GateCardView }
  | { t: 'gate_resolved'; gateId: string; summary: string }
  | { t: 'turn'; turn: { kind: 'user_message'; text: string; attachments: string[]; mode: string } }
  | { t: 'report_ready'; runId: string }
  | { t: 'receipt'; receipt: ReceiptViewT }
  | { t: 'done'; status: 'ok' | 'failed' | 'aborted'; flags: string[] };

export type DeckFrame = { seq: number } & DeckFrameBody;
export type HelloFrame = { seq: number; t: 'hello'; snapshot: RunSnapshot };

const Provider = z.enum(['claude', 'codex', 'agy']);
const StageStatusView = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
const CallCategoryView = z.enum(['discovery', 'verification', 'repair', 'planning']);
const StageRowSchema = z.object({ id: z.string(), label: z.string(), status: StageStatusView, seat: Provider.nullable() }).strict();
const RunSnapshotSchema = z.object({
  runId: z.string(), mode: z.string(), status: z.enum(['gating', 'running', 'done', 'failed', 'aborted']),
  stages: z.array(StageRowSchema),
  calls: z.object({ used: z.number().int().nonnegative(), budget: z.number().int().positive(), byProvider: z.record(Provider, z.number().int().nonnegative()), replays: z.number().int().nonnegative() }).strict(),
  counters: z.object({ positions: z.number().int().nonnegative(), evidence: z.number().int().nonnegative(), disagreements: z.number().int().nonnegative(), repairs: z.number().int().nonnegative() }).strict(),
  gates: z.array(GateCardViewSchema), flags: z.array(z.string()), lastSeq: z.number().int().nonnegative(),
}).strict();

const DeckFrameBodySchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('stage'), id: z.string(), label: z.string(), status: StageStatusView, seat: Provider.optional() }).strict(),
  z.object({ t: z.literal('call'), provider: Provider, stage: z.string(), phase: z.enum(['start', 'end']), ms: z.number().nonnegative().optional(), ok: z.boolean().optional(), category: CallCategoryView, replayed: z.boolean() }).strict(),
  z.object({ t: z.literal('counters'), positions: z.number().int().nonnegative().optional(), evidence: z.number().int().nonnegative().optional(), disagreements: z.number().int().nonnegative().optional(), repairs: z.number().int().nonnegative().optional() }).strict(),
  z.object({ t: z.literal('gate'), gate: GateCardViewSchema }).strict(),
  z.object({ t: z.literal('gate_resolved'), gateId: z.string(), summary: z.string() }).strict(),
  z.object({ t: z.literal('turn'), turn: z.object({ kind: z.literal('user_message'), text: z.string(), attachments: z.array(z.string()), mode: z.string() }).strict() }).strict(),
  z.object({ t: z.literal('report_ready'), runId: z.string() }).strict(),
  z.object({ t: z.literal('receipt'), receipt: ReceiptView }).strict(),
  z.object({ t: z.literal('done'), status: z.enum(['ok', 'failed', 'aborted']), flags: z.array(z.string()) }).strict(),
]);
export const DeckFrameSchema = z.object({ seq: z.number().int().positive() }).passthrough().transform((value, ctx) => {
  const { seq, ...body } = value;
  const parsed = DeckFrameBodySchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }
  return { seq, ...parsed.data };
});
export const HelloFrameSchema = z.object({ seq: z.number().int().nonnegative(), t: z.literal('hello'), snapshot: RunSnapshotSchema }).strict();

const RING = 500;

export class FrameBus {
  private seq = 0;
  private readonly buffer: DeckFrame[] = [];
  private readonly listeners = new Set<(f: DeckFrame) => void>();
  private snapshot: RunSnapshot;
  private closed = false;

  constructor(runId: string, mode: string, stages: StageRow[], budget: number) {
    this.snapshot = {
      runId,
      mode,
      status: 'gating',
      stages: stages.map((s) => ({ ...s })),
      calls: { used: 0, budget, byProvider: {}, replays: 0 },
      counters: { positions: 0, evidence: 0, disagreements: 0, repairs: 0 },
      gates: [],
      flags: [],
      lastSeq: 0,
    };
  }

  /** Assign a seq, fold the frame into the snapshot, buffer it, and wake any live subscribers. */
  emit(body: DeckFrameBody): DeckFrame {
    const frame = DeckFrameSchema.parse({ seq: ++this.seq, ...body }) as DeckFrame;
    this.reduce(frame);
    this.snapshot.lastSeq = frame.seq;
    this.buffer.push(frame);
    if (this.buffer.length > RING) this.buffer.shift();
    for (const cb of this.listeners) cb(frame);
    return frame;
  }

  helloFrame(atSeq = this.snapshot.lastSeq): HelloFrame {
    return HelloFrameSchema.parse({ seq: atSeq, t: 'hello', snapshot: structuredClone(this.snapshot) }) as HelloFrame;
  }

  /** Buffered frames strictly after `lastSeq` (SSE reconnect via Last-Event-ID). */
  replaySince(lastSeq: number): DeckFrame[] {
    return this.buffer.filter((f) => f.seq > lastSeq);
  }

  get done(): boolean {
    return this.snapshot.status === 'done' || this.snapshot.status === 'failed' || this.snapshot.status === 'aborted';
  }

  get latestSeq(): number {
    return this.seq;
  }

  setLifecycle(status: RunLifecycle): void {
    this.snapshot.status = status;
  }

  /** Register a synchronous live-frame listener; returns an unsubscribe. Registering before reading
   *  the snapshot/replay is what makes an SSE (re)connect lossless — see the server's events route. */
  listen(cb: (f: DeckFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private reduce(frame: DeckFrame): void {
    const s = this.snapshot;
    switch (frame.t) {
      case 'stage': {
        const row = s.stages.find((r) => r.id === frame.id);
        if (row) {
          row.status = frame.status;
          if (frame.seat) row.seat = frame.seat;
        } else {
          s.stages.push({ id: frame.id, label: frame.label, status: frame.status, seat: frame.seat ?? null });
        }
        if (s.status === 'gating') s.status = 'running';
        break;
      }
      case 'call': {
        if (frame.phase === 'end') {
          if (frame.replayed) s.calls.replays++;
          else {
            s.calls.used++;
            s.calls.byProvider[frame.provider] = (s.calls.byProvider[frame.provider] ?? 0) + 1;
            if (frame.category === 'repair') s.counters.repairs++;
          }
        }
        break;
      }
      case 'counters': {
        if (frame.positions !== undefined) s.counters.positions = frame.positions;
        if (frame.evidence !== undefined) s.counters.evidence = frame.evidence;
        if (frame.disagreements !== undefined) s.counters.disagreements = frame.disagreements;
        if (frame.repairs !== undefined) s.counters.repairs = frame.repairs;
        break;
      }
      case 'gate':
        s.gates.push(frame.gate);
        break;
      case 'gate_resolved':
        s.gates = s.gates.filter((g) => g.id !== frame.gateId);
        break;
      case 'done':
        s.status = frame.status === 'ok' ? 'done' : frame.status;
        s.flags = frame.flags;
        break;
      default:
        break;
    }
  }
}

export function encodeSse(frame: HelloFrame | DeckFrame): string {
  const parsed = frame.t === 'hello' ? HelloFrameSchema.parse(frame) : DeckFrameSchema.parse(frame);
  return `id: ${parsed.seq}\ndata: ${JSON.stringify(parsed)}\n\n`;
}
