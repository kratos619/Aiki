// V4 — coverage-hole detector + Arm L scripted E2E (BENCHMARK.md L1). No paid calls.
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCoverageHoles, RISK_DEFS, scopeDiff } from '../src/orchestration/stages/cr-ladder.js';
import { runBench } from '../src/bench/harness.js';
import type { Finding } from '../src/schemas/index.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import type { ProviderHandle } from '../src/orchestration/context.js';

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

  it('scopes a targeted prompt to the requested diff files', () => {
    const full = `${diff('src/auth/login.ts', 'return req.user;')}\n${diff('src/util/format.ts', 'return name.trim();')}`;
    const scoped = scopeDiff(full, ['src/auth/login.ts']);
    expect(scoped).toContain('src/auth/login.ts');
    expect(scoped).not.toContain('src/util/format.ts');
  });
});

const securityFinding = (): Finding => ({
  id: 'F1',
  file: 'src/auth/login.ts',
  line_start: 2,
  line_end: 2,
  severity: 'P1',
  category: 'SECURITY',
  claim: 'authentication accepts an unverified user',
  evidence: 'the added branch trusts req.user without validation',
  suggested_fix: 'verify the authenticated principal before granting access',
  self_confidence: 0.95,
});

async function writeAuthCase(root: string): Promise<void> {
  const dir = join(root, 'bench', 'sets', 'code-review', 'build', 'auth-hole');
  await mkdir(join(dir, 'src', 'auth'), { recursive: true });
  await writeFile(join(dir, 'src', 'auth', 'login.ts'), ['export function login(req: any) {', '  if (req.user) return true;', '  return false;', '}', ''].join('\n'));
  await writeFile(
    join(dir, 'diff.patch'),
    [
      'diff --git a/src/auth/login.ts b/src/auth/login.ts',
      '--- /dev/null',
      '+++ b/src/auth/login.ts',
      '@@ -0,0 +1,4 @@',
      '+export function login(req: any) {',
      '+  if (req.user) return true;',
      '+  return false;',
      '+}',
    ].join('\n'),
  );
  await writeFile(join(dir, 'bugs.json'), JSON.stringify({ bugs: [{ id: 'B1', file: 'src/auth/login.ts', line_start: 2, line_end: 2, category: 'SECURITY' }] }));
}

function ladderHandles(covered: boolean, calls: Array<{ provider: ProviderId; prompt: string }>): ProviderHandle[] {
  const adapter = (id: ProviderId): Adapter => ({
    id,
    run: async (req): Promise<RunResultAdapter> => {
      calls.push({ provider: id, prompt: req.prompt });
      let output: unknown;
      if (req.prompt.includes('targeted coverage-hole reviewer')) {
        output = {
          task_echo: 'targeted auth review',
          findings: [securityFinding(), { ...securityFinding(), id: 'F2', file: 'src/other.ts' }],
        };
      } else if (req.prompt.includes('peer cross-examination')) {
        output = {
          verifications: [{ target_id: 'F1', verdict: 'CONFIRM', evidence: 'src/auth/login.ts:2 trusts req.user', note: '' }],
          all_confirmed_justification: 'F1 is weakest but line 2 still trusts an unverified principal.',
        };
      } else if (req.prompt.includes('Judge on a code review')) {
        output = { adjudications: [], verdict: 'one real defect', dissent: ['possibly intended'], confidence_notes: 'HIGH' };
      } else {
        output = { task_echo: 'tier-1 review', findings: covered && id === 'agy' ? [securityFinding()] : [] };
      }
      return { ok: true, text: JSON.stringify(output), json: output, durationMs: 1 };
    },
  });
  return (['claude', 'codex', 'agy'] as ProviderId[]).map((id) => {
    const readOnly = id === 'claude' ? 'plan' : 'sandbox';
    return { id, adapter: adapter(id), flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly }, readOnly, version: '9.9.9' };
  });
}

describe('Arm L targeted escalation (scripted adapters)', () => {
  it('an uncovered auth risk triggers exactly one Claude hunt and merges its validated finding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiki-ladder-hole-'));
    const calls: Array<{ provider: ProviderId; prompt: string }> = [];
    try {
      await writeAuthCase(root);
      const result = await runBench({ suite: 'code-review', set: 'build', arms: ['L'], root, handles: ladderHandles(false, calls) });
      const score = result.cases[0]!.arms[0]!;
      expect(score).toMatchObject({ arm: 'L', status: 'scored', matched: 1, reported: 1 });
      expect(calls.filter((c) => c.provider === 'claude')).toHaveLength(1);
      expect(calls.find((c) => c.provider === 'claude')!.prompt).toContain('targeted coverage-hole reviewer');

      const map = JSON.parse(await readFile(join(root, '.aiki', 'runs', score.runId!, '07-review-map.json'), 'utf8'));
      expect(map.single_reviewer).toHaveLength(1);
      expect(map.single_reviewer[0]).toMatchObject({ reviewers: ['claude'], finding: { file: 'src/auth/login.ts', category: 'SECURITY' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a tier-1 SECURITY finding covers the auth risk, so Claude receives zero calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiki-ladder-covered-'));
    const calls: Array<{ provider: ProviderId; prompt: string }> = [];
    try {
      await writeAuthCase(root);
      const result = await runBench({ suite: 'code-review', set: 'build', arms: ['L'], root, handles: ladderHandles(true, calls) });
      const score = result.cases[0]!.arms[0]!;
      expect(score).toMatchObject({ arm: 'L', status: 'scored', matched: 1, reported: 1 });
      expect(calls.filter((c) => c.provider === 'claude')).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
