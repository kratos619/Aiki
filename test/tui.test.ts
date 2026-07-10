// T8: the TUI's pure logic — timeline reducer + provider resolution + completion/error formatters.
// (Rendering + real keystrokes are the manual acceptance run; these cover everything else.)

import { describe, it, expect } from 'vitest';
import {
  elapsedLabel,
  initTimeline,
  markEnd,
  markStart,
  progressBar,
  runningPhrase,
  stageProviders,
  totalElapsed,
  type StageRow,
} from '../src/tui/timeline.js';
import { formatCompletion, formatError } from '../src/tui/format.js';
import { filterCommands, parseCommand, quickActionReducer, routeInput, scopeRedirect, suggestCommand } from '../src/tui/smart-entry.js';
import { IDEA_STAGES } from '../src/workflows/idea-refinement.js';
import type { RoleMap } from '../src/orchestration/context.js';
import type { DisagreementMap, JudgeReport } from '../src/schemas/index.js';
import { adaptLegacyDecisionGraph } from '../src/orchestration/legacy-idea-adapter.js';

const roles: RoleMap = { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] };
const available = ['agy', 'codex', 'claude'] as const;

describe('timeline: provider resolution + skeleton', () => {
  it('resolves each role hint to the right chips', () => {
    expect(stageProviders('analyst', roles, [...available])).toEqual(['agy']);
    expect(stageProviders('judge', roles, [...available])).toEqual(['claude']);
    expect(stageProviders('verifier', roles, [...available])).toEqual(['codex']);
    expect(stageProviders('s4', roles, [...available])).toEqual(['agy', 'codex']);
    expect(stageProviders('all', roles, [...available])).toEqual(['agy', 'codex', 'claude']);
    expect(stageProviders(null, roles, [...available])).toEqual([]);
  });

  it('builds the 12-row skeleton all pending, providers resolved (S0/S1 = analyst, S7/S9b = judge, S5 = —)', () => {
    const rows = initTimeline(IDEA_STAGES, roles, [...available]);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.find((r) => r.id === 'S0')!.providers).toEqual(['agy']);
    expect(rows.find((r) => r.id === 'S1')!.providers).toEqual(['agy']);
    expect(rows.find((r) => r.id === 'S7')!.providers).toEqual(['claude']); // makes the grouping call
    expect(rows.find((r) => r.id === 'S9b')!.providers).toEqual(['claude']);
    expect(rows.find((r) => r.id === 'S5')!.providers).toEqual([]);
  });
});

describe('timeline: state transitions + elapsed', () => {
  it('marks running then done with timing', () => {
    let rows = initTimeline(IDEA_STAGES, roles, [...available]);
    rows = markStart(rows, 'S1', 1000);
    expect(rows.find((r) => r.id === 'S1')).toMatchObject({ status: 'running', startedAt: 1000 });
    rows = markEnd(rows, 'S1', 'done', 3500);
    expect(rows.find((r) => r.id === 'S1')).toMatchObject({ status: 'done', endedAt: 3500 });
  });

  it('elapsedLabel: final duration when done, live seconds when running, blank when pending', () => {
    const done: StageRow = { id: 'S1', label: 'x', providers: [], status: 'done', startedAt: 1000, endedAt: 3500 };
    const running: StageRow = { id: 'S2', label: 'x', providers: [], status: 'running', startedAt: 1000 };
    const pending: StageRow = { id: 'S3', label: 'x', providers: [], status: 'pending' };
    expect(elapsedLabel(done, 9999)).toBe('2.5s');
    expect(elapsedLabel(running, 4000)).toBe('3s');
    expect(elapsedLabel(pending, 9999)).toBe('');
  });
});

