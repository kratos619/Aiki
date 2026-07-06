// V4 — coverage-hole detector (BENCHMARK.md L1). Pure; no model calls.
import { describe, it, expect } from 'vitest';
import { detectCoverageHoles, RISK_DEFS } from '../src/orchestration/stages/cr-ladder.js';
import type { Finding } from '../src/schemas/index.js';

const F = (category: Finding['category'], file: string) => ({ category, file });

/** Minimal unified diff touching one HEAD file with a couple of added lines. */
const diff = (file: string, ...added: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,3 @@', ' ctx', ...added.map((l) => `+${l}`)].join('\n');

describe('detectCoverageHoles (L1)', () => {
  it('auth file touched + no SECURITY finding → auth hole scoped to that file', () => {
    const holes = detectCoverageHoles(diff('src/auth/login.ts', 'const ok = pw === input;'), []);
    expect(holes.map((h) => h.risk)).toContain('auth');
    expect(holes.find((h) => h.risk === 'auth')!.files).toEqual(['src/auth/login.ts']);
  });

  it('a SECURITY finding INSIDE the risk file covers it → no auth hole', () => {
    const holes = detectCoverageHoles(diff('src/auth/login.ts', 'const ok = pw === input;'), [F('SECURITY', 'src/auth/login.ts')]);
    expect(holes.map((h) => h.risk)).not.toContain('auth');
  });

  it('a SECURITY finding in a DIFFERENT file does NOT cover the auth hunk → still a hole', () => {
    const holes = detectCoverageHoles(diff('src/auth/login.ts', 'const ok = pw === input;'), [F('SECURITY', 'src/other.ts')]);
    expect(holes.map((h) => h.risk)).toContain('auth');
  });

  it('async keyword in an ordinary file (no risk glob) + no CONCURRENCY finding → async hole (whole-diff scope)', () => {
    const holes = detectCoverageHoles(diff('src/util/fetch.ts', 'const data = await fetch(url);'), [F('CORRECTNESS', 'src/util/fetch.ts')]);
    expect(holes.map((h) => h.risk)).toContain('async');
    expect(holes.find((h) => h.risk === 'async')!.files).toEqual(['src/util/fetch.ts']);
  });

  it('payment file + a CORRECTNESS finding in it → covered (payment accepts CORRECTNESS or SECURITY)', () => {
    const holes = detectCoverageHoles(diff('src/billing/charge.ts', 'const total = qty * price;'), [F('CORRECTNESS', 'src/billing/charge.ts')]);
    expect(holes.map((h) => h.risk)).not.toContain('payment');
  });

  it('a clean, non-risky diff → no holes', () => {
    const holes = detectCoverageHoles(diff('src/util/format.ts', 'return name.trim();'), []);
    expect(holes).toEqual([]);
  });

  it('RISK_DEFS covers the four frozen risk classes', () => {
    expect(RISK_DEFS.map((r) => r.id)).toEqual(['auth', 'crypto', 'payment', 'async']);
  });
});
