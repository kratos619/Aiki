import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { matchRunId } from '../src/storage/runs-read.js';
import { loadConfig, effectiveConfig, ConfigError } from '../src/config/config.js';
import { isFresh, toEntry, entryToSmoke, readSmokeCache, writeSmokeCache, SMOKE_TTL_MS, type SmokeCacheEntry } from '../src/config/smoke-cache.js';
import { buildFeedbackEntries, parseVerdictFlags, appendFeedback, FeedbackEntry, FeedbackError, type AdjItem } from '../src/storage/feedback.js';
import { show } from '../src/cli/show.js';
import { resolve } from '../src/cli/resolve.js';
import { config } from '../src/cli/config.js';
import { DEFAULT_BUDGET, DEFAULT_DEADLINE_MS } from '../src/orchestration/context.js';

// ── (b) run-id resolver — pure ────────────────────────────────────────────────

describe('matchRunId', () => {
  const ids = ['20260704-1300-idea-refinement-aaaa', '20260704-1400-idea-refinement-bbbb', '20260704-1200-idea-refinement-cccc'];

  it('no runs → none', () => {
    expect(matchRunId([], undefined)).toEqual({ ok: false, kind: 'none' });
  });
  it('no arg → the lexically-latest (most recent) run', () => {
    expect(matchRunId(ids, undefined)).toEqual({ ok: true, runId: '20260704-1400-idea-refinement-bbbb' });
  });
  it('exact id match', () => {
    expect(matchRunId(ids, ids[0])).toEqual({ ok: true, runId: ids[0] });
  });
  it('unique suffix match', () => {
    expect(matchRunId(ids, 'bbbb')).toEqual({ ok: true, runId: '20260704-1400-idea-refinement-bbbb' });
  });
  it('ambiguous substring → candidates', () => {
    const r = matchRunId(ids, 'idea-refinement');
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'ambiguous') expect(r.candidates).toHaveLength(3);
    else throw new Error('expected ambiguous');
  });
  it('no match', () => {
    expect(matchRunId(ids, 'zzzz')).toEqual({ ok: false, kind: 'no-match', arg: 'zzzz' });
  });
});

// ── (a) config loader + precedence + hard-fail ────────────────────────────────

