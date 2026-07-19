// Provider layer types.
//
// NOTE: the third provider is `agy` (Antigravity CLI, runs Gemini 3.1 Pro). It replaces the
// discontinued `gemini` CLI referenced throughout the plan — wherever the plan says "gemini",
// it now means `agy`. See docs/PROVIDER_NOTES.md.

export type ProviderId = 'claude' | 'codex' | 'agy';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'agy'];

/**
 * User-facing display names. Internally (ids, artifacts, meta.json, logs) we always use the
 * true id — `agy` — for audit accuracy. The UI shows the familiar model name instead: users
 * know "Gemini", not the Antigravity binary. Command/binary references (e.g. "run `agy`") must
 * still use the real id.
 */
export const DISPLAY_NAME: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Gemini',
};

/** Result of a raw metadata invocation (detection/probe). The seam T1 tests mock. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean; // binary not on PATH (ENOENT)
}

export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export type DetectStatus = 'READY' | 'NOT_INSTALLED';

export interface Detection {
  id: ProviderId;
  status: DetectStatus;
  version?: string;
  hint?: string; // actionable fix when not installed
}

/** How read-only is enforced for a provider, per its actual probed flags (§19). */
export type ReadOnlyFlag = 'plan' | 'sandbox' | 'none';

export interface FlagProfile {
  id: ProviderId;
  jsonOutput: boolean; // has a structured JSON-output flag (claude: --output-format json)
  readOnlyFlag: ReadOnlyFlag;
  model?: string; // V8: user-chosen model id from config; passed to the CLI as `--model <id>`. Absent = CLI default.
}

// ── Adapter run() layer (§7.1) ──────────────────────────────────────────────

export type ProviderError = 'NOT_FOUND' | 'AUTH' | 'QUOTA' | 'TIMEOUT' | 'BAD_OUTPUT' | 'CRASH';

/** Per-call token accounting (mirrors schemas NormalizedUsageSchema). estimated:true = local chars/4. */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimated: boolean;
  reportedCostUsd?: number;
}

export interface RunRequest {
  prompt: string; // full composed prompt (role preamble already prepended)
  cwd: string; // working directory (repo root for code-review)
  timeoutMs: number; // per-call hard timeout; default 180_000
  expectJson: boolean; // apply §14 JSON extraction when true
  readOnly?: boolean; // default true — pass the provider's read-only flag (§19)
  research?: boolean; // R6: verified provider-native investigation; currently Codex --search only
  inputFiles?: string[]; // large inputs passed by path reference, never via stdin
  signal?: AbortSignal; // Ctrl+C (T8): aborts the in-flight process-tree; undefined = headless
}

export type RunResultAdapter =
  | { ok: true; text: string; json?: unknown; durationMs: number; providerMeta?: Record<string, unknown>; usage?: NormalizedUsage }
  | { ok: false; error: ProviderError; stderrTail: string; durationMs: number };

/** Raw process result from spawnCapture — full stdout via fd-redirect (avoids §PROVIDER_NOTES 8KB truncation). */
export interface RawResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string; // tail-capped
  timedOut: boolean;
  notFound: boolean;
  durationMs: number;
}

export interface SpawnOpts {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal; // abort → SIGKILL the process group (same machinery as the timeout)
}

export type SpawnCaptureFn = (bin: string, args: string[], opts: SpawnOpts) => Promise<RawResult>;

/** Provider-specific behavior; the shared run/retry/classify logic lives in adapter-core. */
export interface AdapterSpec {
  id: ProviderId;
  buildArgs(req: RunRequest, flags: FlagProfile): string[];
  /** Pull the model's result text out of raw stdout (strip provider envelope if any). */
  extractText(stdout: string): string;
  /** Optional: detect a model-level error signalled inside the envelope (e.g. claude is_error). */
  envelopeError?(stdout: string): ProviderError | undefined;
  /** Optional: structured metadata from the envelope (cost, session id, usage). */
  meta?(stdout: string): Record<string, unknown> | undefined;
  /** Optional: provider-reported token accounting (estimated:false). Undefined → A3 estimate. */
  usage?(stdout: string, stderr: string): NormalizedUsage | undefined;
}

export interface Adapter {
  id: ProviderId;
  run(req: RunRequest, flags: FlagProfile, deps?: { spawn?: SpawnCaptureFn }): Promise<RunResultAdapter>;
}

export interface Smoke {
  ok: boolean;
  error?: ProviderError;
  nonce: string;
  echoed?: string;
  durationMs: number;
  detail?: string;
}
