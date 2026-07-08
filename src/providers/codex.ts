import type { Adapter, AdapterSpec, FlagProfile, RunRequest } from './types.js';
import { runAdapter } from './adapter-core.js';

/**
 * Codex CLI (`codex`). Invocation (verified live, T3):
 *   codex exec --skip-git-repo-check [-s read-only] "<prompt>"   (cwd set via spawn's cwd option)
 *
 * Output split (verified): stdout carries ONLY the model's final message; the full session
 * transcript (session id, echoed prompt, "tokens used") goes to stderr. So stdout *is* the
 * result text → §14 extraction parses it directly, no envelope. (We deliberately avoid
 * `--json` JSONL: plain stdout is already clean and needs no event-stream parsing.)
 *
 * Because codex mirrors the prompt + result into stderr, error classification must not scan
 * stderr on success — adapter-core.classify short-circuits on exit 0 for exactly this reason.
 *
 * `--skip-git-repo-check` is safe here: it only permits arbitrary cwd for run-anywhere
 * support and does not bypass approvals or the read-only sandbox.
 */
const codexSpec: AdapterSpec = {
  id: 'codex',
  buildArgs(req: RunRequest, flags: FlagProfile): string[] {
    const args = ['exec', '--skip-git-repo-check'];
    if (req.readOnly !== false && flags.readOnlyFlag === 'sandbox') args.push('-s', 'read-only');
    if (flags.model) args.push('--model', flags.model); // V8: verified `codex exec --model <id>` (before the prompt)
    args.push(req.prompt);
    return args;
  },
  extractText(stdout: string): string {
    return stdout; // clean final message; §14 extraction handles whole/fenced/balanced JSON
  },
};

export const codex: Adapter = {
  id: 'codex',
  run: (req, flags, deps) => runAdapter(codexSpec, req, flags, deps),
};
