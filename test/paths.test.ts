// Hybrid runs-root resolution (V6): inside a git repo → <repoRoot>/.aiki; otherwise → ~/.aiki.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';

import { homeAikiRoot, resolveRunsRoot } from '../src/storage/paths.js';

describe('resolveRunsRoot (hybrid storage)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'aiki-paths-')));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('homeAikiRoot is ~/.aiki', () => {
    expect(homeAikiRoot()).toBe(join(homedir(), '.aiki'));
  });

  it('inside a git repo → <repoRoot>/.aiki (even from a subdir)', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    const sub = join(dir, 'a', 'b');
    await mkdir(sub, { recursive: true });
    expect(await resolveRunsRoot(dir)).toBe(join(dir, '.aiki'));
    expect(await resolveRunsRoot(sub)).toBe(join(dir, '.aiki')); // resolves to the repo top, not the subdir
  });

  it('outside any git repo → ~/.aiki', async () => {
    // A bare temp dir under /tmp is not a git repo.
    expect(await resolveRunsRoot(dir)).toBe(homeAikiRoot());
  });
});
