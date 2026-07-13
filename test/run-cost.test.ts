// V5 — run-cost preview estimate (the confirm prompt itself is a thin readline shell, not unit-tested).
import { describe, it, expect } from 'vitest';
import { estimateRun } from '../src/cli/run.js';

describe('estimateRun', () => {
  it('idea-refinement defaults to the 6-8 call council plan with two reserved tail calls', () => {
    expect(estimateRun('idea-refinement')).toEqual({ calls: 8, minCalls: 6, opus: 2, reserved: 2 });
    expect(estimateRun('idea-refinement', { mode: 'quick' })).toEqual({ calls: 3, minCalls: 3, opus: 1, reserved: 0 });
    expect(estimateRun('idea-refinement', { mode: 'research' })).toEqual({ calls: 10, minCalls: 8, opus: 2, reserved: 2 });
  });
  it('code-review ≈ 5 calls, 2 on Opus; --cheap drops Opus to ~1', () => {
    expect(estimateRun('code-review')).toEqual({ calls: 5, opus: 2 });
    expect(estimateRun('code-review', { cheap: true })).toEqual({ calls: 5, opus: 1 });
  });
});
