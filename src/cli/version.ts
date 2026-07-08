import { readFileSync } from 'node:fs';

export function readPackageVersion(metaUrl = import.meta.url): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', metaUrl), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error('package.json version missing');
  return pkg.version;
}

export const VERSION = readPackageVersion();
