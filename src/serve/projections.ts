// Safe browser projections for `aiki serve` (HD2). The ONE rule these views enforce: nothing that
// leaves the server carries a filesystem path, cwd, runsRoot, raw prompt, or raw provider output —
// only structured, sanitized fields. Every projection is zod-validated on the way out so a shape
// drift fails loud in tests, and the leak-regression test greps whole responses for `/Users` etc.
//
// Pure mapping functions only (no I/O) so they are trivially unit-testable; the FlightDeck feeds
// them ProviderRow/SessionEntry/ThreadEntry data it already loaded.

import { z } from 'zod';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import type { ProviderRow } from '../cli/doctor.js';
import { sanitizeLocalPaths } from '../orchestration/sanitize-paths.js';

// ── Provider status ─────────────────────────────────────────────────────────

/** Status vocabulary (plan §1.1). `checking` is a client-only transient; the server never emits it. */
export const ProviderStatusKind = z.enum([
  'ready',
  'detected',
  'login_required',
  'quota_limited',
  'not_installed',
  'check_failed',
  'safety_unavailable',
]);
export type ProviderStatusKind = z.infer<typeof ProviderStatusKind>;

export const Tone = z.enum(['green', 'amber', 'red', 'neutral']);
export type Tone = z.infer<typeof Tone>;

export const ProviderStatusView = z
  .object({
    id: z.enum(['claude', 'codex', 'agy']),
    name: z.string(), // display name (never the raw `agy` binary id)
    kind: ProviderStatusKind,
    label: z.string(),
    tone: Tone,
    model: z.string().nullable(), // configured model id, or null = CLI default
    version: z.string().nullable(),
    cached: z.boolean(), // smoke state came from the ≤6h cache, not a fresh call
    fix: z.string().nullable(), // actionable recovery line when not healthy
  })
  .strict();
export type ProviderStatusView = z.infer<typeof ProviderStatusView>;

const KIND_LABEL: Record<ProviderStatusKind, string> = {
  ready: 'Ready',
  detected: 'CLI detected',
  login_required: 'Login required',
  quota_limited: 'Quota limited',
  not_installed: 'Not installed',
  check_failed: 'Connection check failed',
  safety_unavailable: 'Safety flag unavailable',
};

const KIND_TONE: Record<ProviderStatusKind, Tone> = {
  ready: 'green',
  detected: 'amber',
  login_required: 'amber',
  quota_limited: 'amber',
  not_installed: 'red',
  check_failed: 'red',
  safety_unavailable: 'red',
};

/** Map a doctor row (+ configured model) to a browser-safe status view. Green "Ready" is only ever
 *  produced by a passed smoke (fresh or cached); a detected-but-unsmoked provider stays amber. */
export function providerStatusView(row: ProviderRow, model: string | null): ProviderStatusView {
  const id = row.det.id;
  const version = row.det.version ?? null;
  const kind = statusKind(row);
  const fix = fixFor(row, kind);
  return ProviderStatusView.parse({
    id,
    name: DISPLAY_NAME[id],
    kind,
    label: KIND_LABEL[kind],
    tone: KIND_TONE[kind],
    model,
    version,
    cached: row.cached === true && kind === 'ready',
    fix,
  });
}

function statusKind(row: ProviderRow): ProviderStatusKind {
  if (row.det.status !== 'READY') return 'not_installed';
  if (row.flags && row.flags.readOnlyFlag === 'none') return 'safety_unavailable';
  const smoke = row.smoke;
  if (!smoke) return 'detected'; // detected, not yet smoke-verified
  if (smoke.ok) return 'ready';
  if (smoke.error === 'AUTH') return 'login_required';
  if (smoke.error === 'QUOTA') return 'quota_limited';
  return 'check_failed';
}

function fixFor(row: ProviderRow, kind: ProviderStatusKind): string | null {
  switch (kind) {
    case 'not_installed':
      return row.det.hint ?? 'install the CLI';
    case 'login_required':
      return `run \`${row.det.id}\` once to log in`;
    case 'quota_limited':
      return 'retry later — quota/rate limit resets on its own';
    case 'check_failed':
      return row.smoke?.detail ?? 'connection check failed';
    case 'safety_unavailable':
      return `\`${row.det.id}\` has no read-only flag — aiki will not use it`;
    default:
      return null;
  }
}

