import type { Adapter, AdapterSpec, FlagProfile, ProviderError, RunRequest } from './types.js';
import { runAdapter } from './adapter-core.js';

function envelope(stdout: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdout);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code (`claude`). Invocation per §7.3:
 *   claude -p "<prompt>" [--output-format json] [--permission-mode plan]
 * `--output-format json` returns an envelope: { type, subtype, is_error, result, session_id,
 * total_cost_usd, usage, ... } — the model's text lives in `.result` (verified live, T2).
 */
const claudeSpec: AdapterSpec = {
  id: 'claude',
  buildArgs(req: RunRequest, flags: FlagProfile): string[] {
    const args = ['-p', req.prompt];
    if (req.expectJson && flags.jsonOutput) args.push('--output-format', 'json');
    if (req.readOnly !== false && flags.readOnlyFlag === 'plan') args.push('--permission-mode', 'plan');
    return args;
  },
  extractText(stdout: string): string {
    const env = envelope(stdout);
    if (env && typeof env.result === 'string') return env.result;
    return stdout; // plain mode (no --output-format) or unexpected shape
  },
  envelopeError(stdout: string): ProviderError | undefined {
    const env = envelope(stdout);
    if (env?.is_error === true) return 'CRASH'; // model-level failure signalled in the envelope
    return undefined;
  },
  meta(stdout: string): Record<string, unknown> | undefined {
    const env = envelope(stdout);
    if (!env) return undefined;
    return {
      session_id: env.session_id,
      subtype: env.subtype,
      total_cost_usd: env.total_cost_usd,
      usage: env.usage,
    };
  },
};

export const claude: Adapter = {
  id: 'claude',
  run: (req, flags, deps) => runAdapter(claudeSpec, req, flags, deps),
};
