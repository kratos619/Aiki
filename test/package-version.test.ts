import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/cli/version.js';

describe('CLI package version', () => {
  it('reports the package.json version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
