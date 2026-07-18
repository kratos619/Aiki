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

/** Generic deterministic shape coercion — the §14 boundary floor for EVERY jsonCall stage.
 *  Two live failures shaped it (run 20260715-1516): the S9 chair's only defect was `dissent` as a
 *  string, and the paid repair it triggered flipped the verdict PIVOT→PWC and died on 7 conditions
 *  vs max 6. Policy:
 *  - LOSSLESS (always): a lone value where an array is expected becomes a one-element array, and an
 *    EMPTY optional min-1 string is dropped (empty carries no information — absent beats invalid;
 *    run f740's codex seat burned a 267s repair on 12 empty rationales). Runs BEFORE the paid
 *    repair — such defects cost zero extra calls.
 *  - LOSSY (`lossy: true`, last resort once the repair path is spent or disallowed): arrays beyond
 *    their schema max are truncated in order; strings beyond their max are clipped at a word
 *    boundary with a trailing ellipsis (run f740's planner died on a 173-char headline vs max 160
 *    with no repair budget).
 *  Never invents a value. The full schema still validates the result; anything else stays invalid. */
export function coerceToSchema(schema: unknown, value: unknown, lossy: boolean): unknown {
  const def = (schema as { _def?: Record<string, unknown> } | null | undefined)?._def;
  if (!def) return value;
  const kind = def.typeName as string | undefined;
  if (kind === 'ZodOptional' || kind === 'ZodNullable' || kind === 'ZodDefault' || kind === 'ZodReadonly' || kind === 'ZodCatch') {
    if (value === undefined || value === null) return value;
    const coerced = coerceToSchema(def.innerType, value, lossy);
    if (kind === 'ZodOptional' && coerced === '' && minStringLength(def.innerType) >= 1) return undefined;
    return coerced;
  }
  if (kind === 'ZodEffects') return coerceToSchema(def.schema, value, lossy); // refine/preprocess wrappers
  if (kind === 'ZodPipeline') return coerceToSchema(def.in, value, lossy);
  if (kind === 'ZodArray') {
    if (value === undefined || value === null) return value;
    const wrapped = Array.isArray(value) ? value : [value];
    const max = (def.maxLength as { value: number } | null)?.value;
    const bounded = lossy && typeof max === 'number' && wrapped.length > max ? wrapped.slice(0, max) : wrapped;
    return bounded.map((item) => coerceToSchema(def.type, item, lossy));
  }
  if (kind === 'ZodObject') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const shape = typeof def.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : (def.shape as Record<string, unknown>);
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(shape)) {
      if (key in out) out[key] = coerceToSchema(shape[key], out[key], lossy);
    }
    return out;
  }
  if (kind === 'ZodString') {
    if (!lossy || typeof value !== 'string') return value;
    const max = stringCheck(def, 'max');
    if (typeof max !== 'number' || value.length <= max) return value;
    const cut = value.slice(0, max - 1);
    const atWord = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    return `${atWord}…`;
  }
  return value;
}

function stringCheck(def: Record<string, unknown>, kind: 'min' | 'max'): number | undefined {
  const checks = def.checks as Array<{ kind: string; value?: number }> | undefined;
  const found = checks?.find((check) => check.kind === kind)?.value;
  return typeof found === 'number' ? found : undefined;
}

function minStringLength(schema: unknown): number {
  const def = (schema as { _def?: Record<string, unknown> } | null | undefined)?._def;
  if (!def) return 0;
  const kind = def.typeName as string | undefined;
  if (kind === 'ZodEffects') return minStringLength(def.schema);
  if (kind === 'ZodPipeline') return minStringLength(def.in);
  if (kind !== 'ZodString') return 0;
  return stringCheck(def, 'min') ?? 0;
}

export async function jsonCall<T>(
  ctx: RunCtx,
  handle: ProviderHandle,
  stage: string,
  prompt: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  opts: { cwd?: string; repair?: boolean; salvage?: (json: unknown) => unknown } = {},
): Promise<T> {
  // Deterministic last resort once the repair path is spent: stage-specific salvage first, then the
  // generic lossy floor (truncate over-cap arrays), then both composed. No extra provider call.
  const trySalvage = (json: unknown): T | undefined => {
    const candidates: unknown[] = [];
    if (opts.salvage) {
      const staged = opts.salvage(json);
      candidates.push(staged, coerceToSchema(schema, staged, true));
    }
    candidates.push(coerceToSchema(schema, json, true));
    for (const candidate of candidates) {
      const saved = schema.safeParse(candidate);
      if (saved.success) return saved.data;
    }
    return undefined;
  };

  const first = await ctx.call(handle, { prompt, expectJson: true, cwd: opts.cwd }, stage);
  if (!first.ok) {
    // AUTH/QUOTA/NOT_FOUND fail fast; TIMEOUT/CRASH/BAD_OUTPUT were already retried once by the adapter.
    throw new StageError(stage, first.error, `provider ${handle.id} call failed (${first.error})`);
  }

  const parsed = schema.safeParse(first.json);
  if (parsed.success) return parsed.data;
  // Lossless coercion BEFORE the paid repair: a wrappable-only defect never costs a second call
  // (and never lets the repair rewrite an already-complete answer — run 20260715-1516's verdict flip).
  const wrapped = schema.safeParse(coerceToSchema(schema, first.json, false));
  if (wrapped.success) return wrapped.data;
  if (opts.repair === false) {
    // Repair is unavailable (budget/policy) — the deterministic floor is all we have. A clipped
    // string beats a discarded artifact (run f740: complete plan lost to a 13-char overflow).
    const saved = trySalvage(first.json);
    if (saved !== undefined) return saved;
    throw new StageError(stage, 'BAD_OUTPUT', `output failed validation: ${zodMessage(parsed.error)}`);
  }

  // §14 repair retry — one attempt, same provider.
  const repairPrompt =
    `${prompt}\n\n---\nYour previous output failed validation:\n${zodMessage(parsed.error)}\n` +
    `Output ONLY the corrected JSON, nothing else.`;
  const second = await ctx.call(handle, { prompt: repairPrompt, expectJson: true, cwd: opts.cwd }, `${stage}-repair`);
  if (!second.ok) {
    const saved = trySalvage(first.json); // quota can kill the repair call itself; the first output may still salvage
    if (saved !== undefined) return saved;
    throw new StageError(stage, second.error, `repair retry failed (${second.error})`);
  }
  const reparsed = schema.safeParse(second.json);
  if (reparsed.success) return reparsed.data;

  const saved = trySalvage(second.json) ?? trySalvage(first.json);
  if (saved !== undefined) return saved;
  throw new StageError(stage, 'BAD_OUTPUT', `output failed validation after repair: ${zodMessage(reparsed.error)}`);
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}
