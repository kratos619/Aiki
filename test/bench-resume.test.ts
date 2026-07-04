// T12 hardening (2026-07-04): the holdout run died of Opus exhaustion mid-sweep, so A/B/C crashed and
// Arm D silently finished claude-less. These tests cover the three fixes — a pre-run Opus estimate
// (planBench), --resume that keeps already-scored pairs, and the degradation guard that refuses to score
// a run whose provider crashed mid-flight. Scripted adapters only — NO paid calls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planBench, runBench, estimateClaudeCalls, CLAUDE_CALLS_PER_CASE } from '../src/bench/harness.js';
import { BenchResult } from '../src/bench/results.js';
import type { Adapter, ProviderHandle, ProviderId, RunResultAdapter } from '../src/providers/types.js';

// A reviewer/sample prompt → one finding on src.js:5 (matches the seeded bug); cross-exam → CONFIRM; judge → keep.
function scriptedOutput(prompt: string): unknown {
  if (prompt.includes('peer cross-examination')) {
    return { verifications: [{ target_id: 'F1', verdict: 'CONFIRM', evidence: 'real', note: '' }], all_confirmed_justification: 'clearly a real bug' };
  }
  if (prompt.includes('Judge on a code review')) {
    return { adjudications: [], verdict: 'one real defect', dissent: ['maybe intended'], confidence_notes: 'HIGH' };
  }
  return { task_echo: 'review', findings: [{ id: 'F1', file: 'src.js', line_start: 5, line_end: 5, severity: 'P1', category: 'CORRECTNESS', claim: 'off-by-one', evidence: '<=', suggested_fix: '<', self_confidence: 0.9 }] };
}

/** `fail: true` → every call from this provider crashes (simulates a quota wall for that model). */
function benchAdapter(id: ProviderId, fail = false): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      if (fail) return { ok: false, error: 'CRASH', stderrTail: 'quota exhausted', durationMs: 1 };
      const obj = scriptedOutput(req.prompt);
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function handle(id: ProviderId, fail = false): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return { id, adapter: benchAdapter(id, fail), flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
}