// ── Quorum ──────────────────────────────────────────────────────────────────

export const QuorumView = z.object({ ready: z.number(), total: z.number(), label: z.string(), tone: Tone }).strict();
export type QuorumView = z.infer<typeof QuorumView>;

/** Council readiness line. Before any smoke has run we say "detected · check to confirm" rather than
 *  falsely implying the council is unavailable — Ready requires a smoke pass, but detection is real. */
export function quorumView(views: ProviderStatusView[]): QuorumView {
  const total = views.length;
  const ready = views.filter((v) => v.kind === 'ready').length;
  const smokeSeen = views.some((v) => v.kind === 'ready' || v.kind === 'login_required' || v.kind === 'quota_limited' || v.kind === 'check_failed');
  const detected = views.filter((v) => v.kind !== 'not_installed').length;
  if (!smokeSeen) {
    return detected >= 2
      ? QuorumView.parse({ ready, total, label: `${detected}/3 detected · check to confirm`, tone: 'neutral' })
      : QuorumView.parse({ ready, total, label: 'council unavailable', tone: 'red' });
  }
  if (ready >= 3) return QuorumView.parse({ ready, total, label: '3/3 council ready', tone: 'green' });
  if (ready === 2) return QuorumView.parse({ ready, total, label: '2/3 degraded', tone: 'amber' });
  return QuorumView.parse({ ready, total, label: 'council unavailable', tone: 'red' });
}

// ── Threads ───────────────────────────────────────────────────────────────

export const ThreadStatusView = z.enum(['running', 'complete', 'failed', 'cancelled']);
export type ThreadStatusView = z.infer<typeof ThreadStatusView>;

export const ThreadListItemView = z
  .object({
    id: z.string(),
    title: z.string(),
    updatedAt: z.string(),
    status: ThreadStatusView,
    mode: z.string().nullable(),
    legacy: z.boolean(), // projected from the old sessions.jsonl, read-only
  })
  .strict();
export type ThreadListItemView = z.infer<typeof ThreadListItemView>;

