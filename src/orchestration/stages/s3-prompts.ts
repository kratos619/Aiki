// S3 — prompt generation (§9, §13). The analyst fills the workflow's S4 role templates for this
// specific task. A deterministic validator then requires every {{SLOT}} be resolved (§9 S3): we
// post-fill the structural slots we own (contract JSON, input path, schema ref) and, if anything
// is still unresolved — or the model call fails — fall back to the static templates filled the
// same deterministic way. Either path yields a valid 03-prompts/ artifact.

import type { IntentContract, StagePrompts } from '../../schemas/index.js';
import { StagePrompts as StagePromptsSchema } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { StageError } from '../context.js';
import { jsonCall } from '../jsonStage.js';

const S3_PROMPT = `Fill the role prompt templates below for this specific task. Replace every {{SLOT}}.
Keep the templates' rules intact; add task-specific context only inside the marked
CONTEXT sections. Output ONLY JSON: {"prompts": {"<role>": "<filled prompt>", ...}}.

TASK CONTRACT: {{INTENT_CONTRACT_JSON}}
CHOSEN INTERPRETATION: {{INTERPRETATION}}
TEMPLATES: {{ROLE_TEMPLATES_JSON}}`;

const UNRESOLVED = /\{\{[^}]+\}\}/;

function fillSlots(text: string, slots: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(slots)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

export interface S3Args {
  contract: IntentContract;
  interpretation: string; // the chosen S2 interpretation
  templates: Record<string, string>; // role → raw S4 template (workflow-specific)
  slots: Record<string, string>; // structural slots we own (INPUT_PATH, S4_SCHEMA_REF, ...)
}

export async function s3Prompts(ctx: RunCtx, args: S3Args): Promise<StagePrompts> {
  const slots = { ...args.slots, INTENT_CONTRACT_JSON: JSON.stringify(args.contract) };

  // Deterministic fallback: the static templates with our structural slots filled in.
  const fallback: Record<string, string> = {};
  for (const [role, tpl] of Object.entries(args.templates)) fallback[role] = fillSlots(tpl, slots);

  let prompts = fallback;
  const s3Prompt = S3_PROMPT.replace('{{INTENT_CONTRACT_JSON}}', slots.INTENT_CONTRACT_JSON)
    .replace('{{INTERPRETATION}}', args.interpretation)
    .replace('{{ROLE_TEMPLATES_JSON}}', JSON.stringify(args.templates));

  try {
    const filled = await jsonCall(ctx, ctx.handle(ctx.roles.analyst), 'S3', s3Prompt, StagePromptsSchema);
    // Post-fill structural slots the model may have left, then accept only if fully resolved.
    const merged: Record<string, string> = {};
    for (const [role, tpl] of Object.entries(args.templates)) {
      merged[role] = fillSlots(filled.prompts[role] ?? tpl, slots);
    }
    if (!Object.values(merged).some((p) => UNRESOLVED.test(p))) prompts = merged;
  } catch (e) {
    if (isFatal(e)) throw e; // budget/deadline/abort → abort run; otherwise fall back (§9 S3)
  }

  const unresolved = Object.entries(prompts).filter(([, p]) => UNRESOLVED.test(p));
  if (unresolved.length) {
    throw new StageError('S3', 'BAD_OUTPUT', `unresolved slot(s) in prompt(s): ${unresolved.map(([r]) => r).join(', ')}`);
  }

  for (const [role, text] of Object.entries(prompts)) await ctx.writer.writePrompt(`${role}.md`, text);
  return { prompts };
}