async function writeCase(root: string, set: string, name: string): Promise<void> {
  const dir = join(root, 'bench', 'sets', 'code-review', set, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'src.js'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  await writeFile(join(dir, 'diff.patch'), ['diff --git a/src.js b/src.js', '--- /dev/null', '+++ b/src.js', '@@ -0,0 +1,10 @@'].join('\n') + '\n');
  await writeFile(join(dir, 'bugs.json'), JSON.stringify({ bugs: [{ id: 'B1', file: 'src.js', line_start: 5, line_end: 5, category: 'CORRECTNESS' }] }));
}

function armScore(result: BenchResult['cases'][number] | undefined, arm: string) {
  return result?.arms.find((a) => a.arm === arm);
}

// ── pure estimate ─────────────────────────────────────────────────────────────

describe('estimateClaudeCalls', () => {
  it('sums the per-arm per-case claude cost over the pairs to run', () => {
    const pairs = [{ arm: 'A' as const }, { arm: 'C' as const }, { arm: 'D' as const }];
    expect(estimateClaudeCalls(pairs)).toBe(CLAUDE_CALLS_PER_CASE.A + CLAUDE_CALLS_PER_CASE.C + CLAUDE_CALLS_PER_CASE.D);
  });
  it('C (3 samples + judge) is the most Opus-hungry arm', () => {
    expect(CLAUDE_CALLS_PER_CASE.C).toBeGreaterThan(CLAUDE_CALLS_PER_CASE.A);
    expect(CLAUDE_CALLS_PER_CASE.C).toBeGreaterThan(CLAUDE_CALLS_PER_CASE.D);
  });
});

describe('bench hardening (scripted adapters)', () => {
  let root: string;
  const handles = () => [handle('claude'), handle('codex'), handle('agy')];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-bench-h-'));
    await writeCase(root, 'holdout', '01-a');
    await writeCase(root, 'holdout', '02-b');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  // ── planBench (pre-run Opus estimate, §19) ──────────────────────────────────

  it('planBench estimates the ≈Opus cost of every case×arm pair without running anything', async () => {
    const plan = await planBench({ suite: 'code-review', set: 'holdout', arms: ['A', 'B', 'C', 'D'], root, handles: handles() });
    expect(plan.cases).toEqual(['01-a', '02-b']);
    expect(plan.toRun).toHaveLength(8); // 2 cases × 4 arms
    expect(plan.estClaudeCalls).toBe(2 * (CLAUDE_CALLS_PER_CASE.A + CLAUDE_CALLS_PER_CASE.B + CLAUDE_CALLS_PER_CASE.C + CLAUDE_CALLS_PER_CASE.D));
    expect(plan.resumedFrom).toBeUndefined();
    // planning wrote no results file
    await expect(readFile(join(root, 'bench', 'results', `code-review-${new Date().toISOString().slice(0, 10)}.json`), 'utf8')).rejects.toThrow();
  });

  it('planBench excludes arms whose providers are unavailable from the estimate', async () => {
    const plan = await planBench({ suite: 'code-review', set: 'holdout', arms: ['A', 'D'], root, handles: [handle('claude')] });
    expect(plan.toRun.map((p) => p.arm)).toEqual(['A', 'A']); // D needs codex → excluded
    expect(plan.skipUnavailable).toBe(2);
    expect(plan.estClaudeCalls).toBe(2 * CLAUDE_CALLS_PER_CASE.A);
  });

  // ── degradation guard ───────────────────────────────────────────────────────

  it('refuses to score Arm D when a reviewer crashes mid-run (no silent claude-less result)', async () => {
    const result = await runBench({ suite: 'code-review', set: 'holdout', arms: ['D'], root, handles: [handle('claude', true), handle('codex'), handle('agy')] });
    const d = armScore(result.cases[0], 'D');
    expect(d!.status).toBe('error');
    expect(d!.reason).toContain('DEGRADED');
    expect(d!.reason).toContain('claude');
    expect(result.summary.find((r) => r.arm === 'D')!.cases).toBe(0); // degraded runs don't inflate the rollup
  });

  it('a single-call arm whose claude crashes fails hard (not a degraded partial)', async () => {
    const result = await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: [handle('claude', true), handle('codex'), handle('agy')] });
    const a = armScore(result.cases[0], 'A');
    expect(a!.status).toBe('error');
    expect(a!.reason).not.toContain('DEGRADED');
  });

  // ── resume ──────────────────────────────────────────────────────────────────

  it('resume keeps already-scored pairs (never re-spends Opus on completed work)', async () => {
    // Run 1: succeeds on both cases.
    const first = await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: handles() });
    expect(armScore(first.cases[0], 'A')!.status).toBe('scored');
    expect(armScore(first.cases[1], 'A')!.status).toBe('scored');

    // Run 2: resume with a crashing claude — completed pairs must be reused, so the crash is never hit.
    const second = await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, resume: true, handles: [handle('claude', true), handle('codex'), handle('agy')] });
    expect(armScore(second.cases[0], 'A')!.status).toBe('scored');
    expect(armScore(second.cases[1], 'A')!.status).toBe('scored');
    expect(armScore(second.cases[0], 'A')!.matched).toBe(1);
  });

  it('resume retries a previously-failed pair', async () => {
    const first = await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: [handle('claude', true), handle('codex'), handle('agy')] });
    expect(armScore(first.cases[0], 'A')!.status).toBe('error');

    const second = await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, resume: true, handles: handles() });
    const a = armScore(second.cases[0], 'A');
    expect(a!.status).toBe('scored');
    expect(a!.recall).toBe(1);

    // resume kept writing to the same campaign file (didn't fork a second results file)
    const parsed = BenchResult.safeParse(JSON.parse(await readFile(join(root, 'bench', 'results', `code-review-${new Date().toISOString().slice(0, 10)}.json`), 'utf8')));
    expect(parsed.success).toBe(true);
  });

  it('a narrower --arms resume carries prior scored pairs of other arms into the rewritten file', async () => {
    // Window 1: arm A on both cases. Window 2: arm B only — the file rewrite must not drop A's data.
    await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: handles() });
    await runBench({ suite: 'code-review', set: 'holdout', arms: ['B'], root, resume: true, handles: handles() });

    const today = new Date().toISOString().slice(0, 10);
    const written = BenchResult.parse(JSON.parse(await readFile(join(root, 'bench', 'results', `code-review-${today}.json`), 'utf8')));
    for (const pc of written.cases) {
      expect(pc.arms.find((a) => a.arm === 'B')!.status).toBe('scored'); // newly run
      expect(pc.arms.find((a) => a.arm === 'A')!.status).toBe('scored'); // carried forward, not dropped
    }
  });

  it('a resumed run keeps prior cases the current set no longer contains (no silent data loss on rewrite)', async () => {
    await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: handles() });
    await rm(join(root, 'bench', 'sets', 'code-review', 'holdout', '02-b'), { recursive: true }); // case dir gone
    await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, resume: true, handles: handles() });

    const today = new Date().toISOString().slice(0, 10);
    const written = BenchResult.parse(JSON.parse(await readFile(join(root, 'bench', 'results', `code-review-${today}.json`), 'utf8')));
    expect(written.cases.map((c) => c.case).sort()).toEqual(['01-a', '02-b']); // prior 02-b data preserved
    expect(written.cases.find((c) => c.case === '02-b')!.arms[0]!.status).toBe('scored');
  });

  it('resume ignores an archived .void.json (only real <suite>-YYYY-MM-DD.json is a campaign file)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const voided: BenchResult = {
      suite: 'code-review',
      set: 'holdout',
      at: new Date().toISOString(),
      arms: ['A'],
      cases: [{ case: '01-a', seeded: 1, arms: [{ arm: 'A', status: 'scored', seeded: 1, matched: 1, recall: 1, reported: 1, unmatched: 0, precision: null, calls: 1, wallMs: 1 }] }],
      summary: [],
    };
    await mkdir(join(root, 'bench', 'results'), { recursive: true });
    await writeFile(join(root, 'bench', 'results', `code-review-${today}.void.json`), JSON.stringify(voided));

    const plan = await planBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, resume: true, handles: handles() });
    expect(plan.resumedFrom).toBeUndefined(); // the archived void run is not resumed
    expect(plan.skipCompleted).toBe(0);
    expect(plan.toRun).toHaveLength(2);
  });

  it('planBench in resume mode reports completed pairs as skipped, shrinking the estimate', async () => {
    await runBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, handles: handles() });
    const plan = await planBench({ suite: 'code-review', set: 'holdout', arms: ['A'], root, resume: true, handles: handles() });
    expect(plan.skipCompleted).toBe(2); // both cases already scored
    expect(plan.toRun).toHaveLength(0);
    expect(plan.estClaudeCalls).toBe(0);
    expect(plan.resumedFrom).toBeDefined();
  });
});