describe('completion + error formatters', () => {
  const map: DisagreementMap = {
    consensus: [],
    unique: [
      { id: 'C1', statement: 'inventory is sufficient', type: 'JUDGMENT', providers: ['agy'] },
      { id: 'C2', statement: 'pricing is viable', type: 'JUDGMENT', providers: ['codex'] },
    ],
    contradictions: [
      { id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'agy', argument: 'weak inventory', severity: 'HIGH' }] },
      { id: 'D2', claim_ids: ['C2'], attacks: [{ provider: 'codex', argument: 'pricing risk', severity: 'MED' }] },
    ],
    blind_spots: [],
  };
  const judge: JudgeReport = {
    adjudications: [{ id: 'D1', ruling: 'UPHOLD', reasoning: 'r', evidence_cited: 'e' }],
    verdict: 'Viable behind a probe guard.',
    dissent: ['fixable'],
    confidence_notes: 'HIGH',
  };

  it('formatCompletion: verdict + top-N disagreements with rulings + paths', () => {
    const v = formatCompletion('.aiki/runs/x', judge, adaptLegacyDecisionGraph(map));
    expect(v.verdict).toBe('Viable behind a probe guard.');
    expect(v.disagreements[0]).toBe('D1 → UPHOLD: inventory is sufficient');
    expect(v.disagreements[1]).toBe('D2 → UNRESOLVED: pricing is viable'); // no adjudication → UNRESOLVED default
    expect(v.reportPath).toBe('.aiki/runs/x/final-report.md');
  });

  it('formatError: known code → actionable fix; unknown → fallback; partial dir carried', () => {
    expect(formatError('AUTH').fix).toMatch(/login/);
    expect(formatError('ZZZ').fix).toMatch(/logs/);
    expect(formatError('QUORUM', '.aiki/runs/x').partialDir).toBe('.aiki/runs/x');
  });
});

describe('smart entry router (V2)', () => {
  it('routes short general questions away from council work', () => {
    expect(routeInput('What is the capital of France?')).toBe('question');
    expect(routeInput('how do I reverse a list?')).toBe('question');
  });

  it('routes code-ish text toward code review', () => {
    expect(routeInput('diff --git a/src/a.ts b/src/a.ts')).toBe('code-review');
    expect(routeInput('src/payments/charge.ts has an auth check')).toBe('code-review');
    expect(routeInput('const x = user.id;')).toBe('code-review');
  });

  it('keeps product ideas on the idea flow', () => {
    expect(routeInput('Build a local tool that compares model critiques for code review')).toBe('idea');
  });

  it('maps quick actions and blocks repo actions outside git', () => {
    expect(quickActionReducer('r', true).action).toBe('review-working-tree');
    expect(quickActionReducer('b', true).action).toBe('review-branch');
    expect(quickActionReducer('i', false).action).toBe('idea');
    expect(quickActionReducer('r', false)).toMatchObject({ action: null, message: 'not inside a git repo' });
  });
});

describe('slash-command parser (V9)', () => {
  it('non-slash input → null (falls through to routeInput)', () => {
    expect(parseCommand('build a local cli')).toBeNull();
    expect(parseCommand('  what is X?')).toBeNull();
  });

  it('parses command + rest + args', () => {
    expect(parseCommand('/idea a fridge-to-recipe app')).toEqual({ cmd: 'idea', rest: 'a fridge-to-recipe app', args: ['a', 'fridge-to-recipe', 'app'] });
    expect(parseCommand('/review --branch')).toEqual({ cmd: 'review', rest: '--branch', args: ['--branch'] });
    expect(parseCommand('/sessions')).toEqual({ cmd: 'sessions', rest: '', args: [] });
  });

  it('lowercases the command, trims, and handles a bare slash', () => {
    expect(parseCommand('  /RESUME 20260706-abcd  ')).toEqual({ cmd: 'resume', rest: '20260706-abcd', args: ['20260706-abcd'] });
    expect(parseCommand('/')).toEqual({ cmd: '', rest: '', args: [] });
  });
});

