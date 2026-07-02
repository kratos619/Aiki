// Provider layer types. T1 subset: detection + flag probe.
// The full Provider interface (smokeTest, run) lands in T2/T3.

export type ProviderId = 'claude' | 'codex' | 'gemini';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'gemini'];

/** Result of a raw process invocation. The seam T2 mocks to test parsing. */
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
export type ReadOnlyFlag = 'plan' | 'sandbox' | 'approval-plan' | 'none';

export interface FlagProfile {
  id: ProviderId;
  jsonOutput: boolean;
  readOnlyFlag: ReadOnlyFlag;
}
