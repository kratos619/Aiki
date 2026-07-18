import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type ReplayFixture = {
  schemaVersion: number;
  kind: string;
  label: string;
  session: { id: string; status: string; resumed: boolean };
  warnings: Array<{ code: string }>;
  activity: Array<{ sequence: number; stage: string; status: string }>;
  result: { confidence: { score: number; label: string } };
  audit: { storedDisagreements: number; semanticClaimGroups: number };
  receipt: { calls: number; byProvider: Record<string, number> };
};

const fixture = JSON.parse(
  readFileSync(new URL('../docs/replay/a694.json', import.meta.url), 'utf8'),
) as ReplayFixture;
const page = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../docs/replay.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../docs/replay.css', import.meta.url), 'utf8');

function visit(value: unknown, keys: string[], strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, keys, strings));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      visit(item, keys, strings);
    }
  }
}

describe('hackathon replay fixture', () => {
  it('pins the truthful a694 replay contract', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.kind).toBe('recorded-run');
    expect(fixture.label).toBe('Recorded real run — no models are running.');
    expect(fixture.session).toEqual(expect.objectContaining({
      id: '20260718-1741-idea-refinement-a694',
      status: 'complete',
      resumed: true,
    }));
    expect(fixture.activity.map(({ sequence, stage, status }) => ({ sequence, stage, status }))).toEqual([
      { sequence: 1, stage: 'preflight', status: 'complete' },
      { sequence: 2, stage: 'analysis', status: 'complete' },
      { sequence: 3, stage: 'drift', status: 'complete' },
      { sequence: 4, stage: 'positions', status: 'complete' },
      { sequence: 5, stage: 'graph', status: 'complete' },
      { sequence: 6, stage: 'verification', status: 'complete' },
      { sequence: 7, stage: 'rebuttal', status: 'complete' },
      { sequence: 8, stage: 'judge', status: 'complete' },
      { sequence: 9, stage: 'plan', status: 'complete' },
      { sequence: 10, stage: 'report', status: 'complete' },
    ]);
    expect(fixture.audit).toEqual(expect.objectContaining({
      storedDisagreements: 0,
      semanticClaimGroups: 3,
    }));
    expect(fixture.result.confidence).toEqual({ score: 8, label: 'Low' });
    expect(fixture.receipt).toEqual(expect.objectContaining({ calls: 2, byProvider: { Claude: 2 } }));
    expect(fixture.warnings.map(({ code }) => code)).toEqual([
      'headless_intent',
      'source_fallback_search',
      'research_ungrounded',
    ]);
  });

  it('contains no local paths or forbidden browser projection keys', () => {
    const keys: string[] = [];
    const strings: string[] = [];
    visit(fixture, keys, strings);

    expect(keys).not.toEqual(expect.arrayContaining([
      'cwd',
      'runsRoot',
      'prompt',
      'rawOutput',
      'providerOutput',
      'artifactPath',
    ]));
    expect(strings.join('\n')).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|\.aiki\/)/);
  });

  it('keeps the public replay static, explicit, and responsive', () => {
    expect(page).toContain('Recorded real run — no models are running.');
    expect(page).not.toMatch(/<(?:input|textarea)\b/i);
    expect(script.match(/\bfetch\s*\(/g)).toHaveLength(1);
    expect(script).toContain("const REPLAY_PATH = './replay/a694.json';");
    expect(script).not.toMatch(/(?:\/api\/|EventSource|WebSocket|https?:\/\/)/);
    expect(styles).toContain('@media (max-width: 1199px)');
    expect(styles).toContain('@media (max-width: 767px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