describe('loadConfig / effectiveConfig', () => {
  let root: string;
  let aiki: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-cfg-'));
    aiki = join(root, '.aiki');
    await mkdir(aiki, { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('missing file → defaults (empty config, no throw)', async () => {
    expect(await loadConfig(aiki)).toEqual({});
    expect(effectiveConfig({})).toEqual({ budget: DEFAULT_BUDGET, deadlineMs: DEFAULT_DEADLINE_MS, roles: {}, models: {} });
  });

  it('valid config parses roles + budget; effective merges over defaults', async () => {
    await writeFile(join(aiki, 'config.json'), JSON.stringify({ roles: { judge: 'agy' }, budget: 5 }));
    const cfg = await loadConfig(aiki);
    expect(cfg).toEqual({ roles: { judge: 'agy' }, budget: 5 });
    expect(effectiveConfig(cfg)).toEqual({ budget: 5, deadlineMs: DEFAULT_DEADLINE_MS, roles: { judge: 'agy' }, models: {} });
  });

  it('invalid JSON → ConfigError naming the file', async () => {
    await writeFile(join(aiki, 'config.json'), '{ not json ');
    await expect(loadConfig(aiki)).rejects.toBeInstanceOf(ConfigError);
  });

  it('unknown provider in roles → ConfigError (schema hard-fail)', async () => {
    await writeFile(join(aiki, 'config.json'), JSON.stringify({ roles: { judge: 'gpt4' } }));
    await expect(loadConfig(aiki)).rejects.toThrow(/config\.roles\.judge/);
  });

  it('non-numeric budget → ConfigError', async () => {
    await writeFile(join(aiki, 'config.json'), JSON.stringify({ budget: 'lots' }));
    await expect(loadConfig(aiki)).rejects.toThrow(/config\.budget/);
  });

  it('unknown top-level key → ConfigError (strict)', async () => {
    await writeFile(join(aiki, 'config.json'), JSON.stringify({ judge: 'agy' })); // should be roles.judge
    await expect(loadConfig(aiki)).rejects.toBeInstanceOf(ConfigError);
  });
});

// ── (e) smoke cache — staleness pure + roundtrip ──────────────────────────────

describe('smoke-cache', () => {
  const entry = (over: Partial<SmokeCacheEntry> = {}): SmokeCacheEntry => ({ ok: true, durationMs: 1200, version: '1.0.0', at: new Date().toISOString(), ...over });

  it('fresh: within TTL + same version', () => {
    expect(isFresh(entry(), '1.0.0', Date.now())).toBe(true);
  });
  it('stale: older than TTL', () => {
    const old = entry({ at: new Date(Date.now() - SMOKE_TTL_MS - 1000).toISOString() });
    expect(isFresh(old, '1.0.0', Date.now())).toBe(false);
  });
  it('stale: version changed (upgrade)', () => {
    expect(isFresh(entry({ version: '1.0.0' }), '1.0.1', Date.now())).toBe(false);
  });
  it('stale: unparseable timestamp', () => {
    expect(isFresh(entry({ at: 'not-a-date' }), '1.0.0', Date.now())).toBe(false);
  });
  it('toEntry ↔ entryToSmoke roundtrip preserves ok/error/duration', () => {
    const e = toEntry({ ok: false, error: 'AUTH', nonce: 'x', durationMs: 900 }, '2.0.0');
    expect(e).toMatchObject({ ok: false, error: 'AUTH', durationMs: 900, version: '2.0.0' });
    expect(entryToSmoke(e)).toMatchObject({ ok: false, error: 'AUTH', durationMs: 900 });
  });

  it('read missing → {}; write then read roundtrips', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiki-smoke-'));
    try {
      expect(await readSmokeCache(root)).toEqual({});
      const cache = { claude: entry() };
      await writeSmokeCache(cache, root);
      expect(await readSmokeCache(root)).toEqual(cache);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── (d) feedback — pure core + append ─────────────────────────────────────────

describe('feedback core', () => {
  const items: AdjItem[] = [
    { id: 'D1', ruling: 'UPHOLD' },
    { id: 'D2', ruling: 'REJECT' },
  ];

  it('parseVerdictFlags: full words + c/i/u aliases', () => {
    const m = parseVerdictFlags(['D1=correct', 'D2=i', 'D3=u']);
    expect(m.get('D1')).toEqual({ verdict: 'correct' });
    expect(m.get('D2')).toEqual({ verdict: 'incorrect' });
    expect(m.get('D3')).toEqual({ verdict: 'unsure' });
  });
  it('parseVerdictFlags: malformed flag / bad verdict throw', () => {
    expect(() => parseVerdictFlags(['D1'])).toThrow(FeedbackError);
    expect(() => parseVerdictFlags(['D1=maybe'])).toThrow(FeedbackError);
  });

  it('buildFeedbackEntries: item order, snapshots ruling, skips un-voted, includes note', () => {
    const verdicts = new Map([['D2', { verdict: 'incorrect' as const, note: 'weak' }]]);
    const entries = buildFeedbackEntries('run-x', 'idea-refinement', items, verdicts, new Date('2026-07-04T00:00:00Z'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      run_id: 'run-x',
      workflow: 'idea-refinement',
      item_type: 'adjudication',
      item_id: 'D2',
      verdict: 'incorrect',
      ruling: 'REJECT', // snapshot from the item, not the verdict
      at: '2026-07-04T00:00:00.000Z',
      note: 'weak',
    });
    expect(() => FeedbackEntry.parse(entries[0])).not.toThrow();
  });

  it('buildFeedbackEntries: unknown item id → FeedbackError', () => {
    expect(() => buildFeedbackEntries('run-x', 'idea-refinement', items, new Map([['D9', { verdict: 'correct' as const }]]))).toThrow(FeedbackError);
  });

  it('appendFeedback: append-only, one valid JSONL line per entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiki-fb-'));
    try {
      const e1 = buildFeedbackEntries('r1', 'idea-refinement', items, new Map([['D1', { verdict: 'correct' as const }]]));
      await appendFeedback(e1, root);
      const e2 = buildFeedbackEntries('r1', 'idea-refinement', items, new Map([['D2', { verdict: 'unsure' as const }]]));
      await appendFeedback(e2, root);
      const lines = (await readFile(join(root, 'feedback.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(() => FeedbackEntry.parse(JSON.parse(l))).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── (c)(d) show + resolve + config — end-to-end via cwd ───────────────────────

const META = JSON.stringify({ workflow: 'idea-refinement', exit_status: 'ok', aborted: false, call_count: 3, budget: { limit: 12, used: 3 } });
const JUDGE = JSON.stringify({
  adjudications: [{ id: 'D1', ruling: 'UPHOLD', reasoning: 'attack stands', evidence_cited: 'e' }],
  verdict: 'v',
  dissent: ['x'],
  confidence_notes: 'n',
});
const MAP = JSON.stringify({
  consensus: [],
  contradictions: [{ id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'agy', argument: 'this claim is unproven', severity: 'HIGH' }] }],
  unique: [],
  blind_spots: [],
});

async function mkRun(aiki: string, id: string, files: Record<string, string>): Promise<void> {
  const dir = join(aiki, 'runs', id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((err += String(c)), true));
  try {
    return { code: await fn(), out, err };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

describe('show / resolve / config (cwd-based)', () => {
  let root: string;
  let aiki: string;
  let cwd: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-cmd-'));
    aiki = join(root, '.aiki');
    await mkdir(aiki, { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    prevHome = process.env.AIKI_HOME; // isolate the global (~/.aiki) layer for `aiki config`
    process.env.AIKI_HOME = join(root, '.home-aiki');
  });
  afterEach(async () => {
    process.chdir(cwd);
    if (prevHome === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = prevHome;
    await rm(root, { recursive: true, force: true });
  });

  it('show: complete run cats final-report.md', async () => {
    await mkRun(aiki, 'r1', { 'final-report.md': '# Decision Brief\nbody', 'meta.json': META });
    const { code, out } = await capture(() => show('r1'));
    expect(code).toBe(0);
    expect(out).toContain('# Decision Brief');
  });

  it('show: partial run (no report) → summary from meta', async () => {
    await mkRun(aiki, 'r2', { 'meta.json': JSON.stringify({ workflow: 'idea-refinement', exit_status: 'aborted', aborted: true, call_count: 4, budget: { limit: 12, used: 4 } }), '01-intent-contract.json': '{}' });
    const { code, out } = await capture(() => show('r2'));
    expect(code).toBe(0);
    expect(out).toContain('incomplete');
    expect(out).toContain('aborted:true');
    expect(out).toContain('--raw');
  });

  it('show --raw: lists artifact files', async () => {
    await mkRun(aiki, 'r3', { 'final-report.md': 'x', 'meta.json': META, 'raw/s4-agy.out': 'log' });
    const { code, out } = await capture(() => show('r3', { raw: true }));
    expect(code).toBe(0);
    expect(out).toContain('final-report.md');
    expect(out).toContain(join('raw', 's4-agy.out'));
  });

  it('show --html: writes a council-view HTML artifact with providers, disputes, verdict', async () => {
    const finding = { id: 'F1', file: 'src/pay.ts', line_start: 10, line_end: 10, severity: 'P1', category: 'SECURITY', claim: 'missing auth', evidence: 'no guard', suggested_fix: 'add guard', self_confidence: 0.9 };
    await mkRun(aiki, 'cr-html', {
      'meta.json': JSON.stringify({ workflow: 'code-review', exit_status: 'ok', aborted: false, call_count: 5, budget: { limit: 12, used: 5 } }),
      '04-role-outputs/claude.json': JSON.stringify({ workflow: 'code-review', task_echo: 'review', findings: [finding] }),
      '04-role-outputs/codex.json': JSON.stringify({ workflow: 'code-review', task_echo: 'review', findings: [] }),
      '07-review-map.json': JSON.stringify({ consensus: [], disputed: [{ finding, reviewers: ['claude'], cross_verdict: 'REFUTE', refutation: 'codex disputes it' }], single_reviewer: [], per_reviewer: [] }),
      '09-judge-report.json': JSON.stringify({ adjudications: [{ id: 'F1', ruling: 'UPHOLD', reasoning: 'auth is required', evidence_cited: 'src/pay.ts' }], verdict: 'Fix the auth gap before shipping.', dissent: ['Scope is small.'], confidence_notes: 'High confidence.' }),
      'final-report.md': '# Report',
    });
    const { code, out } = await capture(() => show('cr-html', { html: true }));
    expect(code).toBe(0);
    const html = await readFile(out.trim(), 'utf8');
    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).toContain('1 disputed');
    expect(html).toContain('Fix the auth gap before shipping.');
  });

  it('show --html (idea): promotes blind spots, resolves disputed assumptions, keeps raw ids out of the main body', async () => {
    await mkRun(aiki, 'idea-html', {
      'meta.json': JSON.stringify({ workflow: 'idea-refinement', exit_status: 'ok', aborted: false, call_count: 8, budget: { limit: 12, used: 8 }, roles: { judge: 'claude', s4_1: 'codex', s4_2: 'agy' } }),
      '01-intent-contract.json': JSON.stringify({ task: 'Can I run a top LLM fully offline on a phone?' }),
      '04-role-outputs/codex.json': JSON.stringify({ workflow: 'idea-refinement', task_echo: 't', strongest_version: 'Scoped, it works.', assumptions: [], attacks: [], open_questions: [] }),
      '04-role-outputs/agy.json': JSON.stringify({ workflow: 'idea-refinement', task_echo: 't', strongest_version: 'Only on high-end devices.', assumptions: [], attacks: [], open_questions: [] }),
      '07-disagreement-map.json': JSON.stringify({
        consensus: [{ id: 'C1', statement: 'Quantization can shrink models to fit phones.', type: 'VERIFIABLE', providers: ['codex', 'agy'] }],
        contradictions: [
          { id: 'D1', claim_ids: ['C2'], attacks: [{ provider: 'agy', argument: 'Users expect GPT-4 quality and will reject a smaller local model.', severity: 'HIGH' }] },
          { id: 'D2', claim_ids: ['C3'], attacks: [{ provider: 'codex', argument: 'This only defeats the absolute-best reading, not a scoped one.', severity: 'MED' }] },
        ],
        unique: [
          { id: 'C2', statement: 'Users will accept lower quality than cloud models.', type: 'JUDGMENT', providers: ['agy'] },
          { id: 'C3', statement: '"Best" can mean best-that-fits-the-device.', type: 'JUDGMENT', providers: ['codex'] },
        ],
        blind_spots: ['business model / monetization', 'existing alternatives / competition'],
      }),
      '09-judge-report.json': JSON.stringify({
        adjudications: [
          { id: 'D1', ruling: 'UPHOLD', reasoning: 'Acceptance is an unvalidated behavioral assumption.', evidence_cited: 'x' },
          { id: 'D2', ruling: 'REJECT', reasoning: 'Attacks a reading the claim never asserts.', evidence_cited: 'y' },
        ],
        verdict: 'Feasible only as a scoped, niche product.',
        recommendation: 'PROCEED_WITH_CONDITIONS',
        conditions: ['Validate that users accept lower quality for offline privacy.'],
        key_points: ['The frontier-quality promise does not survive on-device constraints.', 'agy and codex split on what "best" means; the chair sided with the scoped reading.'],
        dissent: ['Might be too pessimistic for high-end devices.'],
        confidence_notes: 'D1 HIGH; D2 HIGH.',
      }),
      '09b-action-plan.json': JSON.stringify({
        actions: [{
          order: 1,
          action: 'Run a device-quality acceptance test with 10 target users.',
          why: 'The chair upheld user acceptance as the main behavioral risk.',
          validates: 'D1',
          effort: 'S',
          kill_signal: 'Most users reject the offline output as too low quality.',
        }],
        sequencing_note: 'Test acceptance before pricing or build depth.',
      }),
      'final-report.md': '# Report',
    });
    const { code, out } = await capture(() => show('idea-html', { html: true }));
    expect(code).toBe(0);
    const html = await readFile(out.trim(), 'utf8');
    expect(html).toContain('Feasible only as a scoped, niche product.'); // verdict
    expect(html).toContain('business model / monetization'); // blind spot is RENDERED, not just counted
    expect(html).toContain('Users will accept lower quality than cloud models.'); // D1 upheld → risk shows the resolved assumption, not "D1"
    expect(html).toContain('risks that stand'); // honest glance stat
    expect(html).toContain('Chair: Claude'); // judge attributed (chairman of the panel)
    expect(html).toContain("Chairman's reasoning"); // the deeper bulleted verdict reasoning
    expect(html).toContain('the chair sided with the scoped reading.'); // a key_point renders
    expect(html).toContain('Proceed with conditions'); // explicit BLUF badge
    expect(html).toContain('Dimension scorecard'); // v3 scorecard surfaced
    expect(html).toContain('Assumption audit'); // derived audit table surfaced
    expect(html).toContain('The debate'); // deterministic who-vs-who narrative
    expect(html).toContain('Validation plan'); // planner artifact surfaced
    expect(html).toContain('Run a device-quality acceptance test'); // anchored action
    expect(html).toContain('Receipt'); // call/provider receipt surfaced
    expect(html).toContain('How each model saw it'); // per-model section surfaced, not folded
    expect(html).toContain('Copy report (Markdown)'); // copy-to-clipboard control
    expect(html).toContain('const REPORT_MD ='); // the embedded markdown for the copy button
    // The upheld dispute is a REJECT/UPHOLD-free story above the fold; raw ids are absent from the debate
    // narrative, though the validation plan later shows anchors such as D1.
    const mainBody = html.slice(0, html.indexOf('<details'));
    expect(mainBody).not.toContain('UPHOLD');
    const beforePlan = html.slice(0, html.indexOf('Validation plan'));
    expect(beforePlan).not.toContain('>D1<');
  });

  it('show --html (idea): old runs without recommendation or plan keep the legacy body', async () => {
    await mkRun(aiki, 'idea-old-html', {
      'meta.json': JSON.stringify({ workflow: 'idea-refinement', exit_status: 'ok', aborted: false, call_count: 8, budget: { limit: 12, used: 8 }, roles: { judge: 'claude' } }),
      '04-role-outputs/agy.json': JSON.stringify({ workflow: 'idea-refinement', task_echo: 't', strongest_version: 'Scoped, it works.', assumptions: [], attacks: [], open_questions: [] }),
      '07-disagreement-map.json': JSON.stringify({ consensus: [], contradictions: [], unique: [], blind_spots: ['pricing'] }),
      '09-judge-report.json': JSON.stringify({ adjudications: [], verdict: 'Old verdict.', dissent: ['x'], confidence_notes: 'n' }),
      'final-report.md': '# Report',
    });
    const { code, out } = await capture(() => show('idea-old-html', { html: true }));
    expect(code).toBe(0);
    const html = await readFile(out.trim(), 'utf8');
    expect(html).toContain('Recommended next steps');
    expect(html).not.toContain('Validation plan');
    expect(html).not.toContain('Dimension scorecard');
  });

  it('show: no matching run → exit 1', async () => {
    const { code, err } = await capture(() => show('nope'));
    expect(code).toBe(1);
    expect(err).toMatch(/no runs found|no run matches/);
  });

  it('show: no arg → latest run', async () => {
    await mkRun(aiki, '20260704-1200-idea-refinement-old0', { 'final-report.md': 'OLD', 'meta.json': META });
    await mkRun(aiki, '20260704-1400-idea-refinement-new0', { 'final-report.md': 'NEW', 'meta.json': META });
    const { out } = await capture(() => show(undefined));
    expect(out).toContain('NEW');
    expect(out).not.toContain('OLD');
  });

  it('resolve --verdict: appends a valid JSONL line (§604)', async () => {
    await mkRun(aiki, 'r4', { '09-judge-report.json': JUDGE, '07-disagreement-map.json': MAP, 'meta.json': META });
    const { code } = await capture(() => resolve('r4', { verdict: ['D1=correct'] }));
    expect(code).toBe(0);
    const lines = (await readFile(join(aiki, 'feedback.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = FeedbackEntry.parse(JSON.parse(lines[0]!));
    expect(entry).toMatchObject({ run_id: 'r4', item_id: 'D1', verdict: 'correct', ruling: 'UPHOLD' });
  });

  it('resolve: append-only across two runs of the command', async () => {
    await mkRun(aiki, 'r5', { '09-judge-report.json': JUDGE, '07-disagreement-map.json': MAP, 'meta.json': META });
    await capture(() => resolve('r5', { verdict: ['D1=correct'] }));
    await capture(() => resolve('r5', { verdict: ['D1=incorrect'] }));
    const lines = (await readFile(join(aiki, 'feedback.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('resolve --verdict: unknown item id → exit 1', async () => {
    await mkRun(aiki, 'r6', { '09-judge-report.json': JUDGE, '07-disagreement-map.json': MAP, 'meta.json': META });
    const { code, err } = await capture(() => resolve('r6', { verdict: ['D9=correct'] }));
    expect(code).toBe(1);
    expect(err).toMatch(/no adjudication "D9"/);
  });

  it('resolve: run with no adjudications → exit 0, nothing written', async () => {
    await mkRun(aiki, 'r7', { '09-judge-report.json': JSON.stringify({ adjudications: [], verdict: 'v', dissent: ['x'], confidence_notes: 'n' }), 'meta.json': META });
    const { code, out } = await capture(() => resolve('r7', { verdict: ['D1=correct'] }));
    expect(code).toBe(0);
    expect(out).toMatch(/no adjudicated disputes/);
  });

  it('config: prints effective config with defaults filled', async () => {
    const { code, out } = await capture(() => config());
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ budget: DEFAULT_BUDGET, deadlineMs: DEFAULT_DEADLINE_MS, roles: {}, models: {} });
  });

  it('config: invalid config → exit 1', async () => {
    await writeFile(join(aiki, 'config.json'), JSON.stringify({ budget: 'lots' }));
    const { code, err } = await capture(() => config());
    expect(code).toBe(1);
    expect(err).toMatch(/config\.budget/);
  });

  it('config --edit: creates {} scaffold when missing (no $EDITOR)', async () => {
    const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL };
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    try {
      const { code } = await capture(() => config({ edit: true }));
      expect(code).toBe(0);
      expect(await readFile(join(aiki, 'config.json'), 'utf8')).toBe('{}\n');
    } finally {
      if (saved.EDITOR !== undefined) process.env.EDITOR = saved.EDITOR;
      if (saved.VISUAL !== undefined) process.env.VISUAL = saved.VISUAL;
    }
  });
});
