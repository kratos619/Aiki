// Artifact writer for a single run's `.aiki/runs/<id>/` folder (§15).
//
// Guarantees (§14, §24 T4 acceptance):
// - Ordered writes: numbered stage artifacts must be written in forward order. A write for a
//   stage earlier than the furthest-reached stage is refused (`OutOfOrderWriteError`). This is
//   §14's "the artifact writer refuses out-of-order writes".
// - Immutable artifacts: a stage file, once written, cannot be rewritten (crash-forensics
//   integrity). `meta.json` is the sole exception — it is finalized/updated (§16 aborted:true).
// - Crash-safe writes: every file is written to `<path>.tmp` then atomically `rename`d into
//   place, so a crash mid-write never leaves a truncated/invalid artifact on disk.
// - Schema boundary: artifacts with a core schema (§14) are zod-validated BEFORE hitting disk;
//   an invalid payload throws and writes nothing.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { DisagreementMap, IntentContract, JudgeReport, ReviewMap, RoleOutput, RunMeta, VerificationSet } from '../schemas/index.js';

export class OutOfOrderWriteError extends Error {
  constructor(slot: string, ord: number, maxOrd: number) {
    super(`out-of-order write: "${slot}" (stage ${ord}) after stage ${maxOrd} already written`);
    this.name = 'OutOfOrderWriteError';
  }
}

export class DuplicateWriteError extends Error {
  constructor(relPath: string) {
    super(`artifact already written (immutable): ${relPath}`);
    this.name = 'DuplicateWriteError';
  }
}

/** Numbered single-file stage artifacts (§15). `null` schema = no core schema yet (written as-is). */
interface SlotDef {
  ord: number;
  path: string;
  schema: z.ZodTypeAny | null;
}

/** JSON stage slots. Composites without a T4 core schema (misunderstanding-guard, drift, claims)
 *  are written as-is; their schemas land with S2/S5/S6 (T5–T6). */
const JSON_SLOTS = {
  'intent-contract': { ord: 1, path: '01-intent-contract.json', schema: IntentContract },
  'misunderstanding-guard': { ord: 2, path: '02-misunderstanding-guard.json', schema: null },
  'drift-report': { ord: 5, path: '05-drift-report.json', schema: null },
  claims: { ord: 6, path: '06-claims.json', schema: null },
  'disagreement-map': { ord: 7, path: '07-disagreement-map.json', schema: DisagreementMap },
  // code-review's stage-7 artifact (ord 7, distinct path). A run writes one of {disagreement-map,
  // review-map} depending on its workflow, so the shared ord never collides within a run.
  'review-map': { ord: 7, path: '07-review-map.json', schema: ReviewMap },
  verifications: { ord: 8, path: '08-verifications.json', schema: VerificationSet },
  'judge-report': { ord: 9, path: '09-judge-report.json', schema: JudgeReport },
} satisfies Record<string, SlotDef>;

/** Text (markdown) stage slots (§15). */
const TEXT_SLOTS = {
  original: { ord: 0, path: '00-original.md' },
  'final-report': { ord: 10, path: 'final-report.md' },
} satisfies Record<string, { ord: number; path: string }>;

const PROMPTS_DIR_ORD = 3; // 03-prompts/
const ROLE_OUTPUTS_DIR_ORD = 4; // 04-role-outputs/

export type JsonSlot = keyof typeof JSON_SLOTS;
export type TextSlot = keyof typeof TEXT_SLOTS;

/**
 * Writes one run's artifacts under `<root>/runs/<runId>/`. One instance per run; not concurrency
 * safe for the same run (a run is single-threaded through its stages). `root` defaults to `.aiki`.
 */
export class RunWriter {
  readonly dir: string;
  private maxOrd = -1;
  private readonly written = new Set<string>(); // relPaths of immutable artifacts already on disk

  constructor(
    readonly runId: string,
    root = '.aiki',
  ) {
    this.dir = join(root, 'runs', runId);
  }

  /** Create the run directory. Idempotent. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  // ── ordered stage artifacts ───────────────────────────────────────────────

  /** Write a JSON stage artifact. Validates against its core schema when one exists (§14). */
  async writeJson<K extends JsonSlot>(slot: K, data: unknown): Promise<string> {
    const def = JSON_SLOTS[slot];
    const payload = def.schema ? def.schema.parse(data) : data; // throws on invalid → nothing written
    this.reserve(def.ord, def.path);
    return this.atomicWrite(def.path, JSON.stringify(payload, null, 2));
  }

  /** Write a markdown stage artifact (00-original.md / final-report.md). */
  async writeText(slot: TextSlot, text: string): Promise<string> {
    const def = TEXT_SLOTS[slot];
    this.reserve(def.ord, def.path);
    return this.atomicWrite(def.path, text);
  }

  /** Write the exact final prompt sent to a provider for a stage → 03-prompts/<name> (§15). */
  async writePrompt(name: string, text: string): Promise<string> {
    const rel = join('03-prompts', name);
    this.reserve(PROMPTS_DIR_ORD, rel);
    return this.atomicWrite(rel, text);
  }

  /** Write one validated S4 role output → 04-role-outputs/<name>.json. Validates RoleOutput (§14). */
  async writeRoleOutput(name: string, data: unknown): Promise<string> {
    const payload = RoleOutput.parse(data); // engine attaches the `workflow` discriminator first (S4)
    const rel = join('04-role-outputs', name.endsWith('.json') ? name : `${name}.json`);
    this.reserve(ROLE_OUTPUTS_DIR_ORD, rel);
    return this.atomicWrite(rel, JSON.stringify(payload, null, 2));
  }

  // ── unordered artifacts ───────────────────────────────────────────────────

  /** Copy an input verbatim → inputs/<name> (diff.patch, source docs). Unordered; overwritable. */
  async writeInput(name: string, content: string): Promise<string> {
    return this.atomicWrite(join('inputs', name), content);
  }

  /** Dump an untouched provider stdout/stderr → raw/<name> (e.g. s4-claude.out). Unordered. */
  async writeRaw(name: string, content: string): Promise<string> {
    return this.atomicWrite(join('raw', name), content);
  }

  /** Write/finalize meta.json (§15, §16). Validated against RunMeta; overwritable (updated at
   *  finalize / on abort). Not subject to stage ordering. */
  async writeMeta(meta: unknown): Promise<string> {
    const payload = RunMeta.parse(meta);
    return this.atomicWrite('meta.json', JSON.stringify(payload, null, 2));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Enforce forward-only ordering + one-shot immutability for stage artifacts. */
  private reserve(ord: number, relPath: string): void {
    if (ord < this.maxOrd) throw new OutOfOrderWriteError(relPath, ord, this.maxOrd);
    if (this.written.has(relPath)) throw new DuplicateWriteError(relPath);
    this.maxOrd = Math.max(this.maxOrd, ord);
    this.written.add(relPath);
  }

  /** Atomic write: temp file + rename, so a crash never leaves a partial artifact (§24 T4). */
  private async atomicWrite(relPath: string, content: string): Promise<string> {
    const full = join(this.dir, relPath);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, full);
    return full;
  }
}