/** Clip a title to a word boundary and strip any home-path prefix a user may have typed. */
export function threadTitle(raw: string, max = 60): string {
  const clean = sanitizeLocalPaths(raw.replace(/\s+/g, ' ').trim());
  if (clean.length <= max) return clean || 'Untitled decision';
  const clipped = clean.slice(0, max - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > max * 0.6 ? boundary : max - 1).trimEnd()}…`;
}

// ── Settings ─────────────────────────────────────────────────────────────

const ProviderIdView = z.enum(['claude', 'codex', 'agy']);

export const SettingsView = z
  .object({
    models: z.object({ claude: z.string().nullable(), codex: z.string().nullable(), agy: z.string().nullable() }).strict(),
    roles: z
      .object({
        analyst: ProviderIdView.optional(),
        judge: ProviderIdView.optional(),
        verifier: ProviderIdView.optional(),
        s4: z.array(ProviderIdView).optional(),
        responder: ProviderIdView.optional(),
      })
      .strict(),
    overrides: z
      .object({
        models: z.object({ claude: z.string().nullable(), codex: z.string().nullable(), agy: z.string().nullable() }).strict(),
        roles: z
          .object({
            analyst: ProviderIdView.optional(),
            judge: ProviderIdView.optional(),
            verifier: ProviderIdView.optional(),
            s4: z.array(ProviderIdView).optional(),
            responder: ProviderIdView.optional(),
          })
          .strict(),
      })
      .strict(),
    scope: z.string(), // "project (.aiki/config.json)" | "global (~/.aiki/config.json)" — no absolute path
  })
  .strict();
export type SettingsView = z.infer<typeof SettingsView>;

const SettingModel = z.string().trim().min(1).nullable();
const SettingRole = ProviderIdView.nullable();

export const SettingsPatch = z
  .object({
    models: z.object({ claude: SettingModel.optional(), codex: SettingModel.optional(), agy: SettingModel.optional() }).strict().optional(),
    roles: z
      .object({
        analyst: SettingRole.optional(),
        judge: SettingRole.optional(),
        verifier: SettingRole.optional(),
        s4: z.array(ProviderIdView).length(2).nullable().optional(),
        responder: SettingRole.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

// ── Live run requests + reader-safe answer ───────────────────────────────────────────

const Attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('url'), url: z.string().url() }).strict(),
]);

export const SendInput = z
  .object({
    threadId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(100_000),
    mode: z.enum(['quick', 'council']),
    kind: z.enum(['decision', 'followup']),
    attachments: z.array(Attachment).max(10),
  })
  .strict();
export type SendInput = z.infer<typeof SendInput>;

export const SendOutcome = z
  .object({ threadId: z.string(), runId: z.string(), status: z.literal('gating') })
  .strict();
export type SendOutcome = z.infer<typeof SendOutcome>;

export const DeckAction = z.discriminatedUnion('t', [
  z.object({ t: z.literal('gate'), gateId: z.string().min(1), decision: z.enum(['allow_once', 'allow_session', 'deny']) }).strict(),
  z.object({ t: z.literal('answer'), gateId: z.string().min(1), value: z.union([z.string(), z.number()]) }).strict(),
  z.object({ t: z.literal('cancel') }).strict(),
  z.object({ t: z.literal('resume') }).strict(),
]);
export type DeckAction = z.infer<typeof DeckAction>;

const SafeSection = z.object({ heading: z.string(), summary: z.string(), bullets: z.array(z.string()) }).strict();
const SafeFeature = z.object({ priority: z.string(), feature: z.string(), userValue: z.string(), rationale: z.string(), effort: z.string() }).strict();
const SafeMilestone = z.object({ order: z.number(), timebox: z.string(), outcome: z.string(), tasks: z.array(z.string()), doneWhen: z.string() }).strict();

export const ReceiptView = z
  .object({
    mode: z.string(),
    calls: z.number().int().nonnegative(),
    budget: z.number().int().positive(),
    replays: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    repairs: z.number().int().nonnegative(),
    providers: z.array(z.object({ name: z.string(), calls: z.number().int().nonnegative() }).strict()),
    warnings: z.array(z.string()),
  })
  .strict();
export type ReceiptView = z.infer<typeof ReceiptView>;

/** Explicit allowlist for the verdict card. No graph ids, schema enums, paths, or audit rows fit. */
export const SafeReportProjection = z
  .object({
    runId: z.string(),
    verdict: z.object({ tone: z.enum(['go', 'conditions', 'stop', 'inconclusive']), label: z.string() }).strict(),
    headline: z.string(),
    bottomLine: z.string(),
    sections: z.array(SafeSection),
    warnings: z.array(z.string()),
    caveats: z.array(z.string()),
    features: z.array(SafeFeature),
    milestones: z.array(SafeMilestone),
    sources: z.array(z.object({ label: z.string(), url: z.string().url().optional(), citedFor: z.array(z.string()) }).strict()),
    nextStep: z.string(),
    receipt: ReceiptView,
  })
  .strict();
export type SafeReportProjection = z.infer<typeof SafeReportProjection>;

// ── Workspace snapshot (GET /api/bootstrap) ─────────────────────────────────

export const WorkspaceSnapshot = z
  .object({
    version: z.string(),
    providers: z.array(ProviderStatusView),
    quorum: QuorumView,
    threads: z.array(ThreadListItemView),
    settings: SettingsView,
  })
  .strict();
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;

export const ThreadDetail = z
  .object({
    id: z.string(),
    title: z.string(),
    legacy: z.boolean(),
    resumeRunId: z.string().nullable(),
    turns: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('report_md'), markdown: z.string() }).strict(),
        z.object({ kind: z.literal('note'), text: z.string() }).strict(),
        z.object({ kind: z.literal('user_message'), text: z.string(), attachments: z.array(z.string()), mode: z.string() }).strict(),
        z.object({ kind: z.literal('report'), report: SafeReportProjection }).strict(),
        z.object({
          kind: z.literal('followup'), question: z.string(), answer: z.string(), provider: ProviderIdView,
          providerName: z.string(), label: z.string(), callMs: z.number().nonnegative(),
        }).strict(),
      ]),
    ),
  })
  .strict();
export type ThreadDetail = z.infer<typeof ThreadDetail>;

const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex', 'agy'];

/** Stable provider display order (Claude · Codex · Gemini) regardless of check completion order. */
export function orderProviders(views: ProviderStatusView[]): ProviderStatusView[] {
  return [...views].sort((a, b) => PROVIDER_ORDER.indexOf(a.id) - PROVIDER_ORDER.indexOf(b.id));
}
