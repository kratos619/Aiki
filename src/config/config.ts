// `.aiki/config.json` loading (T9, §5/§273/§443). Project-local, human-edited config that pins
// roles + budget/deadline. Precedence is always: run flag > config > built-in default.
//
// Design decisions (grilled 2026-07-04, see .agent/STATE.md):
// - `roles` is a FLAT GLOBAL Partial<RoleMap> — applied as roleOverrides for every workflow via the
//   existing resolveRoles(workflow, available, overrides) seam. (§273 "config pins roles globally".)
// - Missing file → defaults (not an error). Present but invalid (bad JSON or schema) → HARD-FAIL with a
//   message naming the file + the exact problem. We never silently ignore a config the user believes is
//   active (schema-boundary rule, CLAUDE.md).
// - The 6h smoke cache is NOT here — it lives in a separate tool-owned .aiki/smoke-cache.json so `doctor`
//   never rewrites this human-edited file (deviation from the plan's literal "cached in config.json").

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderIdSchema } from '../schemas/index.js';
import { DEFAULT_BUDGET, DEFAULT_DEADLINE_MS, type RoleMap } from '../orchestration/context.js';
import { homeAikiRoot } from '../storage/paths.js';

/** Partial role pin — any subset of the RoleMap roles. `.strict()` so a typo'd key hard-fails. */
const ConfigRoles = z
  .object({
    analyst: ProviderIdSchema.optional(),
    judge: ProviderIdSchema.optional(),
    verifier: ProviderIdSchema.optional(),
    s4: z.array(ProviderIdSchema).min(1).optional(),
    responder: ProviderIdSchema.optional(),
  })
  .strict();

/** Per-provider model override (V8). Each CLI runs its own model families, so model choice is per
 *  provider; the id is passed verbatim to the CLI as `--model <id>` (see docs/PROVIDER_NOTES.md). */
const ProviderModels = z
  .object({
    claude: z.string().min(1).optional(),
    codex: z.string().min(1).optional(),
    agy: z.string().min(1).optional(),
  })
  .strict();
export type ProviderModels = z.infer<typeof ProviderModels>;

/** The `.aiki/config.json` schema. `.strict()` → an unknown top-level key is a hard-fail (typo guard). */
export const AikiConfig = z
  .object({
    roles: ConfigRoles.optional(),
    models: ProviderModels.optional(),
    budget: z.number().int().positive().optional(),
    deadlineMs: z.number().int().positive().optional(),
  })
  .strict();

export type AikiConfig = z.infer<typeof AikiConfig>;

/** Config values with built-in defaults filled in — what a run would actually use (`aiki config`). */
export interface EffectiveConfig {
  budget: number;
  deadlineMs: number;
  roles: Partial<RoleMap>;
  models: ProviderModels;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load `.aiki/config.json`. Missing → `{}` (defaults). Present-but-invalid (unparseable JSON or a
 * value that fails the zod schema) → throws `ConfigError` naming the file + the precise problem.
 */
export async function loadConfig(root = '.aiki'): Promise<AikiConfig> {
  const path = join(root, 'config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {}; // missing file = use defaults (not an error)
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`${path}: invalid JSON — ${(e as Error).message}`);
  }
  const res = AikiConfig.safeParse(parsed);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `config.${issue.path.join('.')}` : 'config';
    throw new ConfigError(`${path}: ${where} — ${issue?.message ?? 'invalid config'}`);
  }
  return res.data;
}

/** Merge the loaded config over built-in defaults for display (`aiki config`). Roles = pins only. */
export function effectiveConfig(cfg: AikiConfig): EffectiveConfig {
  return {
    budget: cfg.budget ?? DEFAULT_BUDGET,
    deadlineMs: cfg.deadlineMs ?? DEFAULT_DEADLINE_MS,
    roles: cfg.roles ?? {},
    models: cfg.models ?? {},
  };
}

/** Merge a global (base) config with a project (override): project wins per field; roles/models KEYS merge. */
export function mergeConfig(base: AikiConfig, over: AikiConfig): AikiConfig {
  const merged: AikiConfig = { ...base, ...over };
  if (base.roles || over.roles) merged.roles = { ...base.roles, ...over.roles };
  if (base.models || over.models) merged.models = { ...base.models, ...over.models };
  return merged;
}

/** Layered config: global `~/.aiki/config.json` (base) overlaid by the project `.aiki/config.json`. What
 *  the CLI actually uses (V8) — a user can set defaults once in the global file and override per project. */
export async function loadLayeredConfig(projectRoot = '.aiki'): Promise<AikiConfig> {
  const globalRoot = homeAikiRoot();
  const global = await loadConfig(globalRoot);
  if (projectRoot === globalRoot) return global;
  const project = await loadConfig(projectRoot);
  return mergeConfig(global, project);
}
