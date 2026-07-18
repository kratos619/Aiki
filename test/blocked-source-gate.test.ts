import { describe, it, expect } from 'vitest';

import { blockedSourceStop } from '../src/orchestration/url-sources.js';
import type { UrlSourceSet } from '../src/schemas/index.js';

// T10 (plan/AIKI-v6-council-integrity-plan.md): run f740 burned 12 calls building a conditional
// verdict around a hackathon page that 403'd — while codex search "fallback" silenced any ask.
// A URL the user attached is presumptively decision-relevant: unreadable → stop BEFORE paid calls.
const f740Snapshot = {
  sources: [
    { id: 'U1', url: 'https://www.npmjs.com/package/aiki-cli', status: 'FETCHED', accessed_at: '2026-07-17T06:49:24.464Z' },
    { id: 'U2', url: 'https://namastedev.com/hackathon', status: 'BLOCKED', accessed_at: '2026-07-17T06:49:24.470Z', error: 'site blocked automated access (HTTP 403)' },
  ],
} as UrlSourceSet;

describe('blockedSourceStop', () => {
  it('REPLAY: the f740 scenario stops before any paid call and says exactly what to do', () => {
    const stop = blockedSourceStop(f740Snapshot, 'council', false);
    expect(stop).toContain('https://namastedev.com/hackathon');
    expect(stop).toContain('HTTP 403');
    expect(stop).toContain('--allow-blocked-sources');
    expect(stop).toContain('Paste the relevant text');
  });

  it('an explicit override proceeds (conditional report)', () => {
    expect(blockedSourceStop(f740Snapshot, 'council', true)).toBeNull();
  });

  it('quick mode proceeds as before', () => {
    expect(blockedSourceStop(f740Snapshot, 'quick', false)).toBeNull();
  });

  it('all sources readable proceeds', () => {
    const readable = { sources: [{ id: 'U1', url: 'https://x.dev', status: 'FETCHED' }] } as UrlSourceSet;
    expect(blockedSourceStop(readable, 'council', false)).toBeNull();
    expect(blockedSourceStop({ sources: [] } as unknown as UrlSourceSet, 'council', false)).toBeNull();
  });
});