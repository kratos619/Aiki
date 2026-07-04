import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRoles, makeRunId, RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runCodeReview } from '../src/workflows/code-review.js';
import { RunWriter } from '../src/storage/runs.js';
import { parseDiffFiles, computeDiff, repoToplevel } from '../src/orchestration/git.js';
import { filterValidFindings, type ReviewerFindings } from '../src/orchestration/stages/cr-s4-review.js';
import { sameFinding, buildReviewMap } from '../src/orchestration/stages/cr-map.js';
import { scoreFindings, renderReviewReport } from '../src/orchestration/stages/cr-report.js';
import type { CrossExam } from '../src/orchestration/stages/cr-s8-crossexam.js';
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

// ── roles ─────────────────────────────────────────────────────────────────────

describe('resolveRoles(code-review) (§271)', () => {
  it('reviewers=claude+codex, judge=agy (judge authored no finding)', () => {
    const roles = resolveRoles('code-review', ['agy', 'codex', 'claude']);
    expect(roles.s4.sort()).toEqual(['claude', 'codex']);
    expect(roles.judge).toBe('agy');
    expect(roles.s4).not.toContain(roles.judge);
  });
  it('config override wins for the judge', () => {
    const roles = resolveRoles('code-review', ['agy', 'codex', 'claude'], { judge: 'claude' });
    expect(roles.judge).toBe('claude');
  });
});

// ── git plumbing (pure parse) ───────────────────────────────────────────────

describe('parseDiffFiles', () => {
  it('extracts HEAD files from +++ lines, skips /dev/null (deletions)', () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', 'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null'].join('\n');
    expect(parseDiffFiles(diff)).toEqual(['src/a.ts']);
  });
});

// ── file:line validator (§605) ──────────────────────────────────────────────

