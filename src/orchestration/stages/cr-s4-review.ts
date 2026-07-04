// code-review S4 — parallel blind review (§12.2, T10). Each reviewer (claude + codex) independently
// reviews the diff at repo-root cwd and returns findings. Immediately after, a DETERMINISTIC file:line
// validator (§605) drops any finding whose file isn't in the diff / present at HEAD, or whose line
// range is out of bounds — BEFORE the cross-exam sees it. Dropping is per-finding (keep the valid ones,
// §grill 2026-07-04); a reviewer ending with 0 valid findings is legal, not a failure.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../../providers/types.js';
import type { Finding } from '../../schemas/index.js';
import { CodeReviewRoleOutputModel } from '../../schemas/index.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

/** One reviewer's post-validation result. `findings` are the valid ones downstream consumes. */
export interface ReviewerFindings {
  provider: ProviderId;
  findings: Finding[]; // file:line resolved
  dropped: Finding[]; // rejected by the validator (kept for the per-reviewer report stat)
  raised: number; // total the reviewer emitted, before validation
}

/**
 * Pure file:line validator (§12.2/§605). A finding is valid iff its file appears in the diff AND is
 * present at HEAD (has a line count) AND 1 ≤ line_start ≤ line_end ≤ lineCount.
 */
export function filterValidFindings(
  findings: Finding[],
  diffFiles: Set<string>,
  lineCounts: Map<string, number>,
): { valid: Finding[]; dropped: Finding[] } {
  const valid: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    const lc = lineCounts.get(f.file);
    const ok = diffFiles.has(f.file) && lc !== undefined && f.line_start >= 1 && f.line_end >= f.line_start && f.line_end <= lc;
    (ok ? valid : dropped).push(f);
  }
  return { valid, dropped };
}

/** Line count per file at HEAD (reads the repo tree). A missing/unreadable file is simply absent. */
export async function countLines(repoRoot: string, files: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    files.map(async (f) => {
      try {
        out.set(f, (await readFile(join(repoRoot, f), 'utf8')).split('\n').length);
      } catch {
        /* file not at HEAD (e.g. deleted) → left out → findings on it are rejected */
      }
    }),
  );
  return out;
}

async function reviewOne(ctx: RunCtx, seat: ProviderId, prompt: string, diffSet: Set<string>, lineCounts: Map<string, number>): Promise<ReviewerFindings> {
  const model = await jsonCall(ctx, ctx.handle(seat), `S4-${seat}`, prompt, CodeReviewRoleOutputModel);
  // Persist the RAW reviewer output (all findings) for forensics; downstream uses only the valid set.
  await ctx.writer.writeRoleOutput(seat, { workflow: 'code-review', ...model });
  const { valid, dropped } = filterValidFindings(model.findings, diffSet, lineCounts);
  return { provider: seat, findings: valid, dropped, raised: model.findings.length };
}

export async function s4Review(ctx: RunCtx, prompt: string, diffFiles: string[]): Promise<ReviewerFindings[]> {
  const seats = ctx.roles.s4;
  const lineCounts = await countLines(ctx.cwd, diffFiles); // ctx.cwd = repo root for code-review
  const diffSet = new Set(diffFiles);

  const settled = await Promise.allSettled(seats.map((seat) => reviewOne(ctx, seat, prompt, diffSet, lineCounts)));
  const survivors: ReviewerFindings[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === 'fulfilled') survivors.push(r.value);
    else if (isFatal(r.reason)) throw r.reason; // budget/deadline/abort → abort the run
    else dropped.push(`${seats[i]}:${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  }

  if (survivors.length === 0) {
    throw new StageError('S4', 'QUORUM', `no reviewers survived (dropped: ${dropped.join('; ')})`);
  }
  // Exactly one reviewer → no cross-exam is possible (nothing to examine against). The run still
  // produces single-reviewer findings; flag the reduced diversity (§8).
  if (survivors.length < 2) ctx.addFlag('low_diversity');
  return survivors;
}
