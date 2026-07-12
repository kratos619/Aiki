import { describe, expect, it } from 'vitest';

import { preflightLine } from '../src/cli/doctor.js';
import type { Detection } from '../src/providers/types.js';

const ready: Detection = { id: 'claude', status: 'READY', version: '2.1.201' };

describe('preflightLine (aiki startup doctor rows)', () => {
  it('reports a passing provider with its smoke timing', () => {
    const line = preflightLine({ det: ready, smoke: { ok: true, nonce: 'n', durationMs: 1234 } });
    expect(line.ok).toBe(true);
    expect(line.label).toContain('Claude 2.1.201');
    expect(line.label).toContain('1.2s');
    expect(line.fix).toBeUndefined();
  });

  it('marks a cached smoke result so the user knows no call was made', () => {
    const line = preflightLine({ det: ready, smoke: { ok: true, nonce: 'n', durationMs: 900 }, cached: true });
    expect(line.ok).toBe(true);
    expect(line.label).toContain('cached');
  });

  it('reports a missing CLI with its install hint as the fix', () => {
    const line = preflightLine({ det: { id: 'codex', status: 'NOT_INSTALLED', hint: 'npm install -g @openai/codex' } });
    expect(line.ok).toBe(false);
    expect(line.label).toContain('not installed');
    expect(line.fix).toBe('npm install -g @openai/codex');
  });

  it('maps an auth smoke failure to a login fix', () => {
    const line = preflightLine({ det: { id: 'codex', status: 'READY', version: '0.144.1' }, smoke: { ok: false, nonce: 'n', durationMs: 10, error: 'AUTH' } });
    expect(line.ok).toBe(false);
    expect(line.label).toContain('auth failed');
    expect(line.fix).toContain('log in');
  });

  it('maps a quota smoke failure to a retry-later fix', () => {
    const line = preflightLine({ det: { id: 'agy', status: 'READY', version: '1.0.16' }, smoke: { ok: false, nonce: 'n', durationMs: 10, error: 'QUOTA' } });
    expect(line.ok).toBe(false);
    expect(line.label).toContain('quota');
    expect(line.fix).toContain('retry later');
  });
});