describe('filterValidFindings', () => {
  const diffFiles = new Set(['src/foo.ts']);
  const lineCounts = new Map([['src/foo.ts', 50]]);
  it('keeps a finding whose file is in the diff and lines are in bounds', () => {
    const { valid, dropped } = filterValidFindings([F()], diffFiles, lineCounts);
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
  it('drops file not in diff, line out of bounds, and inverted ranges', () => {
    const bad = [F({ id: 'F2', file: 'ghost.ts' }), F({ id: 'F3', line_start: 60, line_end: 61 }), F({ id: 'F4', line_start: 12, line_end: 10 })];
    const { valid, dropped } = filterValidFindings(bad, diffFiles, lineCounts);
    expect(valid).toHaveLength(0);
    expect(dropped.map((d) => d.id).sort()).toEqual(['F2', 'F3', 'F4']);
  });
});

// ── §487 matcher + ReviewMap ────────────────────────────────────────────────

describe('sameFinding (§487 matcher)', () => {
  it('same file + overlapping lines + same category → match', () => {
    expect(sameFinding(F({ line_start: 10, line_end: 12 }), F({ line_start: 11, line_end: 11 }))).toBe(true);
  });
  it('different category or non-overlapping lines → no match', () => {
    expect(sameFinding(F(), F({ category: 'SECURITY' }))).toBe(false);
    expect(sameFinding(F({ line_start: 10, line_end: 12 }), F({ line_start: 20, line_end: 22 }))).toBe(false);
  });
});

describe('buildReviewMap', () => {
  const claude: ReviewerFindings = { provider: 'claude', findings: [F({ id: 'F1' }), F({ id: 'F2', category: 'SECURITY', line_start: 20, line_end: 22, claim: 'missing auth' })], dropped: [F({ id: 'Fx' })], raised: 3 };
  const codex: ReviewerFindings = { provider: 'codex', findings: [F({ id: 'F1', line_start: 11, line_end: 11 })], dropped: [], raised: 1 };

  it('§487-merges independent same-bug findings into consensus; cross-exam REFUTE → disputed', () => {
    const cross: CrossExam = new Map([['claude/F2', { verdict: 'REFUTE', note: 'handled upstream', evidence: 'see mw', examiner: 'codex' }]]);
    const map = buildReviewMap([claude, codex], cross);
    expect(map.consensus).toHaveLength(1); // claude F1 + codex F1 merged
    expect(map.consensus[0]!.reviewers.sort()).toEqual(['claude', 'codex']);
    expect(map.disputed).toHaveLength(1); // claude F2, REFUTEd
    expect(map.disputed[0]!.refutation).toBe('handled upstream');
    expect(map.single_reviewer).toHaveLength(0);
    // reindexed to unique global ids
    const ids = [...map.consensus, ...map.disputed].map((a) => a.finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(map.per_reviewer).toContainEqual({ provider: 'claude', raised: 3, kept: 2, dropped: 1 });
  });

  it('unexamined single finding → single_reviewer (MEDIUM)', () => {
    const map = buildReviewMap([claude, codex], new Map());
    expect(map.consensus).toHaveLength(1);
    expect(map.single_reviewer).toHaveLength(1); // claude F2, never examined
  });
});

// ── confidence + report ─────────────────────────────────────────────────────

describe('scoreFindings', () => {
  it('consensus=HIGH, single=MEDIUM, disputed+UPHOLD=LOW kept, disputed+REJECT=rejected', () => {
    const map = {
      consensus: [{ finding: F({ id: 'G1' }), reviewers: ['claude', 'codex'] as ProviderId[], cross_verdict: 'NONE' as const }],
      single_reviewer: [{ finding: F({ id: 'G2' }), reviewers: ['claude'] as ProviderId[], cross_verdict: 'NONE' as const }],
      disputed: [
        { finding: F({ id: 'G3' }), reviewers: ['claude'] as ProviderId[], cross_verdict: 'REFUTE' as const },
        { finding: F({ id: 'G4' }), reviewers: ['codex'] as ProviderId[], cross_verdict: 'REFUTE' as const },
      ],
      per_reviewer: [],
    };
    const judge = { adjudications: [{ id: 'G3', ruling: 'UPHOLD' as const, reasoning: 'r', evidence_cited: 'e' }, { id: 'G4', ruling: 'REJECT' as const, reasoning: 'r', evidence_cited: 'e' }], verdict: 'v', dissent: ['d'], confidence_notes: 'n' };
    const scored = scoreFindings(map, judge);
    const by = new Map(scored.map((s) => [s.finding.id, s]));
    expect(by.get('G1')).toMatchObject({ confidence: 'HIGH', disposition: 'kept' });
    expect(by.get('G2')).toMatchObject({ confidence: 'MEDIUM', disposition: 'kept' });
    expect(by.get('G3')).toMatchObject({ confidence: 'LOW', disposition: 'kept' });
    expect(by.get('G4')).toMatchObject({ disposition: 'rejected' });
  });
});

// ── real git integration ────────────────────────────────────────────────────

describe('git diff (real temp repo, three-dot)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiki-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 'T');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'foo.ts'), 'a\nb\nc\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature');
    await writeFile(join(dir, 'src', 'foo.ts'), 'a\nB-CHANGED\nc\n');
    git('commit', '-qam', 'change');
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('repoToplevel resolves + computeDiff main...feature shows the change on the HEAD file', async () => {
    expect(await repoToplevel(dir)).toBeTruthy();
    const diff = await computeDiff('main', 'feature', dir);
    expect(diff).toContain('B-CHANGED');
    expect(parseDiffFiles(diff)).toEqual(['src/foo.ts']);
  });
});

// ── scripted-adapter end-to-end (no paid calls) ─────────────────────────────

function crAdapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      let obj: unknown = {};
      if (p.includes('senior code reviewer') && p.includes('work ALONE')) {
        // S4 reviewer — no `workflow` field in model JSON.
        obj =
          id === 'claude'
            ? {
                task_echo: 'review the diff',
                findings: [
                  { id: 'F1', file: 'src/foo.ts', line_start: 10, line_end: 12, severity: 'P0', category: 'CORRECTNESS', claim: 'off-by-one', evidence: '<=', suggested_fix: '<', self_confidence: 0.9 },
                  { id: 'F2', file: 'src/foo.ts', line_start: 9999, line_end: 9999, severity: 'P2', category: 'PERF', claim: 'hallucinated line', evidence: 'x', suggested_fix: 'y', self_confidence: 0.3 },
                  { id: 'F3', file: 'ghost.ts', line_start: 1, line_end: 1, severity: 'P2', category: 'MAINTAINABILITY', claim: 'file not in diff', evidence: 'x', suggested_fix: 'y', self_confidence: 0.2 },
                ],
              }
            : {
                task_echo: 'review the diff',
                findings: [
                  { id: 'F1', file: 'src/foo.ts', line_start: 11, line_end: 11, severity: 'P0', category: 'CORRECTNESS', claim: 'off-by-one (dup)', evidence: '<=', suggested_fix: '<', self_confidence: 0.85 },
                  { id: 'F2', file: 'src/foo.ts', line_start: 20, line_end: 22, severity: 'P1', category: 'SECURITY', claim: 'missing auth check', evidence: 'no guard', suggested_fix: 'add guard', self_confidence: 0.8 },
                ],
              };
      } else if (p.includes('peer cross-examination')) {
        obj =
          id === 'claude' // claude examines codex's findings (F1 off-by-one, F2 missing auth)
            ? { verifications: [{ target_id: 'F1', verdict: 'CONFIRM', evidence: 'real', note: '' }, { target_id: 'F2', verdict: 'REFUTE', evidence: 'auth is upstream', note: 'handled in middleware' }] }
            : { verifications: [{ target_id: 'F1', verdict: 'CONFIRM', evidence: 'real', note: '' }], all_confirmed_justification: 'the off-by-one is unambiguous' };
      } else if (p.includes('Judge on a code review')) {
        const gid = /"id":\s*"(G\d+)"/.exec(p)?.[1] ?? 'G1';
        obj = { adjudications: [{ id: gid, ruling: 'UPHOLD', reasoning: 'the auth gap is real', evidence_cited: 'no guard present' }], verdict: 'One consensus P0 off-by-one; one upheld P1 auth gap.', dissent: ['auth may be enforced by an upstream router'], confidence_notes: 'P0 HIGH; P1 LOW' };
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function crHandle(id: ProviderId): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return { id, adapter: crAdapter(id), flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
}

const DIFF = ['diff --git a/src/foo.ts b/src/foo.ts', '--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -9,3 +9,3 @@', ' ctx', '-old', '+new', ' ctx'].join('\n');

describe('code-review end-to-end (scripted adapters)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'aiki-cr-'));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'foo.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  });
  afterEach(async () => rm(repo, { recursive: true, force: true }));

  it('S4→S10: adjudicated findings, file:line rejection pre-model, agy judge', async () => {
    const handles = [crHandle('agy'), crHandle('codex'), crHandle('claude')];
    const runId = makeRunId('code-review');
    const roles = resolveRoles('code-review', handles.map((h) => h.id));
    const writer = new RunWriter(runId, join(repo, '.aiki'));
    const ctx = new RunCtx({ runId, workflow: 'code-review', handles, roles, writer, cwd: repo });

    const outcome = await executeRun(ctx, DIFF, runCodeReview);
    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(5); // S4×2 + S8×2 + S9×1

    const dir = ctx.writer.dir;
    // §605: claude's hallucinated-line + not-in-diff findings were dropped BEFORE cross-exam.
    const map = JSON.parse(await readFile(join(dir, '07-review-map.json'), 'utf8'));
    const claudeStats = map.per_reviewer.find((r: { provider: string }) => r.provider === 'claude');
    expect(claudeStats).toMatchObject({ raised: 3, kept: 1, dropped: 2 });
    expect(map.consensus).toHaveLength(1); // §487-merged off-by-one
    expect(map.disputed).toHaveLength(1); // missing-auth, REFUTEd by claude

    const judge = JSON.parse(await readFile(join(dir, '09-judge-report.json'), 'utf8'));
    expect(judge.adjudications).toHaveLength(1);
    expect(judge.adjudications[0].ruling).toBe('UPHOLD');

    const report = await readFile(join(dir, 'final-report.md'), 'utf8');
    expect(report).toContain('# Code Review');
    expect(report).toContain('off-by-one');
    expect(report).toContain('Gemini'); // agy judge shown via DISPLAY_NAME

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('ok');
    expect(meta.roles).toMatchObject({ judge: 'agy', s4_1: 'claude', s4_2: 'codex' });
  });
});
