// T8: the TUI's pure logic — timeline reducer + provider resolution + completion/error formatters.
// (Rendering + real keystrokes are the manual acceptance run; these cover everything else.)

import { describe, it, expect } from 'vitest';
import {
  elapsedLabel,
  initTimeline,
  markEnd,
  markStart,
  stageProviders,
  type StageRow,
} from '../src/tui/timeline.js';
import { formatCompletion, formatError } from '../src/tui/format.js';
import { parseCommand, quickActionReducer, routeInput } from '../src/tui/smart-entry.js';
import { IDEA_STAGES } from '../src/workflows/idea-refinement.js';
import type { RoleMap } from '../src/orchestration/context.js';
import type { DisagreementMap, JudgeReport } from '../src/schemas/index.js';

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

  it('builds the 10-row skeleton all pending, providers resolved (S7 = judge, S5 = —)', () => {
    const rows = initTimeline(IDEA_STAGES, roles, [...available]);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.find((r) => r.id === 'S1')!.providers).toEqual(['agy']);
    expect(rows.find((r) => r.id === 'S7')!.providers).toEqual(['claude']); // makes the grouping call
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
    unique: [],
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
    const v = formatCompletion('.aiki/runs/x', judge, map);
    expect(v.verdict).toBe('Viable behind a probe guard.');
    expect(v.disagreements[0]).toBe('D1 → UPHOLD: weak inventory');
    expect(v.disagreements[1]).toBe('D2 → UNRESOLVED: pricing risk'); // no adjudication → UNRESOLVED default
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
