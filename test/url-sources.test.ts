import { describe, expect, it } from 'vitest';

import { extractPublicUrls, snapshotUrlSources } from '../src/orchestration/url-sources.js';

describe('URL source snapshots', () => {
  it('extracts, cleans, and deduplicates public links', () => {
    expect(extractPublicUrls('Read https://example.com/rules, then https://example.com/rules and https://npmjs.com/package/aiki-cli.')).toEqual([
      'https://example.com/rules',
      'https://npmjs.com/package/aiki-cli',
    ]);
  });

  it('uses the npm registry adapter instead of scraping the package page', async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        name: 'aiki-cli',
        version: '0.3.0',
        description: 'Local-first model council.',
        readme: '# Aiki\nUses installed provider CLIs.',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await snapshotUrlSources('See https://www.npmjs.com/package/aiki-cli', {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(requested).toEqual(['https://registry.npmjs.org/aiki-cli/latest']);
    expect(result.sources[0]).toMatchObject({
      id: 'U1',
      url: 'https://www.npmjs.com/package/aiki-cli',
      final_url: 'https://registry.npmjs.org/aiki-cli/latest',
      status: 'FETCHED',
      title: 'aiki-cli 0.3.0',
    });
    expect(result.sources[0]?.content).toContain('Local-first model council.');
  });

  it('extracts readable HTML and records Cloudflare blocks honestly', async () => {
    const responses = [
      new Response('<html><head><title>Rules</title><script>ignore()</script></head><body><h1>Six lenses</h1><p>Live URL required.</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      new Response('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      }),
    ];
    const fetchImpl = async (): Promise<Response> => responses.shift()!;

    const fetched = await snapshotUrlSources('https://example.com/rules', { fetchImpl: fetchImpl as typeof fetch });
    expect(fetched.sources[0]).toMatchObject({ status: 'FETCHED', title: 'Rules' });
    expect(fetched.sources[0]?.content).toContain('Six lenses Live URL required.');
    expect(fetched.sources[0]?.content).not.toContain('ignore');

    const blocked = await snapshotUrlSources('https://example.com/protected', { fetchImpl: fetchImpl as typeof fetch });
    expect(blocked.sources[0]).toMatchObject({ status: 'BLOCKED' });
    expect(blocked.sources[0]?.error).toContain('blocked automated access');
  });

  it('never fetches private-network URLs', async () => {
    let called = false;
    const fetchImpl = async (): Promise<Response> => {
      called = true;
      return new Response('secret');
    };
    const result = await snapshotUrlSources('http://127.0.0.1:3000/private', { fetchImpl: fetchImpl as typeof fetch });

    expect(called).toBe(false);
    expect(result.sources[0]).toMatchObject({ status: 'FAILED' });
    expect(result.sources[0]?.error).toContain('private or local');
  });

  it('caps streamed responses even when content-length is absent', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('x'.repeat(500_001), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    const result = await snapshotUrlSources('https://example.com/huge', { fetchImpl: fetchImpl as typeof fetch });

    expect(result.sources[0]).toMatchObject({ status: 'FAILED' });
    expect(result.sources[0]?.error).toContain('response exceeds 500000 bytes');
  });
});
