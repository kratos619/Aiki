// V5 — run-cost preview estimate (the confirm prompt itself is a thin readline shell, not unit-tested).
import { describe, it, expect } from 'vitest';
import { estimateRun } from '../src/cli/run.js';

describe('estimateRun', () => {
  it('idea-refinement ≈ 12 calls, 4 on Opus', () => {
    expect(estimateRun('idea-refinement')).toEqual({ calls: 12, opus: 4 });
  });
  it('code-review ≈ 5 calls, 2 on Opus; --cheap drops Opus to ~1', () => {
    expect(estimateRun('code-review')).toEqual({ calls: 5, opus: 2 });
    expect(estimateRun('code-review', { cheap: true })).toEqual({ calls: 5, opus: 1 });
  });
});
