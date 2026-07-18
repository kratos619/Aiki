import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  UrlSourceSet,
  type UrlSourceSet as UrlSourceSetT,
  type UrlSourceSnapshot,
} from '../schemas/index.js';

const MAX_SOURCES = 5;
const MAX_RESPONSE_BYTES = 500_000;
const MAX_CONTENT_CHARS = 30_000;
const MAX_REDIRECTS = 3;

export interface SnapshotOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function extractPublicUrls(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const cleaned = match.replace(/[.,;:!?\]\)}]+$/g, '');
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
    if (urls.length === MAX_SOURCES) break;
  }
  return urls;
}

function isPrivateAddress(address: string): boolean {
  if (address === '::' || address === '::1') return true;
  if (address.toLowerCase().startsWith('fe80:') || address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd')) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined);
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127)
    || a! >= 224;
}

async function assertPublicUrl(url: URL, resolveHostname: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only public http/https URLs are supported');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '169.254.169.254') {
    throw new Error('private or local URLs are not allowed');
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new Error('private or local URLs are not allowed');
  if (!resolveHostname || isIP(hostname)) return;
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('private or local URLs are not allowed');
  }
}

function npmRegistryUrl(url: URL): string | undefined {
  if (url.hostname !== 'npmjs.com' && url.hostname !== 'www.npmjs.com') return undefined;
  const match = url.pathname.match(/^\/package\/(.+?)\/?$/);
  if (!match) return undefined;
  const name = decodeURIComponent(match[1]!);
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10;
      const value = Number.parseInt(code.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function readableHtml(html: string): { title?: string; content: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : undefined;
  const content = decodeHtml(html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title || undefined, content };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }
}

function failure(
  id: string,
  url: string,
  accessedAt: string,
  status: 'BLOCKED' | 'FAILED',
  error: string,
  finalUrl?: string,
): UrlSourceSnapshot {
  return { id, url, final_url: finalUrl, status, accessed_at: accessedAt, error };
}

async function fetchWithRedirects(
  startUrl: string,
  fetchImpl: typeof fetch,
  resolveHostname: boolean,
): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(startUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertPublicUrl(current, resolveHostname);
    const response = await fetchImpl(current.toString(), {
      redirect: 'manual',
      headers: { accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current.toString() };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current.toString() };
    if (redirect === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    current = new URL(location, current);
  }
  throw new Error('redirect limit exceeded');
}

async function snapshotOne(
  sourceUrl: string,
  index: number,
  options: SnapshotOptions,
): Promise<UrlSourceSnapshot> {
  const id = `U${index + 1}`;
  const accessedAt = (options.now?.() ?? new Date()).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const original = new URL(sourceUrl);
    await assertPublicUrl(original, options.fetchImpl === undefined);
    const adapterUrl = npmRegistryUrl(original);
    const { response, finalUrl } = await fetchWithRedirects(adapterUrl ?? sourceUrl, fetchImpl, options.fetchImpl === undefined);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      return failure(id, sourceUrl, accessedAt, 'FAILED', `response exceeds ${MAX_RESPONSE_BYTES} bytes`, finalUrl);
    }
    const body = await readLimited(response);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'text/plain';
    const blocked = response.status === 403
      || response.status === 429
      || response.status === 503
      || /cdn-cgi\/challenge|just a moment|captcha|access denied/i.test(body);
    if (blocked) {
      return failure(id, sourceUrl, accessedAt, 'BLOCKED', `site blocked automated access (HTTP ${response.status})`, finalUrl);
    }
    if (!response.ok) return failure(id, sourceUrl, accessedAt, 'FAILED', `HTTP ${response.status}`, finalUrl);

    let title: string | undefined;
    let content: string;
    if (adapterUrl) {
      const metadata = JSON.parse(body) as Record<string, unknown>;
      const name = typeof metadata.name === 'string' ? metadata.name : original.pathname.split('/').at(-1) ?? 'npm package';
      const version = typeof metadata.version === 'string' ? metadata.version : 'unknown version';
      title = `${name} ${version}`;
      content = [
        `Package: ${name}`,
        `Version: ${version}`,
        typeof metadata.description === 'string' ? `Description: ${metadata.description}` : '',
        typeof metadata.homepage === 'string' ? `Homepage: ${metadata.homepage}` : '',
        typeof metadata.readme === 'string' ? `README:\n${metadata.readme}` : '',
      ].filter(Boolean).join('\n');
    } else if (contentType === 'text/html' || /<html\b|<body\b/i.test(body)) {
      ({ title, content } = readableHtml(body));
    } else {
      content = body.replace(/\s+/g, ' ').trim();
    }
    content = content.slice(0, MAX_CONTENT_CHARS).trim();
    if (!content) return failure(id, sourceUrl, accessedAt, 'FAILED', 'source contained no readable text', finalUrl);
    return {
      id,
      url: sourceUrl,
      final_url: finalUrl,
      status: 'FETCHED',
      title,
      content_type: contentType,
      accessed_at: accessedAt,
      sha256: sha256(content),
      content,
    };
  } catch (error) {
    return failure(id, sourceUrl, accessedAt, 'FAILED', error instanceof Error ? error.message : String(error));
  }
}

export async function snapshotUrlSources(input: string, options: SnapshotOptions = {}): Promise<UrlSourceSetT> {
  const sources = await Promise.all(extractPublicUrls(input).map((url, index) => snapshotOne(url, index, options)));
  return UrlSourceSet.parse({ sources });
}

/** v6 T10: a URL the user attached is presumptively decision-relevant — if it cannot be read, the
 *  run must stop BEFORE any paid call and ask, instead of spending the full council budget on a
 *  conditional verdict (run f740 burned 12 calls around a 403'd hackathon page). Returns the stop
 *  message, or null to proceed. Quick mode and an explicit override proceed as before. */
export function blockedSourceStop(
  sources: UrlSourceSetT,
  mode: string,
  allowBlockedSources: boolean,
): string | null {
  if (mode === 'quick' || allowBlockedSources) return null;
  const unreadable = sources.sources.filter((source) => source.status !== 'FETCHED');
  if (unreadable.length === 0) return null;
  const details = unreadable.map((source) => `${source.url} (${source.status}${source.error ? `: ${source.error}` : ''})`).join('; ');
  return `a source you attached could not be read — ${details}. The council would have to decide without the fact you attached it for. `
    + 'Paste the relevant text into your idea input and rerun, or rerun with --allow-blocked-sources to proceed without it (the report will be conditional).';
}
