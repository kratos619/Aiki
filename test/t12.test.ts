import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadCases } from '../src/bench/harness.js';
import { FindingCategory } from '../src/schemas/index.js';

// T12 — the frozen 10-diff code-review HOLDOUT set. This test does NOT run any arm (no paid calls);
// it only asserts the ground truth is well-formed and every seeded bug is locatable in its source
// file, so the ONE metered holdout eval scores against a valid set. BENCHMARK.md forbids editing the
// pipeline after the first holdout run — this guards the *data*, not the pipeline.

describe('code-review holdout set (frozen, T12)', () => {
  it('has exactly 10 cases, each a whole-file-add diff with a matching bugs.json', async () => {
    const cases = await loadCases('code-review', 'holdout');
    expect(cases).toHaveLength(10);
    for (const c of cases) {
      expect(c.diff).toContain('+++ b/'); // whole-file add → every seeded line is a reviewable change
      expect(c.bugs.length).toBeGreaterThanOrEqual(4); // §17: 4–6 seeded bugs per diff
      expect(c.bugs.length).toBeLessThanOrEqual(6);
    }
  });

  it('every seeded bug is locatable: file exists in the case dir, lines in-bounds, valid category', async () => {
    const cases = await loadCases('code-review', 'holdout');
    const validCategories = FindingCategory.options;
    for (const c of cases) {
      for (const bug of c.bugs) {
        const src = await readFile(join(c.dir, bug.file), 'utf8'); // throws if the seeded file is missing
        const lineCount = src.split('\n').length;
        expect(validCategories, `${c.name}/${bug.id} category`).toContain(bug.category);
        expect(bug.line_start, `${c.name}/${bug.id} line_start`).toBeGreaterThanOrEqual(1);
        expect(bug.line_start, `${c.name}/${bug.id} start<=end`).toBeLessThanOrEqual(bug.line_end);
        expect(bug.line_end, `${c.name}/${bug.id} line_end in-bounds`).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it('collectively seeds all five canonical bug classes across the six categories', async () => {
    const cases = await loadCases('code-review', 'holdout');
    const categories = new Set(cases.flatMap((c) => c.bugs.map((b) => b.category)));
    // The 5 canonical classes map to these enums (STATE.md); the set must cover each at least once.
    for (const cat of ['CORRECTNESS', 'SECURITY', 'CONCURRENCY', 'ERROR_HANDLING', 'PERF']) {
      expect(categories, `set is missing ${cat}`).toContain(cat);
    }
    const total = cases.reduce((n, c) => n + c.bugs.length, 0);
    expect(total).toBeGreaterThanOrEqual(40); // 10 diffs × 4–6 bugs
  });
});
