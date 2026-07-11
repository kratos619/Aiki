import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuplicateWriteError, OutOfOrderWriteError, RunWriter } from '../src/storage/runs.js';

const RUN_ID = '20260702-1412-idea-refinement-a3f9';
const contract = {
  task: 'x',
  task_type: 'idea-refinement' as const,
  constraints: [],
  unknowns: [],
  success_criteria: ['a'],
};

let root: string;
let w: RunWriter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-runs-'));
  w = new RunWriter(RUN_ID, root);
  await w.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('RunWriter ordering', () => {
  it('rejects an out-of-order write (§14): earlier stage after a later one', async () => {
    await w.writeJson('disagreement-map', {
      consensus: [],
      contradictions: [],
      unique: [],
      blind_spots: [],
    }); // ord 7
    await expect(w.writeJson('intent-contract', contract)).rejects.toBeInstanceOf(OutOfOrderWriteError); // ord 1
  });

  it('rejects rewriting an already-written artifact (immutable)', async () => {
    await w.writeText('original', 'first');
    await expect(w.writeText('original', 'second')).rejects.toBeInstanceOf(DuplicateWriteError);
  });

  it('allows forward-in-order writes and forward skips', async () => {
    await w.writeText('original', 'raw input'); // ord 0
    await w.writeJson('run-brief', {
      subject: 'x',
      decision_frame: null,
      evaluation_lens: null,
      target_user: null,
      constraints: [],
      claims_to_test: [],
      evidence_supplied: [],
      missing_axes: [],
      domain_dimensions: [
        { id: 'D1', label: 'domain one', rationale: 'matters' },
        { id: 'D2', label: 'domain two', rationale: 'matters' },
        { id: 'D3', label: 'domain three', rationale: 'matters' },
      ],
      questions: [
        { id: 'Q1', axis: 'decision_frame', question: 'decision?', why_it_matters: 'matters', suggested_answers: ['a', 'b'] },
        { id: 'Q2', axis: 'target_user', question: 'user?', why_it_matters: 'matters', suggested_answers: ['a', 'b'] },
        { id: 'Q3', axis: 'success_bar', question: 'bar?', why_it_matters: 'matters', suggested_answers: ['a', 'b'] },
      ],
      answers: [
        { question_id: 'Q1', answer: 'a', source: 'user' },
        { question_id: 'Q2', answer: 'b', source: 'suggested' },
        { question_id: 'Q3', answer: 'c', source: 'default' },
      ],
    }); // ord 0.5
    await w.writeJson('intent-contract', contract); // ord 1
    await w.writeJson('judge-report', {
      adjudications: [],
      verdict: 'v',
      dissent: ['d'],
      confidence_notes: 'n',
    }); // ord 9 (skips 2..8) — legal
  });

  it('allows the action-plan slot between judge-report and final-report', async () => {
    await w.writeJson('judge-report', {
      adjudications: [],
      verdict: 'v',
      dissent: ['d'],
      confidence_notes: 'n',
    });
    await w.writeJson('action-plan', {
      actions: [{
        order: 1,
        action: 'Interview users.',
        why: 'Validates demand.',
        validates: 'Q:demand',
        effort: 'S',
        kill_signal: 'No one has the problem.',
      }],
      sequencing_note: 'Demand first.',
    });
    await w.writeText('final-report', '# done');
  });

  it('allows multiple entries in a dir slot but not a duplicate filename', async () => {
    await w.writePrompt('s4-claude.md', 'p1');
    await w.writePrompt('s4-codex.md', 'p2'); // same ord (3), different file — ok
    await expect(w.writePrompt('s4-claude.md', 'again')).rejects.toBeInstanceOf(DuplicateWriteError);
  });
});

describe('RunWriter schema boundary', () => {
  it('validates before writing — invalid payload throws and writes nothing', async () => {
    await expect(w.writeJson('intent-contract', { task: 'x' })).rejects.toThrow();
    const entries = await readdir(w.dir);
    expect(entries).not.toContain('01-intent-contract.json');
  });
});

describe('RunWriter crash safety (§24 T4)', () => {
  it('a partial/crashed run leaves valid, complete on-disk artifacts', async () => {
    // Simulate a run that writes two stages then "crashes" (no meta finalize, no later stages).
    await w.writeText('original', '# my idea\nbuild aiki');
    await w.writeJson('intent-contract', contract);

    // Everything written so far must be present and parse cleanly — no truncation, no .tmp files.
    const original = await readFile(join(w.dir, '00-original.md'), 'utf8');
    expect(original).toBe('# my idea\nbuild aiki');

    const parsed = JSON.parse(await readFile(join(w.dir, '01-intent-contract.json'), 'utf8'));
    expect(parsed).toEqual(contract);

    const entries = await readdir(w.dir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false); // atomic rename left no temp files
    expect(entries).not.toContain('meta.json'); // crashed before finalize — that's fine
  });
});

describe('RunWriter meta.json', () => {
  const meta = {
    run_id: RUN_ID,
    workflow: 'idea-refinement' as const,
    provider_versions: { claude: '2.1.198' },
    flag_profiles: {},
    roles: { judge: 'claude' as const },
    read_only: { claude: 'plan' as const },
    calls: [],
    call_count: 0,
    budget: { limit: 9, used: 0 },
    exit_status: 'partial' as const,
    aborted: false,
  };

  it('writes and then overwrites meta.json (finalize is updatable)', async () => {
    await w.writeMeta(meta);
    await w.writeMeta({ ...meta, exit_status: 'aborted', aborted: true }); // no ordering constraint
    const parsed = JSON.parse(await readFile(join(w.dir, 'meta.json'), 'utf8'));
    expect(parsed.aborted).toBe(true);
    expect(parsed.exit_status).toBe('aborted');
  });

  it('rejects an invalid meta payload', async () => {
    await expect(w.writeMeta({ ...meta, budget: { limit: 0, used: 0 } })).rejects.toThrow(); // limit must be positive
  });
});
