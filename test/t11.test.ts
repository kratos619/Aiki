import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { scoreRun, type SeededBug } from '../src/bench/scoring/seeded-bugs.js';
import { summarize, type CaseResult } from '../src/bench/results.js';
import { loadCases, runBench, renderTable } from '../src/bench/harness.js';
import { parseVerdictFlags, buildFeedbackEntries, FeedbackError, FeedbackEntry, VERDICT_VOCAB } from '../src/storage/feedback.js';
import { resolve as resolveCmd } from '../src/cli/resolve.js';
import type { Finding } from '../src/schemas/index.js';
import type { Adapter, ProviderHandle, ProviderId, RunResultAdapter } from '../src/providers/types.js';

const F = (over: Partial<Finding> = {}): Finding => ({
  id: 'F1',
  file: 'src.js',
  line_start: 5,
  line_end: 5,
  severity: 'P1',
  category: 'CORRECTNESS',
  claim: 'off-by-one',
  evidence: '<=',
  suggested_fix: '<',
  self_confidence: 0.9,
  ...over,
});

const BUG = (over: Partial<SeededBug> = {}): SeededBug => ({ id: 'B1', file: 'src.js', line_start: 5, line_end: 5, category: 'CORRECTNESS', ...over });

// ── scorer (BENCHMARK.md §3) ──────────────────────────────────────────────────

describe('scoreRun', () => {
  it('a finding matching file+overlap+category counts as found; wrong category does not', () => {
    const bugs = [BUG({ id: 'B1' }), BUG({ id: 'B2', line_start: 20, line_end: 22, category: 'SECURITY' })];
    const findings = [F({ line_start: 5, line_end: 6 }), F({ id: 'F2', line_start: 21, line_end: 21, category: 'PERF' })]; // 2nd matches location but wrong category
    const s = scoreRun(findings, bugs);
    expect(s.matched).toBe(1);
    expect(s.recall).toBe(0.5);
    expect(s.matchedRelaxed).toBe(2); // location-only L1 metric counts the mis-categorized second finding
    expect(s.recallRelaxed).toBe(1);
    expect(s.reported).toBe(2);
    expect(s.unmatched).toBe(1); // the mis-categorized finding is a candidate FP
  });
  it('recall is 0 when there are no seeded bugs (no divide-by-zero)', () => {
    expect(scoreRun([F()], []).recall).toBe(0);
  });
});

// ── micro aggregation ─────────────────────────────────────────────────────────

describe('summarize (micro recall)', () => {
  it('aggregates matched/seeded across cases, not the mean of ratios', () => {
    const cases: CaseResult[] = [
      { case: 'c1', seeded: 2, arms: [{ arm: 'A', status: 'scored', seeded: 2, matched: 2, recall: 1, reported: 2, unmatched: 0, precision: null, calls: 1, wallMs: 10 }] },
      { case: 'c2', seeded: 4, arms: [{ arm: 'A', status: 'scored', seeded: 4, matched: 1, recall: 0.25, reported: 3, unmatched: 2, precision: null, calls: 1, wallMs: 10 }] },
    ];
    const [rowA] = summarize(cases, ['A']);
    expect(rowA!.recall).toBeCloseTo(3 / 6); // micro: (2+1)/(2+4)
    expect(rowA!.recallMacro).toBeCloseTo((1 + 0.25) / 2); // macro: mean of ratios
    expect(rowA!.matched).toBe(3);
  });
});

// ── resolve-CR (T10 deferral) ─────────────────────────────────────────────────

describe('resolve code-review vocab', () => {
  it('parseVerdictFlags accepts fixed/wontfix/false-positive under the CR vocab, rejects idea verbs', () => {
    const m = parseVerdictFlags(['G1=false-positive', 'G2=fixed', 'G3=wontfix'], VERDICT_VOCAB['code-review']);
    expect(m.get('G1')).toEqual({ verdict: 'false-positive' });
    expect(m.get('G2')).toEqual({ verdict: 'fixed' });
    expect(() => parseVerdictFlags(['G1=correct'], VERDICT_VOCAB['code-review'])).toThrow(FeedbackError);
  });
  it('buildFeedbackEntries tags code-review lines as item_type:finding', () => {
    const entries = buildFeedbackEntries('r1', 'code-review', [{ id: 'G1', ruling: 'P1/CORRECTNESS/HIGH' }], new Map([['G1', { verdict: 'false-positive' as const }]]), new Date('2026-07-04T00:00:00Z'), 'finding');
    expect(entries[0]).toMatchObject({ item_type: 'finding', verdict: 'false-positive', ruling: 'P1/CORRECTNESS/HIGH' });
    expect(() => FeedbackEntry.parse(entries[0])).not.toThrow();
  });
});

// ── build set loads ───────────────────────────────────────────────────────────

describe('loadCases (real build set)', () => {
  it('loads the 5 seeded cases with their bugs', async () => {
    const cases = await loadCases('code-review', 'build');
    expect(cases).toHaveLength(5);
    expect(cases.reduce((n, c) => n + c.bugs.length, 0)).toBe(20);
    for (const c of cases) expect(c.diff).toContain('+++ b/');
  });
});

// ── scripted-adapter bench e2e (no paid calls) ────────────────────────────────

function benchAdapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      let obj: unknown = {};
      if (p.includes('peer cross-examination')) {
        obj = { verifications: [{ target_id: 'F1', verdict: 'CONFIRM', evidence: 'real', note: '' }], all_confirmed_justification: 'clearly a real bug' };
      } else if (p.includes('Judge on a code review')) {
        obj = { adjudications: [], verdict: 'one real defect', dissent: ['maybe intended'], confidence_notes: 'HIGH' };
      } else {
        // any reviewer / sample prompt → one finding that matches the seeded bug (src.js:5 CORRECTNESS)
        obj = { task_echo: 'review', findings: [{ id: 'F1', file: 'src.js', line_start: 5, line_end: 5, severity: 'P1', category: 'CORRECTNESS', claim: 'off-by-one', evidence: '<=', suggested_fix: '<', self_confidence: 0.9 }] };
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function benchHandle(id: ProviderId): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return { id, adapter: benchAdapter(id), flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
}

describe('runBench end-to-end (scripted adapters)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-bench-'));
    const caseDir = join(root, 'bench', 'sets', 'code-review', 'build', 'case1');
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, 'src.js'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    await writeFile(join(caseDir, 'diff.patch'), ['diff --git a/src.js b/src.js', '--- /dev/null', '+++ b/src.js', '@@ -0,0 +1,10 @@'].join('\n') + '\n');
    await writeFile(join(caseDir, 'bugs.json'), JSON.stringify({ bugs: [{ id: 'B1', file: 'src.js', line_start: 5, line_end: 5, category: 'CORRECTNESS' }] }));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('runs all four arms, scores recall, writes result JSON + renders a table', async () => {
    const handles = [benchHandle('claude'), benchHandle('codex'), benchHandle('agy')];
    const result = await runBench({ suite: 'code-review', set: 'build', arms: ['A', 'B', 'C', 'D'], root, handles });

    expect(result.cases).toHaveLength(1);
    const scores = result.cases[0]!.arms;
    expect(scores.map((s) => s.arm)).toEqual(['A', 'B', 'C', 'D']);
    // every arm found the one seeded bug → recall 1.0
    for (const s of scores) {
      expect(s.status).toBe('scored');
      expect(s.recall).toBe(1);
      expect(s.matched).toBe(1);
    }
    expect(result.summary.find((r) => r.arm === 'D')!.recall).toBe(1);

    // result JSON was written incrementally
    const written = JSON.parse(await readFile(join(root, 'bench', 'results', `code-review-${result.at.slice(0, 10)}.json`), 'utf8'));
    expect(written.cases).toHaveLength(1);

    const table = renderTable(result);
    expect(table).toContain('Recall (strict)');
    expect(table).toContain('Recall (category-relaxed)');
    expect(table).toContain('| A |');
  });

  it('skips arms whose providers are unavailable (D needs codex)', async () => {
    const result = await runBench({ suite: 'code-review', set: 'build', arms: ['A', 'D'], root, handles: [benchHandle('claude')] });
    const scores = result.cases[0]!.arms;
    expect(scores.find((s) => s.arm === 'A')!.status).toBe('scored');
    expect(scores.find((s) => s.arm === 'D')!.status).toBe('skipped');
  });
});

// ── resolve-CR end-to-end (writes a finding verdict) ──────────────────────────

async function mkRun(aiki: string, id: string, files: Record<string, string>): Promise<void> {
  const dir = join(aiki, 'runs', id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

describe('resolve on a code-review run (cwd-based)', () => {
  let root: string;
  let aiki: string;
  let cwd: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-rcr-'));
    aiki = join(root, '.aiki');
    await mkdir(aiki, { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  it('--verdict G1=false-positive appends an item_type:finding line', async () => {
    const map = { consensus: [{ finding: F({ id: 'G1' }), reviewers: ['claude', 'codex'], cross_verdict: 'NONE' }], disputed: [], single_reviewer: [], per_reviewer: [] };
    const judge = { adjudications: [], verdict: 'v', dissent: ['d'], confidence_notes: 'n' };
    await mkRun(aiki, 'cr1', { '07-review-map.json': JSON.stringify(map), '09-judge-report.json': JSON.stringify(judge), 'meta.json': JSON.stringify({ workflow: 'code-review' }) });

    let out = '';
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
    try {
      const code = await resolveCmd('cr1', { verdict: ['G1=false-positive'] });
      expect(code).toBe(0);
    } finally {
      so.mockRestore();
    }
    const line = JSON.parse((await readFile(join(aiki, 'feedback.jsonl'), 'utf8')).trim());
    expect(line).toMatchObject({ run_id: 'cr1', workflow: 'code-review', item_type: 'finding', item_id: 'G1', verdict: 'false-positive' });
  });

  it('falls back to raw/bench-findings.json when a run has no review-map (single-call bench arms)', async () => {
    await mkRun(aiki, 'cr2', {
      'meta.json': JSON.stringify({ workflow: 'code-review' }),
      'raw/bench-findings.json': JSON.stringify([F({ id: 'F1' }), F({ id: 'F2', claim: 'phantom bug' })]),
    });

    const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await resolveCmd('cr2', { verdict: ['F2=false-positive'] });
      expect(code).toBe(0);
    } finally {
      so.mockRestore();
    }
    const line = JSON.parse((await readFile(join(aiki, 'feedback.jsonl'), 'utf8')).trim());
    expect(line).toMatchObject({ run_id: 'cr2', item_type: 'finding', item_id: 'F2', verdict: 'false-positive' });
  });
});
