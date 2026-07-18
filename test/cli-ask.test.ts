import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';

import { ask } from '../src/cli/run.js';

// Regression for the live "typed Y, got cancelled" bug (2026-07-17): rl.close() inside the
// question callback fired the EOF close-handler, which resolved the promise with '' BEFORE the
// real answer could — so every answer, including Y, read as deny.
function io(): { input: PassThrough; output: PassThrough } {
  return { input: new PassThrough(), output: new PassThrough() };
}

describe('ask', () => {
  it('resolves with the typed answer — Y means Y', async () => {
    const streams = io();
    const pending = ask('allow? [y/N] ', streams);
    streams.input.write('Y\n');
    await expect(pending).resolves.toBe('Y');
  });

  it('stdin EOF (Ctrl+D) resolves empty — the safe deny default', async () => {
    const streams = io();
    const pending = ask('allow? [y/N] ', streams);
    streams.input.end();
    await expect(pending).resolves.toBe('');
  });
});
