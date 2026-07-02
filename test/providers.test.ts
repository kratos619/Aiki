import { describe, it, expect } from 'vitest';
import { detect, parseVersion } from '../src/providers/detect.js';
import { parseFlagProfile, probeFlags } from '../src/providers/probe.js';
import type { RunResult } from '../src/providers/types.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false });
const missing = (): RunResult => ({ code: null, stdout: '', stderr: '', timedOut: false, notFound: true });

describe('parseVersion', () => {
  it('extracts semver from each CLI format', () => {
    expect(parseVersion('2.1.198 (Claude Code)')).toBe('2.1.198');
    expect(parseVersion('codex-cli 0.135.0')).toBe('0.135.0');
    expect(parseVersion('0.46.0')).toBe('0.46.0');
  });
  it('returns undefined when no version present', () => {
    expect(parseVersion('no version here')).toBeUndefined();
  });
});

describe('detect', () => {
  it('NOT_INSTALLED with actionable hint when binary missing', async () => {
    const d = await detect('codex', async () => missing());
    expect(d.status).toBe('NOT_INSTALLED');
    expect(d.hint).toMatch(/install/i);
  });
  it('READY with parsed version when present', async () => {
    const d = await detect('claude', async () => ok('2.1.198 (Claude Code)'));
    expect(d.status).toBe('READY');
    expect(d.version).toBe('2.1.198');
  });
});

describe('parseFlagProfile', () => {
  it('claude: --permission-mode → plan; --output-format → json', () => {
    const p = parseFlagProfile('claude', '--output-format <fmt>\n--permission-mode <mode>');
    expect(p).toEqual({ id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' });
  });
  it('codex: --sandbox → sandbox; --json → json', () => {
    const p = parseFlagProfile('codex', '-s, --sandbox <MODE>\n--json');
    expect(p).toEqual({ id: 'codex', jsonOutput: true, readOnlyFlag: 'sandbox' });
  });
  it('gemini: --approval-mode → approval-plan; -o/--output-format → json', () => {
    const p = parseFlagProfile('gemini', '--approval-mode\n-o, --output-format');
    expect(p).toEqual({ id: 'gemini', jsonOutput: true, readOnlyFlag: 'approval-plan' });
  });
  it('reports none/false when flags absent (truncated/drift)', () => {
    expect(parseFlagProfile('claude', 'partial help').readOnlyFlag).toBe('none');
    expect(parseFlagProfile('claude', 'partial help').jsonOutput).toBe(false);
  });
});

describe('probeFlags', () => {
  it('routes captured help through parseFlagProfile', async () => {
    const p = await probeFlags('gemini', async () => '--approval-mode\n--output-format');
    expect(p.readOnlyFlag).toBe('approval-plan');
    expect(p.jsonOutput).toBe(true);
  });
});
