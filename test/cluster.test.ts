import { describe, it, expect } from 'vitest';
import { clusterInterpretations, majorityClusterIndex, overlap, tokenize } from '../src/orchestration/cluster.js';

describe('tokenize / overlap', () => {
  it('is case- and punctuation-insensitive on a token SET', () => {
    expect([...tokenize('Build a Local CLI!')].sort()).toEqual(['a', 'build', 'cli', 'local']);
  });

  it('Jaccard: identical sets = 1, disjoint = 0', () => {
    expect(overlap(tokenize('a b c'), tokenize('a b c'))).toBe(1);
    expect(overlap(tokenize('a b'), tokenize('x y'))).toBe(0);
  });

  it('partial overlap is between 0 and 1', () => {
    // {a,b,c} vs {a,b,d}: inter 2, union 4 → 0.5
    expect(overlap(tokenize('a b c'), tokenize('a b d'))).toBeCloseTo(0.5);
  });
});

describe('clusterInterpretations', () => {
  it('groups near-identical restatements into one cluster', () => {
    const clusters = clusterInterpretations([
      { key: 'agy', text: 'build a local multi model orchestration cli' },
      { key: 'codex', text: 'build a local multi model orchestration cli tool' },
      { key: 'claude', text: 'build a local multi model orchestration cli' },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toEqual(['agy', 'codex', 'claude']);
  });

  it('separates a divergent restatement and majority picks the larger cluster', () => {
    const clusters = clusterInterpretations([
      { key: 'agy', text: 'build a local orchestration cli for developers' },
      { key: 'codex', text: 'build a local orchestration cli for developers' },
      { key: 'claude', text: 'write a cloud hosted chat product for consumers' },
    ]);
    expect(clusters).toHaveLength(2);
    expect(majorityClusterIndex(clusters)).toBe(0);
    expect(clusters[0]!.members).toEqual(['agy', 'codex']);
  });

  it('honors the threshold (higher threshold splits more)', () => {
    const items = [
      { key: 'a', text: 'a b c d e' },
      { key: 'b', text: 'a b c x y' }, // overlap 3/7 ≈ 0.43
    ];
    expect(clusterInterpretations(items, 0.4)).toHaveLength(1);
    expect(clusterInterpretations(items, 0.6)).toHaveLength(2);
  });
});
