// S1 — intent contract (§9, §13). Analyst normalizes the raw request into a typed IntentContract.
// Failure handling (§9): invalid JSON → one repair retry (in jsonCall) → StageError('BAD_OUTPUT'),
// which aborts the run with a message.

import { IntentContract } from '../../schemas/index.js';
import type { RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

// §13 S1 prompt, verbatim.
const S1_PROMPT = `You are the intake analyst for a professional multi-model orchestration system.
Read the user's request below. Produce ONLY a JSON object matching this schema, nothing else:

{"task": "<one-paragraph normalized restatement>",
 "task_type": "idea-refinement|code-review|other",
 "constraints": ["<explicit constraints stated by the user>"],
 "unknowns": ["<things the request leaves unspecified>"],
 "success_criteria": ["<what a good final output must contain>"]}

Rules: do not answer the request. Do not add constraints the user did not state.
USER REQUEST:
{{RAW_INPUT}}`;

export async function s1Intent(ctx: RunCtx, rawInput: string): Promise<IntentContract> {
  const analyst = ctx.handle(ctx.roles.analyst);
  const prompt = S1_PROMPT.replace('{{RAW_INPUT}}', rawInput);
  const contract = await jsonCall(ctx, analyst, 'S1', prompt, IntentContract);
  await ctx.writer.writeJson('intent-contract', contract);
  return contract;
}
