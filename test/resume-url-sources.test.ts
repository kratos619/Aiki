// Run 20260718-1714-idea-refinement-c46e (REAL, 2026-07-18): resuming 626e died SOURCE_UNREADABLE
// at S0 — the ORIGINAL run had cleared the blocked-source gate (interactive `y` ≡
// --allow-blocked-sources), but resume rebuilt RunOptions without the URL snapshot or that consent,
// so the workflow REFETCHED (403 again, new timestamps) and re-gated with the default deny. The
// snapshot + consent are run inputs exactly like inputs/idea.md and evidence-pack.json: reusing the
// original snapshot also keeps snapshot-embedding prompts byte-identical so the replay cache can hit.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { run as runEngine } from '../src/orchestration/engine.js';
import { resumeCommand } from '../src/cli/resume.js';

vi.mock('../src/orchestration/engine.js', () => ({
  run: vi.fn(async (_wf: unknown, _input: unknown, _opts: unknown) => ({
    ok: true,
    runId: 'resumed-run',
    dir: '/nowhere',
    callCount: 0,
  })),
}));

// The REAL 626e snapshot (npm page FETCHED, hackathon page BLOCKED with HTTP 403).
const SNAPSHOT_626E = {
  sources: [
    {
      id: 'U1',
      url: 'https://www.npmjs.com/package/aiki-cli',
      final_url: 'https://registry.npmjs.org/aiki-cli/latest',
      status: 'FETCHED',
      title: 'aiki-cli 0.3.2',
      content_type: 'application/json',
      accessed_at: '2026-07-18T10:06:20.964Z',
      sha256: 'e3a95a923a89001b44d5359eb7b096f41fdf6935d60c62a141ba326de8c970ad',
      content: 'Package: aiki-cli\nVersion: 0.3.2\nDescription: Local-first AI model council.',
    },
    {
      id: 'U2',
      url: 'https://namastedev.com/hackathon',
      final_url: 'https://namastedev.com/hackathon',
      status: 'BLOCKED',
      accessed_at: '2026-07-18T10:06:20.972Z',
      error: 'site blocked automated access (HTTP 403)',
    },
  ],
};

let root: string;
let home: string;
const RUN_ID = '20990101-0000-idea-refinement-dead';

async function scaffoldRun(opts: { snapshot?: unknown } = {}): Promise<void> {
  const dir = join(root, 'runs', RUN_ID);
  await mkdir(join(dir, 'inputs'), { recursive: true });
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ workflow: 'idea-refinement', mode: 'council' }));
  await writeFile(join(dir, 'inputs', 'idea.md'), 'should we build the thing?');
  // one completed call so buildReplayCache() is non-empty — proof the old run cleared the S0 gate
  await writeFile(join(dir, 'raw', 'S1-claude-1.prompt.txt'), 'TWO-VIEW PREFLIGHT ...');
  await writeFile(join(dir, 'raw', 'S1-claude-1.out'), '{"ok":true}');
  if (opts.snapshot) await writeFile(join(dir, '00a-url-sources.json'), JSON.stringify(opts.snapshot, null, 2));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-resume-url-'));
  home = await mkdtemp(join(tmpdir(), 'aiki-home-'));
  process.env.AIKI_HOME = home; // keep findSession/config away from the real ~/.aiki
  vi.mocked(runEngine).mockClear();
});

afterEach(async () => {
  delete process.env.AIKI_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function engineOpts(): Record<string, unknown> {
  expect(vi.mocked(runEngine)).toHaveBeenCalledTimes(1);
  return vi.mocked(runEngine).mock.calls[0]![2] as Record<string, unknown>;
}

describe('resume: URL snapshot + blocked-source consent are run inputs', () => {
  it('REPLAY c46e: restores the original snapshot and the cleared-gate consent', async () => {
    await scaffoldRun({ snapshot: SNAPSHOT_626E });
    const code = await resumeCommand(RUN_ID, { root });
    expect(code).toBe(0);
    const opts = engineOpts();
    expect(opts.urlSources).toEqual(SNAPSHOT_626E); // no refetch — byte-identical prompts downstream
    expect(opts.allowBlockedSources).toBe(true); // the old run only got past S0 with consent
  });

  it('all-readable snapshot restores WITHOUT forcing consent', async () => {
    const readable = { sources: [SNAPSHOT_626E.sources[0]] };
    await scaffoldRun({ snapshot: readable });
    expect(await resumeCommand(RUN_ID, { root })).toBe(0);
    const opts = engineOpts();
    expect(opts.urlSources).toEqual(readable);
    expect(opts.allowBlockedSources).toBe(false);
  });

  it('a run without a snapshot artifact resumes unchanged (code-review / pre-v6)', async () => {
    await scaffoldRun();
    expect(await resumeCommand(RUN_ID, { root })).toBe(0);
    const opts = engineOpts();
    expect(opts.urlSources).toBeUndefined();
    expect(opts.allowBlockedSources).toBe(false);
  });
});
