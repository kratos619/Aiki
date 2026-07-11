import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';

// A scripted adapter that answers each stage by inspecting the prompt. Records call count.
function fakeAdapter(id: ProviderId): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      let obj: unknown;
      if (p.includes('intent preflight analyst')) {
        obj = {
          subject: 'local multi-model orchestration CLI',
          decision_frame: 'decide whether to build the tool as specified',
          evaluation_lens: 'developer-tool viability and risk',
          target_user: 'developers already paying for multiple AI subscriptions',
          constraints: ['no API keys', 'read-only'],
          claims_to_test: ['1.3x bug-catch rate'],
          evidence_supplied: [],
          missing_axes: ['pricing'],
          domain_dimensions: [
            { id: 'D1', label: 'provider interoperability', rationale: 'The idea depends on installed provider CLIs.' },
            { id: 'D2', label: 'workflow adoption', rationale: 'Developers must change review habits.' },
            { id: 'D3', label: 'output comparability', rationale: 'The council compares unlike provider outputs.' },
          ],
          questions: [
            { id: 'Q1', axis: 'decision_frame', question: 'What decision should the council help you make?', why_it_matters: 'The verdict needs a decision frame.', suggested_answers: ['Build/no-build', 'Risk list'] },
            { id: 'Q2', axis: 'target_user', question: 'Who is the first target user?', why_it_matters: 'The audience changes the critique.', suggested_answers: ['Solo developers', 'Teams'] },
            { id: 'Q3', axis: 'success_bar', question: 'What success bar should be used?', why_it_matters: 'The judge needs a bar.', suggested_answers: ['Beat one strong model', 'Find fatal risks'] },
          ],
        };
      } else if (p.includes('intake analyst')) {
        obj = { task: 'build a local multi-model orchestration CLI', task_type: 'idea-refinement', constraints: [], unknowns: ['target user'], success_criteria: ['a verdict'] };
      } else if (p.includes('their request could be misread')) {
        obj = { my_interpretation: 'build a local multi model orchestration cli', plausible_misreadings: ['a cloud chat product'] };
      } else if (p.includes('Fill the role prompt templates')) {
        obj = { prompts: { analyst: 'ROLE: analyst. Task fully specified, no slots remain.' } };
      } else if (p.includes('Task fully specified')) {
        // S4 analyst seat — the filled analyst prompt. Model JSON carries NO `workflow` field.
        obj = {
          task_echo: 'build a local multi-model orchestration CLI',
          strongest_version: 'A local CLI that orchestrates installed AI CLIs for cross-model review.',
          positions: [
            { local_id: 'P1', proposition: 'developers want local multi model orchestration', dimension_id: 'R1', stance: 'SUPPORT', basis: 'EVIDENCE', load_bearing: true, if_false: 'STOP', reasoning: 'The supplied request demonstrates demand.', evidence_ids: ['E1'], depends_on: [] },
            { local_id: 'P2', proposition: 'installed CLIs expose stable machine readable output', dimension_id: 'R4', stance: id === 'agy' ? 'SUPPORT' : 'OPPOSE', basis: 'EVIDENCE', load_bearing: true, if_false: 'CONDITION', reasoning: id === 'agy' ? 'Probe-time formats can be pinned.' : 'CLI output formats drift between versions.', evidence_ids: ['E2'], depends_on: [] },
          ],
          evidence: [
            { id: 'E1', claim_supported: 'developers want local multi model orchestration', source_kind: 'USER', support: 'SUPPORTS', freshness: 'CURRENT' },
            { id: 'E2', claim_supported: 'installed CLIs expose stable machine readable output', source_kind: 'USER', support: id === 'agy' ? 'SUPPORTS' : 'CONTRADICTS', freshness: 'CURRENT' },
          ],
          coverage: [
            { dimension_id: 'R1', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 covers target users.' },
            { dimension_id: 'R4', status: 'COVERED', position_ids: ['P2'], rationale: 'P2 covers feasibility.' },
          ],
          decision_questions: [{ id: 'Q1', question: 'who is the target user?', claim_ids: ['P1'] }],
        };
      } else if (p.includes('TARGETED COVERAGE FILL')) {
        const missing = ['R2', 'R3', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'D1', 'D2', 'D3'];
        obj = {
          task_echo: 'build a local multi-model orchestration CLI',
          strongest_version: 'A focused local orchestration CLI may work.',
          positions: [],
          evidence: [],
          coverage: missing.map((dimension_id) => ({
            dimension_id,
            status: 'NOT_APPLICABLE',
            position_ids: [],
            rationale: `No additional claim is needed for ${dimension_id} in this scripted fixture.`,
          })),
          decision_questions: [],
        };
      } else if (p.includes('Group anonymous positions')) {
        obj = { groups: [['P1', 'P3'], ['P2', 'P4']] };
      } else if (p.includes('ROLE: Independent verifier')) {
        obj = { verifications: [{ target_id: 'G2', verdict: 'REFUTE', evidence: 'the format is pinned at probe time', note: '' }] };
      } else if (p.includes('ROLE: Judge')) {
        obj = {
          adjudications: [{ id: 'G2', ruling: 'REJECT', reasoning: 'the drift risk is mitigated by the flag probe', evidence_cited: 'S1 probe' }],
          verdict: 'Viable as a local orchestration layer; ship behind a provider-probe guard.',
          recommendation: 'PROCEED_WITH_CONDITIONS',
          conditions: ['Proceed only if provider output probing stays stable across versions.'],
          key_points: ['The provider-probe guard addresses the main dispute.'],
          dissent: ['May not beat a single strong model on subjective synthesis.'],
          confidence_notes: 'HIGH on the consensus claims; MEDIUM on the contested one.',
        };
      } else if (p.includes('ROLE: Validation planner')) {
        obj = {
          actions: [{
            order: 1,
            action: 'Interview five target developers about local CLI orchestration pain.',
            why: 'The target user is still an open question.',
            validates: 'Q:who is the target user?',
            effort: 'S',
            kill_signal: 'Fewer than two developers describe the pain unprompted.',
          }],
          sequencing_note: 'Resolve target-user demand before deeper implementation.',
        };
      } else {
        obj = {};
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function handle(id: ProviderId): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return {
    id,
    adapter: fakeAdapter(id),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly },
    readOnly,
    version: '9.9.9',
  };
}

