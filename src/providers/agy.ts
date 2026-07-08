import type { Adapter, AdapterSpec, FlagProfile, RunRequest } from './types.js';
import { runAdapter } from './adapter-core.js';

/**
 * Antigravity CLI (`agy`, runs Gemini 3.1 Pro) — replaces the discontinued gemini CLI.
 * Invocation (verified live, T2):
 *   agy -p "<prompt>" [--sandbox]
 * No JSON-output flag: `-p` prints the model's response as raw text, so when we ask for JSON
 * the response *is* the JSON → §14 extraction parses it directly (no envelope to strip).
 * Read-only is best-effort via `--sandbox` (terminal restrictions); write-blocking is
 * UNVERIFIED — see docs/PROVIDER_NOTES.md, to be pinned down at T10 (code-review).
 * NEVER pass --dangerously-skip-permissions (§19).
 */
const agySpec: AdapterSpec = {
  id: 'agy',
  buildArgs(req: RunRequest, flags: FlagProfile): string[] {
    const args = ['-p', req.prompt];
    if (req.readOnly !== false && flags.readOnlyFlag === 'sandbox') args.push('--sandbox');
    if (flags.model) args.push('--model', flags.model); // V8: verified `agy --model <id>` (ids may contain spaces — one argv elem)
    return args;
  },
  extractText(stdout: string): string {
    return stdout; // raw text; §14 extraction handles whole/fenced/balanced JSON
  },
};

export const agy: Adapter = {
  id: 'agy',
  run: (req, flags, deps) => runAdapter(agySpec, req, flags, deps),
};
