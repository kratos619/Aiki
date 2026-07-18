import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCtx, makeRunId, resolveRoles, type ProviderHandle } from '../src/orchestration/context.js';
import { executeRun } from '../src/orchestration/engine.js';
import { runIdeaRefinement } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import type { EvidencePack } from '../src/orchestration/evidence-pack.js';

// A scripted adapter that answers each stage by inspecting the prompt. Records call count.
function fakeAdapter(id: ProviderId, opts: { obvious?: boolean } = {}): Adapter {
  return {
    id,
    run: async (req): Promise<RunResultAdapter> => {
      const p = req.prompt;
      let obj: unknown;
      if (p.includes('TWO-VIEW PREFLIGHT')) {
        obj = {
          subject: 'local multi-model orchestration CLI',
          interpretation: 'decide whether to build a local multi model orchestration cli',
          normalized_decision: 'decide whether to build a local multi model orchestration cli',
          alternatives: ['build it', 'do not build it'],
          target_user: 'developers already paying for multiple AI subscriptions',
          constraints: ['no API keys', 'read-only'],
          success_bar: 'a defensible build or stop recommendation',
          success_criteria: ['a verdict'],
          claims_to_test: ['1.3x bug-catch rate'],
          evidence_supplied: [],
          missing_evidence: ['pricing evidence'],
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
      } else if (p.includes('ROLE: Independent analyst')) {
        // S4 analyst seat — the deterministically filled analyst prompt. Model JSON carries NO `workflow` field.
        obj = {
          task_echo: 'build a local multi-model orchestration CLI',
          strongest_version: 'A local CLI that orchestrates installed AI CLIs for cross-model review.',
          positions: [
            { local_id: 'P1', proposition: 'developers want local multi model orchestration', dimension_id: 'R1', stance: 'SUPPORT', basis: 'EVIDENCE', load_bearing: true, if_false: 'STOP', reasoning: 'The supplied request demonstrates demand.', evidence_ids: ['E1'], depends_on: [] },
            { local_id: 'P2', proposition: 'installed CLIs expose stable machine readable output', dimension_id: 'R4', stance: opts.obvious || id === 'agy' ? 'SUPPORT' : 'OPPOSE', basis: 'EVIDENCE', load_bearing: true, if_false: 'CONDITION', reasoning: opts.obvious || id === 'agy' ? 'Probe-time formats can be pinned.' : 'CLI output formats drift between versions.', evidence_ids: ['E2'], depends_on: [] },
          ],
          evidence: [
            { id: 'E1', claim_supported: 'developers want local multi model orchestration', source_kind: 'USER', support: 'SUPPORTS', freshness: 'CURRENT' },
            { id: 'E2', claim_supported: 'installed CLIs expose stable machine readable output', source_kind: 'USER', support: opts.obvious || id === 'agy' ? 'SUPPORTS' : 'CONTRADICTS', freshness: 'CURRENT' },
          ],
          coverage: [
            { dimension_id: 'R1', status: 'COVERED', position_ids: ['P1'], rationale: 'P1 covers target users.' },
            { dimension_id: 'R4', status: 'COVERED', position_ids: ['P2'], rationale: 'P2 covers feasibility.' },
            ...(opts.obvious
              ? ['R2', 'R3', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'D1', 'D2', 'D3'].map((dimension_id) => ({
                  dimension_id,
                  status: 'NOT_APPLICABLE' as const,
                  position_ids: [],
                  rationale: `${dimension_id} does not add a decision-critical claim in this obvious fixture.`,
                }))
              : []),
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
      } else if (p.includes('ROLE: Independent verifier')) {
        obj = { verifications: [{ claim_id: 'G2', status: 'CONTRADICTED', reasoning: 'the format is pinned at probe time', evidence_ids: ['E2'], calculation_check: 'NOT_APPLICABLE', missing_evidence: [] }] };
      } else if (p.includes('ROLE: Scout rebuttal')) {
        obj = { events: [{ claim_id: 'G2', response: id === 'agy' ? 'CONCEDE' : 'COUNTER', reasoning: 'The probe-time evidence narrows the format-drift concern.', evidence_ids: ['E1'] }] };
      } else if (p.includes('ROLE: Judge')) {
        obj = opts.obvious ? {
          adjudications: [],
          verdict: 'Proceed with the compatibility probe already specified.',
          recommendation: 'PROCEED',
          recommendation_claim_ids: ['G1', 'G2'],
          strongest_counter_case: { claim_ids: ['G2'], reasoning: 'Provider formats may still drift.' },
          key_points: ['The two independent seats support the load-bearing claims.'],
          dissent: ['Provider formats may still drift faster than probes adapt.'],
          confidence_notes: 'Medium because supplied evidence is user evidence.',
        } : {
          adjudications: [{ claim_id: 'G2', ruling: 'HOLDS', reasoning: 'the drift risk is mitigated by the flag probe', evidence_ids: ['E1'], effect_on_decision: 'The idea can proceed behind a compatibility guard.' }],
          verdict: 'Viable as a local orchestration layer; ship behind a provider-probe guard.',
          recommendation: 'PROCEED_WITH_CONDITIONS',
          conditions: ['Proceed only if provider output probing stays stable across versions.'],
          recommendation_claim_ids: ['G1', 'G2'],
          condition_claim_ids: ['G2'],
          strongest_counter_case: { claim_ids: ['G2'], reasoning: 'Provider formats may drift faster than probes can adapt.' },
          key_points: ['The provider-probe guard addresses the main dispute.'],
          dissent: ['May not beat a single strong model on subjective synthesis.'],
          confidence_notes: 'HIGH on the consensus claims; MEDIUM on the contested one.',
        };
      } else if (p.includes('ROLE: User answer editor and action planner')) {
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
          reader_brief: {
            headline: 'Validate developer demand before expanding the local council',
            bottom_line: 'The narrow orchestration path is feasible, but target-user demand should decide whether it grows.',
            sections: [
              { heading: 'Product direction', summary: 'Keep the first workflow focused on one decision.', bullets: ['Use the provider probe as the compatibility guard.'] },
              { heading: 'Validation', summary: 'Test whether developers feel this pain before deeper implementation.', bullets: ['Interview five target developers.'] },
            ],
            next_step: 'Interview five target developers about local orchestration pain.',
            caveats: ['Provider formats can still drift.'],
            source_ids: [],
          },
        };
      } else {
        obj = {};
      }
      return { ok: true, text: JSON.stringify(obj), json: obj, durationMs: 1 };
    },
  };
}

function handle(id: ProviderId, opts: { obvious?: boolean } = {}): ProviderHandle {
  const readOnly = id === 'claude' ? 'plan' : 'sandbox';
  return {
    id,
    adapter: fakeAdapter(id, opts),
    flags: { id, jsonOutput: id === 'claude', readOnlyFlag: readOnly },
    readOnly,
    version: '9.9.9',
  };
}

const INPUT = '# my idea\nbuild a local orchestration CLI that binds installed AI CLIs';

let root: string;

function makeCtx(budget?: number, evidencePack?: EvidencePack, opts: { obvious?: boolean } = {}): RunCtx {
  const handles = [handle('agy', opts), handle('codex', opts), handle('claude', opts)];
  const runId = makeRunId('idea-refinement');
  const roles = resolveRoles('idea-refinement', handles.map((h) => h.id));
  const writer = new RunWriter(runId, root);
  return new RunCtx({ runId, workflow: 'idea-refinement', handles, roles, writer, cwd: writer.dir, budget, evidencePack });
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
  it('keeps a nominal obvious council run to the six-call base', async () => {
    const ctx = makeCtx(undefined, undefined, { obvious: true });
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(6);
    expect(ctx.calls.map((call) => call.stage)).toEqual(expect.arrayContaining(['P0-1', 'P0-2', 'S4-agy', 'S4-codex', 'S9', 'S9b-plan']));
    expect(ctx.calls.some((call) => call.stage === 'S7-coverage-fill' || call.stage === 'S8' || call.stage.startsWith('S8b-'))).toBe(false);
  });

  it('produces the S1–S10 artifacts + final report on sample input', async () => {
    const ctx = makeCtx(undefined, {
      root: '/tmp/research',
      files: [{ path: '/tmp/research/study.md', sha256: 'a'.repeat(64) }],
    });
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(true);
    expect(outcome.callCount).toBe(10); // 6-call base + four graph-triggered investigation/verification calls

    const dir = ctx.writer.dir;
    expect(await readFile(join(dir, '00-original.md'), 'utf8')).toBe(INPUT);
    expect(JSON.parse(await readFile(join(dir, 'inputs', 'evidence-pack.json'), 'utf8'))).toMatchObject({ root: '/tmp/research' });

    const brief = JSON.parse(await readFile(join(dir, '00b-run-brief.json'), 'utf8'));
    expect(brief.questions).toHaveLength(3);
    expect(brief.answers.every((a: { source: string }) => a.source === 'default')).toBe(true);

    const contract = JSON.parse(await readFile(join(dir, '01-intent-contract.json'), 'utf8'));
    expect(contract.task_type).toBe('idea-refinement');
    expect(contract.domain_dimensions.map((dimension: { id: string }) => dimension.id)).toEqual(['D1', 'D2', 'D3']);

    const preflight = JSON.parse(await readFile(join(dir, '02-preflight-readings.json'), 'utf8'));
    expect(preflight.readings).toHaveLength(2);
    expect(preflight.chosen.how).toBe('single-cluster');

    await expect(stat(join(dir, '03-prompts', 'analyst.md'))).resolves.toBeDefined();

    // S4: one role-output file per fan-out seat (agy, codex — judge=claude is not a seat).
    await expect(stat(join(dir, '04-role-outputs', 'agy.json'))).resolves.toBeDefined();
    await expect(stat(join(dir, '04-role-outputs', 'codex.json'))).resolves.toBeDefined();
    const rawNames = await readdir(join(dir, 'raw'));
    const agyS4 = rawNames.find((name) => name.startsWith('S4-agy-agy-') && name.endsWith('.prompt.txt'))!;
    const codexS4 = rawNames.find((name) => name.startsWith('S4-codex-codex-') && name.endsWith('.prompt.txt'))!;
    expect(await readFile(join(dir, 'raw', agyS4), 'utf8')).toContain('LANE: market-adoption');
    expect(await readFile(join(dir, 'raw', agyS4), 'utf8')).toContain('EVIDENCE PACK MANIFEST');
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

    // S8: the one disagreement was verified with graph evidence references.
    const verif = JSON.parse(await readFile(join(dir, '08-verifications.json'), 'utf8'));
    expect(verif.verifications).toHaveLength(1);
    expect(verif.verifications[0]).toMatchObject({ claim_id: 'G2', status: 'CONTRADICTED', evidence_ids: ['agy/E2'] });

    const rebuttals = JSON.parse(await readFile(join(dir, '08b-rebuttals.json'), 'utf8'));
    expect(rebuttals.events).toHaveLength(2);
    expect(rebuttals.events.map((event: { response: string }) => event.response)).toEqual(['CONCEDE', 'COUNTER']);
    expect(rebuttals.stop_reason).toBe('ROUND_COMPLETE');

    // S9: judge adjudicated the dispute only; non-empty dissent.
    const judge = JSON.parse(await readFile(join(dir, '09-judge-report.json'), 'utf8'));
    expect(judge.adjudications).toHaveLength(1);
    expect(judge.adjudications[0]).toMatchObject({ id: 'G2', ruling: 'REJECT' });
    expect(judge.recommendation).toBe('PROCEED_WITH_CONDITIONS');
    expect(judge.dissent.length).toBeGreaterThan(0);

    const plan = JSON.parse(await readFile(join(dir, '09b-action-plan.json'), 'utf8'));
    expect(plan.actions[0]).toMatchObject({ validates: 'Q:who is the target user?' });

    // S10: graph-backed reader-first dossier rendered + machine-readable JSON.
    const report = await readFile(join(dir, 'final-report.md'), 'utf8');
    expect(report).toContain('# Validate developer demand before expanding the local council');
    expect(report).toContain('## Council audit');
    expect(report).toContain('## 1. Decision');
    expect(report).toContain('## 2. Deliverables and action plan');
    expect(report).toContain('## 5. Risks and open questions');
    expect(report).toContain('## 7. What the council added');
    expect(report).toContain('Gemini'); // agy shown as its DISPLAY_NAME (user-facing)
    const decisionReport = JSON.parse(await readFile(join(dir, '10-decision-report.json'), 'utf8'));
    expect(decisionReport).toMatchObject({ verdict: { status: 'ACCEPTED_WITH_CONDITIONS' } });
    expect(decisionReport.dossier.readerBrief.headline).toContain('Validate developer demand');
    expect(decisionReport.claims.length).toBeGreaterThan(0);
    expect(decisionReport.dossier.claimChain.length).toBeGreaterThan(0);

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('ok');
    expect(meta.call_count).toBe(10);
    expect(meta.mode).toBe('council');
    expect(meta.receipt).toEqual({ discovery: 5, verification: 4, repair: 0, planning: 1 });
    expect(meta.roles).toMatchObject({ analyst: 'agy', judge: 'claude', s4_1: 'agy', s4_2: 'codex' });
  });
});

describe('executeRun budget breach (§24 T5: aborts gracefully)', () => {
  it('fails gracefully with partial, valid artifacts + finalized meta', async () => {
    const ctx = makeCtx(1); // the second parallel preflight reading breaches
    const outcome = await executeRun(ctx, INPUT, runIdeaRefinement);

    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toBe(false);
    expect(outcome.error?.code).toBe('BUDGET');

    const dir = ctx.writer.dir;
    const entries = await readdir(dir);
    expect(entries).not.toContain('00b-run-brief.json'); // the two-view boundary never completed
    expect(entries).not.toContain('01-intent-contract.json');
    expect(entries).not.toContain('02-preflight-readings.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false); // no half-written files

    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('failed');
    expect(meta.call_count).toBe(1); // one preflight call completed; the second breached pre-spawn
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
    expect(outcome.aborted).toBe(true);
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
    expect(outcome.aborted).toBe(true);
    const meta = JSON.parse(await readFile(join(ctx.writer.dir, 'meta.json'), 'utf8'));
    expect(meta.exit_status).toBe('aborted'); // ctx.aborted wins over the CRASH classification
    expect(meta.aborted).toBe(true);
  });
});
