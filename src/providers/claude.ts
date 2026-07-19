import type { Adapter, AdapterSpec, FlagProfile, NormalizedUsage, ProviderError, RunRequest } from './types.js';
import { runAdapter } from './adapter-core.js';

/** Only accept a finite non-negative number; anything else → undefined (field omitted). */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

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
    if (flags.model) args.push('--model', flags.model); // V8: verified `claude --model <alias|name>`
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
  usage(stdout: string): NormalizedUsage | undefined {
    const env = envelope(stdout);
    if (!env) return undefined;
    const u = (env.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      estimated: false,
      reportedCostUsd: num(env.total_cost_usd),
    };
  },
};

export const claude: Adapter = {
  id: 'claude',
  run: (req, flags, deps) => runAdapter(claudeSpec, req, flags, deps),
};