describe('run-screen life: phrases + progress + total time (V10)', () => {
  it('runningPhrase rotates every 4s and is stage-flavored', () => {
    expect(runningPhrase('S9', 0)).toBe('the judge is deliberating');
    expect(runningPhrase('S9', 4)).toBe('weighing evidence over confidence');
    expect(runningPhrase('S9', 8)).toBe('the judge is deliberating'); // wraps
    expect(runningPhrase('S9', 3)).toBe(runningPhrase('S9', 0)); // stable within a window
  });

  it('runningPhrase falls back for an unknown stage', () => {
    expect(runningPhrase('S99', 0)).toBe('working');
  });

  it('runningPhrase covers the action planner stage', () => {
    expect(runningPhrase('S9b', 0)).toBe('planning decisive validation');
  });

  it('runningPhrase covers the intent preflight stage', () => {
    expect(runningPhrase('S0', 0)).toBe('grilling the intent');
  });

  it('progressBar counts done/failed/skipped as finished', () => {
    const rows: StageRow[] = [
      { id: 'S1', label: '', providers: [], status: 'done' },
      { id: 'S2', label: '', providers: [], status: 'failed' },
      { id: 'S3', label: '', providers: [], status: 'skipped' },
      { id: 'S4', label: '', providers: [], status: 'running' },
      { id: 'S5', label: '', providers: [], status: 'pending' },
    ];
    expect(progressBar(rows)).toEqual({ bar: '▰▰▰▱▱', done: 3, total: 5 });
  });

  it('totalElapsed spans first start to last end; empty before anything ran', () => {
    const rows: StageRow[] = [
      { id: 'S1', label: '', providers: [], status: 'done', startedAt: 1000, endedAt: 5000 },
      { id: 'S2', label: '', providers: [], status: 'done', startedAt: 5000, endedAt: 85_000 },
    ];
    expect(totalElapsed(rows)).toBe('84s');
    expect(totalElapsed([{ id: 'S1', label: '', providers: [], status: 'pending' }])).toBe('');
  });
});

describe('scope redirect (V10.2) — codebase-explore / feature-brainstorm asks', () => {
  it('redirects "explore my codebase" style asks (not a real idea, must not paid-run)', () => {
    for (const p of [
      'go through the code and tell me what are the key areas to improve',
      'review my codebase and find improvements',
      'analyze this project and suggest what to build next',
      'what more features can we add?',
      'what more feature we can add',
    ]) {
      expect(scopeRedirect(p), p).not.toBeNull();
    }
  });

  it('leaves genuine stated ideas alone (they should reach the idea flow)', () => {
    for (const p of [
      'build a plugin marketplace to boost retention',
      'Users keep asking for more features, so we should add a plugin marketplace',
      'a fridge-to-recipe app for students',
      'open-source our core product to beat a better-funded competitor',
    ]) {
      expect(scopeRedirect(p), p).toBeNull();
    }
  });
});

describe('command palette filter (V10)', () => {
  it('bare "/" lists every command', () => {
    expect(filterCommands('/').map((c) => c.name)).toEqual(['idea', 'review', 'resume', 'sessions', 'models', 'config', 'help']);
  });

  it('prefix filter: "/mo" → models', () => {
    expect(filterCommands('/mo').map((c) => c.name)).toEqual(['models']);
  });

  it('prefix matches rank before substring matches ("/re" → review, resume before any substring hit)', () => {
    const names = filterCommands('/re').map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['review', 'resume']);
  });

  it('substring matches work ("/ess" → sessions)', () => {
    expect(filterCommands('/ess').map((c) => c.name)).toEqual(['sessions']);
  });

  it('palette is off for non-slash input and once a space is typed', () => {
    expect(filterCommands('an idea about fridges')).toEqual([]);
    expect(filterCommands('/review --branch')).toEqual([]);
  });

  it('no match → empty (not everything)', () => {
    expect(filterCommands('/xyzzy')).toEqual([]);
  });
});

describe('suggestCommand (near-miss recovery, V10)', () => {
  it('/model → models (the incident that motivated this)', () => {
    expect(suggestCommand('model')).toBe('models');
  });

  it('one-letter typos recover: confg → config, reviw → review', () => {
    expect(suggestCommand('confg')).toBe('config');
    expect(suggestCommand('reviw')).toBe('review');
  });

  it('gibberish → null (no false "did you mean")', () => {
    expect(suggestCommand('xyzzy')).toBeNull();
  });
});