const INPUT = '# my idea\nbuild a local orchestration CLI that binds installed AI CLIs';

let root: string;

function makeCtx(budget?: number): RunCtx {
  const handles = [handle('agy'), handle('codex'), handle('claude')];
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', handles.map((h) => h.id));
  const writer = new RunWriter(runId, root);
  return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, budget });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-engine-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('role assignment (§10, decided T5)', () => {
  it('idea-refinement default: analyst=agy, judge=claude, verifier=codex, judge not an S4 author', () => {
    const roles = resolveRoles('idea-refinement', ['agy', 'codex', 'claude']);
    expect(roles).toMatchObject({ analyst: 'agy', judge: 'claude', verifier: 'codex' });
    expect(roles.s4).not.toContain('claude'); // judge must not author what it adjudicates
  });
});

describe('executeRun happy path (§24 T7: artifacts 00–10, end-to-end)', () => {
  it('produces the S1–S10 artifacts + final report on sample input', async () => {
    const ctx = makeCtx();
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(13); // prior 12 + one targeted coverage-fill call

    const dir = ctx.writer.dir;
    expect(await readFile(join(dir, '00-original.md'), 'utf8')).toBe(INPUT);

    const brief = JSON.parse(await readFile(join(dir, '00b-run-brief.json'), 'utf8'));
    expect(brief.questions).toHaveLength(3);
    expect(brief.answers.every((a: { source: string }) => a.source === 'default')).toBe(true);

    const contract = JSON.parse(await readFile(join(dir, '01-intent-contract.json'), 'utf8'));
    expect(contract.task_type).toBe('idea-refinement');
    expect(contract.domain_dimensions.map((dimension: { id: string }) => dimension.id)).toEqual(['D1', 'D2', 'D3']);

    const guard = JSON.parse(await readFile(join(dir, '02-misunderstanding-guard.json'), 'utf8'));
    expect(guard.interpretations).toHaveLength(3);
    expect(guard.chosen.how).toBe('single-cluster'); // identical restatements → one cluster

    await expect(stat(join(dir, '03-prompts', 'analyst.md'))).resolves.toBeDefined();

    // S4: one role-output file per fan-out seat (agy, codex — judge=claude is not a seat).
    await expect(stat(join(dir, '04-role-outputs', 'agy.json'))).resolves.toBeDefined();
    await expect(stat(join(dir, '04-role-outputs', 'codex.json'))).resolves.toBeDefined();
    const rawNames = await readdir(join(dir, 'raw'));
    const agyS4 = rawNames.find((name) => name.startsWith('S4-agy-agy-') && name.endsWith('.prompt.txt'))!;
    const codexS4 = rawNames.find((name) => name.startsWith('S4-codex-codex-') && name.endsWith('.prompt.txt'))!;
    expect(await readFile(join(dir, 'raw', agyS4), 'utf8')).toContain('LANE: market-adoption');
    expect(await readFile(join(dir, 'raw', codexS4), 'utf8')).toContain('LANE: economics-delivery');
    await expect(stat(join(dir, '06b-coverage-fill.json'))).resolves.toBeDefined();
    const coveragePrompt = rawNames.find((name) => name.startsWith('S7-coverage-fill-agy-') && name.endsWith('.prompt.txt'))!;
    expect(await readFile(join(dir, 'raw', coveragePrompt), 'utf8')).toContain('R13: team / execution capability');

    // S5: both seats on-task (task_echo matches contract), nothing excluded.
    const drift = JSON.parse(await readFile(join(dir, '05-drift-report.json'), 'utf8'));
    expect(drift.entries).toHaveLength(2);
    expect(drift.entries.every((e: { on_task: boolean }) => e.on_task)).toBe(true);
    expect(drift.excluded).toEqual([]);

    const positions = JSON.parse(await readFile(join(dir, '06-positions.json'), 'utf8'));
    expect(positions).toHaveLength(2);

    const graph = JSON.parse(await readFile(join(dir, '07-decision-graph.json'), 'utf8'));
    expect(graph.claims.filter((claim: { state: string }) => claim.state === 'CONSENSUS')).toHaveLength(1);
    expect(graph.claims.filter((claim: { state: string }) => claim.state === 'DISAGREEMENT')).toHaveLength(1);
    expect(graph.holes.coverage).toEqual([]);

    // S8: the one contradiction (D1) was verified.
    const verif = JSON.parse(await readFile(join(dir, '08-verifications.json'), 'utf8'));
    expect(verif.verifications).toHaveLength(1);
    expect(verif.verifications[0]).toMatchObject({ target_id: 'G2', verdict: 'REFUTE' });

    // S9: judge adjudicated the dispute only; non-empty dissent.
    const judge = JSON.parse(await readFile(join(dir, '09-judge-report.json'), 'utf8'));
    expect(judge.adjudications).toHaveLength(1);
    expect(judge.adjudications[0]).toMatchObject({ id: 'G2', ruling: 'REJECT' });
    expect(judge.recommendation).toBe('PROCEED_WITH_CONDITIONS');
    expect(judge.dissent.length).toBeGreaterThan(0);

    const plan = JSON.parse(await readFile(join(dir, '09b-action-plan.json'), 'utf8'));
    expect(plan.actions[0]).toMatchObject({ validates: 'Q:who is the target user?' });

    // S10: final decision brief rendered, with the code-derived audit + display names.
    const report = await readFile(join(dir, 'final-report.md'), 'utf8');
    expect(report).toContain('# Decision Brief');
    expect(report).toContain('## Validation plan');
    expect(report).toContain('## Decision audit');
    expect(report).toContain('Gemini'); // agy shown as its DISPLAY_NAME (user-facing)

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('ok');
    expect(meta.call_count).toBe(13);
    expect(meta.roles).toMatchObject({ analyst: 'agy', judge: 'claude', s4_1: 'agy', s4_2: 'codex' });
  });
});

