// `aiki run <workflow> [input]` (§5) — headless run. Input is inline text or a path to a file
// (./idea.md). code-review's git-diff plumbing lands at T10; for now `run` drives idea-refinement.

import { readFile } from 'node:fs/promises';
import { run as runEngine } from '../orchestration/engine.js';
import type { WorkflowId } from '../orchestration/context.js';

const WORKFLOWS: WorkflowId[] = ['idea-refinement', 'code-review'];

/** Resolve the input arg: an existing file path → its contents, else treat the arg as inline text. */
async function resolveInput(arg: string | undefined): Promise<string | null> {
  if (!arg) return null;
  try {
    return await readFile(arg, 'utf8'); // path
  } catch {
    return arg; // inline text
  }
}

export async function runCommand(workflow: string, input: string | undefined, opts: { budget?: number } = {}): Promise<number> {
  if (!WORKFLOWS.includes(workflow as WorkflowId)) {
    process.stderr.write(`unknown workflow "${workflow}". Available: ${WORKFLOWS.join(', ')}\n`);
    return 1;
  }
  const text = await resolveInput(input);
  if (!text || !text.trim()) {
    process.stderr.write(`no input. Usage: aiki run ${workflow} "<text>"  |  aiki run ${workflow} ./file.md\n`);
    return 1;
  }

  const outcome = await runEngine(workflow as WorkflowId, text, { budget: opts.budget });

  if (outcome.ok) {
    process.stdout.write(`\n  ✔ run ${outcome.runId} complete — ${outcome.callCount} provider call(s)\n  artifacts: ${outcome.dir}\n\n`);
    return 0;
  }
  process.stderr.write(
    `\n  ✖ run ${outcome.runId} failed [${outcome.error?.code}]: ${outcome.error?.message}\n` +
      (outcome.dir ? `  partial artifacts: ${outcome.dir}\n` : '') +
      '\n',
  );
  return 1;
}
