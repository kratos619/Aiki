// V1 — S8-teeth. The code-review cross-exam must actually debate: a rubber stamp (all CONFIRM, no
// weakest-first justification) triggers ONE sharper re-ask; a genuine pushback (a REFUTE/UNCERTAIN)
// flows into ReviewMap.disputed → the judge path. Scripted adapters + a real RunCtx (no paid calls).
// NOTE: scripted S8 adapters route on the phrase "peer cross-examination"; the re-ask is distinguished
// by "rubber stamp". Keep both phrases in cr-s8-crossexam.ts or these tests break.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeRunId, resolveRoles, RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import { RunWriter } from '../src/storage/runs.js';
import { s8CrossExam } from '../src/orchestration/stages/cr-s8-crossexam.js';
import { buildReviewMap } from '../src/orchestration/stages/cr-map.js';
import type { ReviewerFindings } from '../src/orchestration/stages/cr-s4-review.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import type { Finding } from '../src/schemas/index.js';

const F = (over: Partial<Finding> = {}): Finding => ({
  id: 'F1',
  file: 'src/foo.ts',
  line_start: 10,
  line_end: 12,
  severity: 'P0',
  category: 'CORRECTNESS',
  claim: 'off-by-one in the loop bound',
  evidence: 'uses <= len',
  suggested_fix: 'use < len',
  self_confidence: 0.9,
  ...over,
});

/** A scripted handle whose S8 response is chosen by `respond(isReask)`. `isReask` is true when the
 *  prompt is the sharper re-ask (contains "rubber stamp"). */
function s8Handle(id: ProviderId, respond: (isReask: boolean) => unknown): ProviderHandle {
  const adapter: Adapter = {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      const obj = p.includes('peer cross-examination') ? respond(p.includes('rubber stamp')) : {};
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return { id, adapter, flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
}

// codex is the examiner (claude has findings, codex has none → only codex examines claude).
const CLAUDE_RF: ReviewerFindings = {
  provider: 'claude',
  findings: [F({ id: 'F1' }), F({ id: 'F2', line_start: 20, line_end: 22, category: 'SECURITY', claim: 'missing auth check' })],
  dropped: [],
  raised: 2,
};
const CODEX_RF: ReviewerFindings = { provider: 'codex', findings: [], dropped: [], raised: 0 };

async function makeCtx(codexRespond: (isReask: boolean) => unknown): Promise<{ ctx: RunCtx; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aiki-s8-'));
  const handles = [s8Handle('agy', () => ({})), s8Handle('codex', codexRespond), s8Handle('claude', () => ({}))];
  const runId = makeRunId('code-review');
  const roles = resolveRoles('code-review', handles.map((h) => h.id));
  const writer = new RunWriter(runId, join(dir, '.aiki'));
  await writer.init();
  const ctx = new RunCtx({ runId, workflow: 'code-review', handles, roles, writer, cwd: dir });
  return { ctx, dir };
}

const allConfirmNoJustification = () => ({
  verifications: [
    { target_id: 'F1', verdict: 'CONFIRM', evidence: 'real', note: '' },
    { target_id: 'F2', verdict: 'CONFIRM', evidence: 'real', note: '' },
  ],
});

describe('cr-S8 teeth: rubber-stamp re-ask', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('confirm-all → sharper re-ask → accepted pushback (REFUTE), no flag, and it flows to disputed', async () => {
    const respond = (isReask: boolean): unknown =>
      isReask
        ? { verifications: [
            { target_id: 'F1', verdict: 'REFUTE', evidence: 'guarded at src/mw.ts:30', note: 'auth enforced in middleware' },
            { target_id: 'F2', verdict: 'CONFIRM', evidence: 'real', note: '' },
          ] }
        : allConfirmNoJustification();
    const made = await makeCtx(respond);
    dir = made.dir;
    const { ctx } = made;

    const result = await s8CrossExam(ctx, [CLAUDE_RF, CODEX_RF]);

    // The re-ask fired exactly once (initial + repair) and the pushback replaced the rubber stamp.
    expect(ctx.calls.map((c) => c.stage)).toEqual(['S8-codex', 'S8-codex-repair']);
    expect(ctx.flags.has('synthesis_suspect')).toBe(false);
    expect(result.byKey.get('claude/F1')?.verdict).toBe('REFUTE');

    // The REFUTE flows into ReviewMap.disputed (→ judge path; downstream covered by t10).
    const map = buildReviewMap([CLAUDE_RF, CODEX_RF], result.byKey);
    expect(map.disputed).toHaveLength(1);
    expect(map.disputed[0]!.refutation).toBe('auth enforced in middleware');
  });

  it('confirm-all twice (re-ask still rubber-stamps) → synthesis_suspect flagged', async () => {
    const made = await makeCtx(() => allConfirmNoJustification());
    dir = made.dir;
    const { ctx } = made;

    const result = await s8CrossExam(ctx, [CLAUDE_RF, CODEX_RF]);

    expect(ctx.calls.map((c) => c.stage)).toEqual(['S8-codex', 'S8-codex-repair']);
    expect(ctx.flags.has('synthesis_suspect')).toBe(true);
    expect([...result.byKey.values()].every((v) => v.verdict === 'CONFIRM')).toBe(true);
  });

  it('genuine pushback on the first pass → NO re-ask (protects cost/recall), no flag', async () => {
    const made = await makeCtx(() => ({
      verifications: [
        { target_id: 'F1', verdict: 'REFUTE', evidence: 'unreachable branch', note: 'dead code' },
        { target_id: 'F2', verdict: 'CONFIRM', evidence: 'real', note: '' },
      ],
    }));
    dir = made.dir;
    const { ctx } = made;

    await s8CrossExam(ctx, [CLAUDE_RF, CODEX_RF]);

    expect(ctx.calls.map((c) => c.stage)).toEqual(['S8-codex']);
    expect(ctx.flags.has('synthesis_suspect')).toBe(false);
  });

  it('all-CONFIRM WITH weakest-first justification → not a rubber stamp, NO re-ask, no flag', async () => {
    const made = await makeCtx(() => ({
      ...allConfirmNoJustification(),
      all_confirmed_justification: 'weakest is F2, but src/foo.ts:20 genuinely lacks an auth guard',
    }));
    dir = made.dir;
    const { ctx } = made;

    await s8CrossExam(ctx, [CLAUDE_RF, CODEX_RF]);

    expect(ctx.calls.map((c) => c.stage)).toEqual(['S8-codex']);
    expect(ctx.flags.has('synthesis_suspect')).toBe(false);
  });
});
