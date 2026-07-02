// Shared helper for stages whose provider output is schema-validated JSON (§14).
//
// Flow: call provider (expectJson) → the adapter already did its ONE transient retry + §14
// extraction → here we zod-validate the extracted JSON. On a *validation* failure we do the §14
// repair retry: resend to the SAME provider with the zod error and a "corrected JSON only"
// instruction, exactly once. A second failure → StageError('BAD_OUTPUT'), which the stage turns
// into its §9 failure handling (S1/S3 abort the run).

import type { z } from 'zod';
import type { ProviderHandle, RunCtx } from './context.js';
import { StageError } from './context.js';

export async function jsonCall<T>(
  ctx: RunCtx,
  handle: ProviderHandle,
  stage: string,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const first = await ctx.call(handle, { prompt, expectJson: true }, stage);
  if (!first.ok) {
    // AUTH/QUOTA/NOT_FOUND fail fast; TIMEOUT/CRASH/BAD_OUTPUT were already retried once by the adapter.
    throw new StageError(stage, first.error, `provider ${handle.id} call failed (${first.error})`);
  }

  const parsed = schema.safeParse(first.json);
  if (parsed.success) return parsed.data;

  // §14 repair retry — one attempt, same provider.
  const repairPrompt =
    `${prompt}\n\n---\nYour previous output failed validation:\n${zodMessage(parsed.error)}\n` +
    `Output ONLY the corrected JSON, nothing else.`;
  const second = await ctx.call(handle, { prompt: repairPrompt, expectJson: true }, `${stage}-repair`);
  if (!second.ok) {
    throw new StageError(stage, second.error, `repair retry failed (${second.error})`);
  }
  const reparsed = schema.safeParse(second.json);
  if (reparsed.success) return reparsed.data;

  throw new StageError(stage, 'BAD_OUTPUT', `output failed validation after repair: ${zodMessage(reparsed.error)}`);
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}
