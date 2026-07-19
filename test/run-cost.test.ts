// V5 — run-cost preview estimate (the confirm prompt itself is a thin readline shell, not unit-tested).
import { describe, it, expect } from 'vitest';
import { estimateRun } from '../src/cli/run.js';

describe('estimateRun', () => {
  it('idea-refinement gives council and its research alias the same 8-10 call plan', () => {
    const fullCouncil = { calls: 10, minCalls: 7, opus: 2, reserved: 3 }; // v6: 3-call tail reserve
    expect(estimateRun('idea-refinement')).toEqual(fullCouncil);
    expect(estimateRun('idea-refinement', { mode: 'quick' })).toEqual({ calls: 3, minCalls: 3, opus: 1, reserved: 0 });
    expect(estimateRun('idea-refinement', { mode: 'quick', auto: true, fastPath: true })).toEqual({ calls: 4, minCalls: 1, opus: 1, reserved: 0 });
    expect(estimateRun('idea-refinement', { mode: 'council', auto: true })).toEqual({ calls: 4, minCalls: 3, opus: 1, reserved: 0 });
    expect(estimateRun('idea-refinement', { mode: 'council' })).toEqual(fullCouncil);
    expect(estimateRun('idea-refinement', { mode: 'research' })).toEqual(fullCouncil);
  });
  it('code-review ≈ 5 calls, 2 on Opus; --cheap drops Opus to ~1', () => {
    expect(estimateRun('code-review')).toEqual({ calls: 5, opus: 2 });
    expect(estimateRun('code-review', { cheap: true })).toEqual({ calls: 5, opus: 1 });
  });
});
