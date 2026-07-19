// Approval + input gates for a live run (plan §1.3). Everything approvable here is aiki-owned and so
// genuinely enforceable server-side: the engine awaits a resolved decision before it spends. Two
// families share one table:
//   - permission gates (spend/file/url/blocked/resume) resolve to allow_once | allow_session | deny;
//   - input gates (clarify/grill) resolve to the user's typed answer, reusing the engine's existing
//     RunEvents.clarify/grill promise seams.
// "Allow for this session" grants a kind+detail-keyed allowance held in memory that dies with the
// server, so an identical later gate is auto-approved and never shown twice.

import { z } from 'zod';

export const GateKind = z.enum(['spend', 'file', 'url', 'blocked', 'resume', 'clarify', 'grill', 'attention']);
export type GateKind = z.infer<typeof GateKind>;
export const GateDecision = z.enum(['allow_once', 'allow_session', 'deny']);
export type GateDecision = z.infer<typeof GateDecision>;

export const GateCardViewSchema = z.object({
  id: z.string().min(1),
  kind: GateKind,
  title: z.string().min(1),
  lines: z.array(z.string()),
  scopes: z.array(GateDecision).optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  allowText: z.boolean().optional(),
  questions: z.array(z.object({ id: z.string(), prompt: z.string() }).strict()).optional(),
  fix: z.string().optional(),
}).strict();
export type GateCardView = z.infer<typeof GateCardViewSchema>;

interface Pending {
  gate: GateCardView;
  key?: string; // session-allowance key (permission gates)
  resolve: (value: unknown) => void;
}

export class GateTable {
  private readonly pending = new Map<string, Pending>();
  private readonly allowances = new Set<string>();
  private counter = 0;

  gateId(kind: GateKind): string {
    return `g${++this.counter}-${kind}`;
  }

  /** True if a session allowance already covers this kind+detail (permission gate auto-approves). */
  covered(key: string): boolean {
    return this.allowances.has(key);
  }

  /** Register a pending gate; `onOpen` emits its frame. Resolves when `resolve` is called (or, for a
   *  permission gate whose `key` is already allowed for the session, immediately as allow_session). */
  request<T>(gate: GateCardView, key: string | undefined, onOpen: (g: GateCardView) => void): Promise<T> {
    if (key && this.allowances.has(key)) return Promise.resolve('allow_session' as unknown as T);
    return new Promise<T>((resolve) => {
      const parsed = GateCardViewSchema.parse(gate);
      this.pending.set(gate.id, { gate: parsed, key, resolve: resolve as (v: unknown) => void });
      onOpen(parsed);
    });
  }

  get(gateId: string): GateCardView | undefined {
    return this.pending.get(gateId)?.gate;
  }

  /** Resolve a pending gate by id. For permission gates, an allow_session decision grants the
   *  allowance so identical later gates skip the card. Returns false if the gate isn't pending
   *  (a forged/duplicate action → the caller returns 409). */
  resolve(gateId: string, value: unknown): boolean {
    const entry = this.pending.get(gateId);
    if (!entry) return false;
    this.pending.delete(gateId);
    if (value === 'allow_session' && entry.key) this.allowances.add(entry.key);
    entry.resolve(value);
    return true;
  }

  /** Deny every still-pending gate (run cancelled/torn down) so no awaiting stage hangs. */
  denyAll(): void {
    for (const [, entry] of this.pending) entry.resolve('deny');
    this.pending.clear();
  }
}

/** Stable session-allowance key for a permission gate: same kind + same target = same key. */
export function allowanceKey(kind: GateKind, detail: string): string {
  return `${kind}:${detail}`;
}