describe('executeRun budget breach (§24 T5: aborts gracefully)', () => {
  it('fails gracefully with partial, valid artifacts + finalized meta', async () => {
    const ctx = makeCtx(1); // S0 uses the only call; S1 breaches
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('BUDGET');

    const dir = ctx.writer.dir;
    const entries = await readdir(dir);
    expect(entries).toContain('00b-run-brief.json'); // S0 landed before the breach
    expect(entries).not.toContain('01-intent-contract.json'); // S1 never completed
    expect(entries).not.toContain('02-misunderstanding-guard.json'); // S2 never completed
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false); // no half-written files

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('failed');
    expect(meta.call_count).toBe(1); // only S1's call was accounted (breach throws pre-increment)
    expect(meta.budget).toEqual({ limit: 1, used: 1 });
  });
});

describe('Ctrl+C abort (§472/§603: leaves aborted:true meta)', () => {
  function ctxWith(handles: ProviderHandle[], signal: AbortSignal): RunCtx {
    const runId = makeRunId('idea-refinement');
    const roles = resolveRoles('idea-refinement', handles.map((h) => h.id));
    const writer = new RunWriter(runId, root);
    return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, signal });
  }

  it('a pre-aborted signal finalizes the run as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = ctxWith([handle('agy'), handle('codex'), handle('claude')], controller.signal);
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(false);
    const meta = JSON.parse(await readFile(join(ctx.writer.dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('aborted');
    expect(meta.aborted).toBe(true);
    expect(meta.call_count).toBe(0); // guard aborts before the first call
  });

  it('an abort that surfaces as a non-ABORT error (killed in-flight call) still records aborted', async () => {
    const controller = new AbortController();
    // Simulate a child killed by Ctrl+C: the call aborts the signal then returns CRASH.
    const crashOnAbort = (id: ProviderId): Adapter => ({
      id,
      run: async (): Promise<RunResultAdapter> => {
        controller.abort();
        return { ok: false, error: 'CRASH', stderrTail: 'killed', durationMs: 1 };
      },
    });
    const handles = (['agy', 'codex', 'claude'] as ProviderId[]).map((id) => ({ ...handle(id), adapter: crashOnAbort(id) }));
    const ctx = ctxWith(handles, controller.signal);
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(false);
    const meta = JSON.parse(await readFile(join(ctx.writer.dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('aborted'); // ctx.aborted wins over the CRASH classification
    expect(meta.aborted).toBe(true);
  });
});
