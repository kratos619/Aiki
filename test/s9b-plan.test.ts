import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunCtx, makeRunId, type ProviderHandle } from '../src/orchestration/context.js';
import { buildAnswerContext, s9bPlan } from '../src/orchestration/stages/s9b-plan.js';
import { extractJson } from '../src/providers/adapter-core.js';
import { RunWriter } from '../src/storage/runs.js';
import type { Adapter, RunResultAdapter } from '../src/providers/types.js';
import { ActionPlan, type DisagreementMap, type IntentContract, type JudgeReport } from '../src/schemas/index.js';
import type { SeatOutput } from '../src/orchestration/stages/s4-analyze.js';
import { buildDecisionReport, renderReport } from '../src/orchestration/stages/s10-render.js';
import { adaptLegacyDecisionGraph } from '../src/orchestration/legacy-idea-adapter.js';

const contract: IntentContract = {
  task: 'stress-test a local AI orchestration CLI',
  task_type: 'idea-refinement',
  constraints: [],
  unknowns: [],
  success_criteria: ['clear verdict'],
};

const seats: SeatOutput[] = [{
  provider: 'agy',
  output: {
    workflow: 'idea-refinement',
    task_echo: 'stress-test a local AI orchestration CLI',
    strongest_version: 'A local council for high-stakes judgment calls.',
    positions: [],
    evidence: [],
    coverage: [],
    decision_questions: [{ id: 'Q1', question: 'Which target user has this pain?', claim_ids: [] }],
  },
}];

const map: DisagreementMap = {
  consensus: [],
  unique: [{ id: 'C1', statement: 'developers will pay for local orchestration', type: 'JUDGMENT', providers: ['agy'] }],
  contradictions: [{ id: 'D1', claim_ids: ['C1'], attacks: [{ provider: 'codex', argument: 'payment willingness is unproven', severity: 'HIGH' }] }],
  blind_spots: ['business model / monetization'],
};
const graph = adaptLegacyDecisionGraph(map);

const judge: JudgeReport = {
  adjudications: [{ id: 'D1', ruling: 'UPHOLD', reasoning: 'No evidence supports willingness to pay.', evidence_cited: 'D1' }],
  verdict: 'Proceed only after demand validation.',
  recommendation: 'PROCEED_WITH_CONDITIONS',
  conditions: ['Validate willingness to pay.'],
  dissent: ['Developers may pay if the workflow saves enough time.'],
  confidence_notes: 'HIGH on the demand risk.',
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-s9b-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ok(json: unknown): RunResultAdapter {
  return { ok: true, text: JSON.stringify(json), json, durationMs: 1 };
}

function makeCtx(responder: (prompt: string) => RunResultAdapter, budget = 12): RunCtx {
  const adapter: Adapter = {
    id: 'claude',
    run: async (req) => responder(req.prompt),
  };
  const handle: ProviderHandle = {
    id: 'claude',
    adapter,
    flags: { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' },
    readOnly: 'plan',
    version: '9.9.9',
  };
  const writer = new RunWriter(makeRunId('idea-refinement'), root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles: [handle],
    roles: { analyst: 'claude', judge: 'claude', verifier: 'claude', s4: ['claude'] },
    writer,
    cwd: writer.dir,
    budget,
  });
}

const goodPlan = {
  actions: [{
    order: 1,
    action: 'Run a pricing smoke test with 20 developers.',
    why: 'The chair upheld willingness to pay as a load-bearing risk.',
    validates: 'D1',
    effort: 'S',
    kill_signal: 'Fewer than 3 developers join a paid waitlist.',
  }],
  sequencing_note: 'Demand comes first because it can kill the idea cheapest.',
  reader_brief: {
    headline: 'Build the narrow council workflow, after one demand check',
    bottom_line: 'The local architecture is plausible, but demand should be tested before a larger build.',
    sections: [
      { heading: 'Product direction', summary: 'Keep the first release focused on one decision workflow.', bullets: ['Make the visible council result the core experience.'] },
      { heading: 'Delivery', summary: 'Prove the smallest useful path first.', bullets: ['Ship one end-to-end run before adding broader surfaces.'] },
    ],
    next_step: 'Run the pricing smoke test with 20 target developers.',
    caveats: ['Willingness to pay is not established.'],
    source_ids: [],
  },
};

const decisionContract = {
  ...contract,
  alternatives: ['build the narrow council', 'do not build it'],
  success_bar: 'a useful developer workflow',
  evidence_supplied: [],
  missing_evidence: ['demand evidence'],
  core_rubric: ['user value', 'delivery'],
  user_confirmed: true,
  confirmation: 'user-confirmed' as const,
  requested_outputs: ['DECISION'] as const,
};

describe('s9bPlan', () => {
  it('builds one answer context with the original request and only accepted findings', () => {
    const claimGraph = {
      ...graph,
      positions: [
        { id: 'agy/P1', provider: 'agy' as const, source_id: 'agy', local_id: 'P1', proposition: 'The local engine works.', dimension_id: 'R1', stance: 'SUPPORT' as const, basis: 'EVIDENCE' as const, nature: 'FACTUAL' as const, load_bearing: true, if_false: 'STOP' as const, reasoning: 'Observed locally.', evidence_ids: [], depends_on: [] },
        { id: 'agy/P2', provider: 'agy' as const, source_id: 'agy', local_id: 'P2', proposition: 'Demand is proven.', dimension_id: 'R2', stance: 'SUPPORT' as const, basis: 'EVIDENCE' as const, nature: 'FACTUAL' as const, load_bearing: true, if_false: 'STOP' as const, reasoning: 'Claimed by the scout.', evidence_ids: [], depends_on: [] },
        { id: 'agy/P3', provider: 'agy' as const, source_id: 'agy', local_id: 'P3', proposition: 'A council map is the best interface.', dimension_id: 'R2', stance: 'SUPPORT' as const, basis: 'JUDGMENT' as const, nature: 'JUDGMENT' as const, load_bearing: false, if_false: 'CONDITION' as const, reasoning: 'Product judgment.', evidence_ids: [], depends_on: [] },
      ],
      claims: [
        { id: 'G1', proposition: 'The local engine works.', position_ids: ['agy/P1'], state: 'UNIQUE' as const, evidence_state: 'SUPPORTED' as const, nature: 'FACTUAL' as const, load_bearing: true, if_false: 'STOP' as const, sensitivity: 'DECISIVE' as const },
        { id: 'G2', proposition: 'Demand is proven.', position_ids: ['agy/P2'], state: 'UNIQUE' as const, evidence_state: 'SUPPORTED' as const, nature: 'FACTUAL' as const, load_bearing: true, if_false: 'STOP' as const, sensitivity: 'DECISIVE' as const },
        { id: 'G3', proposition: 'A council map is the best interface.', position_ids: ['agy/P3'], state: 'UNIQUE' as const, evidence_state: 'SUPPORTED' as const, nature: 'JUDGMENT' as const, load_bearing: false, if_false: 'CONDITION' as const, sensitivity: 'LOW' as const },
      ],
    };
    const context = buildAnswerContext({
      originalRequest: 'Exact user wording: build the standout local demo.',
      contract: decisionContract,
      seats,
      graph: claimGraph,
      judgeReport: { ...judge, adjudications: [{ id: 'G2', ruling: 'UPHOLD', reasoning: 'Demand evidence fails.', evidence_cited: 'G2' }] },
      flags: ['weak_seat'],
    });

    expect(context.original_request).toBe('Exact user wording: build the standout local demo.');
    expect(context.chair).toMatchObject({
      epistemic_status: 'DECISION_REASONING_NOT_FACT',
      decision_reasoning: judge.verdict,
      recommendation: judge.recommendation,
    });
    expect(context.chair).not.toHaveProperty('verdict');
    expect(context.constraints).toEqual(decisionContract.constraints);
    expect(context.requested_outputs).toEqual(decisionContract.requested_outputs);
    expect(context.supported_findings.map((finding) => finding.id)).toEqual(['G1']);
    expect(context.upheld_risks.map((risk) => risk.id)).toContain('G2');
    expect(context.material_flags).toEqual(['weak_seat']);
  });

  it('maps proposal evidence through the exact seat sample and omits local locators', () => {
    const proposal = {
      output: 'FEATURE_BACKLOG' as const, title: 'Replay', detail: 'Replay saved runs',
      user_value: 'Makes decisions inspectable', why_distinctive: 'Shows the debate', evidence_ids: ['E1'],
    };
    const sampleSeats: SeatOutput[] = [
      { ...seats[0]!, sample: 'agy', output: { ...seats[0]!.output, deliverable_proposals: [proposal] } },
      { ...seats[0]!, sample: 'agy-2', output: { ...seats[0]!.output, deliverable_proposals: [proposal] } },
    ];
    const sampleGraph = {
      ...graph,
      evidence: [
        { id: 'agy/E1', provider: 'agy' as const, source_id: 'agy', claim_supported: 'First sample', source_kind: 'PRIMARY' as const, support: 'SUPPORTS' as const, freshness: 'DATED' as const, locator: 'https://example.com/first', accessed_at: '2026-07-15T10:00:00Z' },
        { id: 'agy-2/E1', provider: 'agy' as const, source_id: 'agy-2', claim_supported: 'Second sample', source_kind: 'USER' as const, support: 'SUPPORTS' as const, freshness: 'DATED' as const, locator: 'C:\\private\\second.txt', accessed_at: '2026-07-16T10:00:00Z' },
      ],
    };

    const context = buildAnswerContext({
      originalRequest: 'Choose features.', contract: decisionContract, seats: sampleSeats,
      graph: sampleGraph, judgeReport: judge, flags: [],
    });

    expect(context.deliverable_proposals.map(({ seat_id, evidence_ids }) => ({ seat_id, evidence_ids }))).toEqual([
      { seat_id: 'agy', evidence_ids: ['agy/E1'] },
      { seat_id: 'agy-2', evidence_ids: ['agy-2/E1'] },
    ]);
    expect(context.as_of_date).toBe('2026-07-15');
    expect(context.sources.map(({ id, accessed_at }) => ({ id, accessed_at }))).toEqual([
      { id: 'agy/E1', accessed_at: '2026-07-15T10:00:00Z' },
      { id: 'agy-2/E1', accessed_at: '2026-07-16T10:00:00Z' },
    ]);
    expect(context.sources[0]?.url).toBe('https://example.com/first');
    expect(JSON.stringify(context)).not.toMatch(/C:\\private/);
  });

  it('allows zero actions only when a reader brief keeps the answer live', () => {
    expect(ActionPlan.safeParse({ ...goodPlan, actions: [] }).success).toBe(true);
    expect(ActionPlan.safeParse({ actions: [], sequencing_note: 'No valid action survived.' }).success).toBe(false);
    expect(ActionPlan.safeParse({
      ...goodPlan,
      reader_brief: { ...goodPlan.reader_brief, bottom_line: 'Evidence coverage is PARTIAL.' },
    }).success).toBe(false);
  });

  it('salvages the captured nurse plan without a repair call', async () => {
    const fixtures = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build', '02-nurse-marketplace', 'regression');
    const raw = await readFile(join(fixtures, '09b-first.out'), 'utf8');
    const json = extractJson(raw);
    expect(json).toBeDefined();
    const nurseMap = JSON.parse(await readFile(join(fixtures, '07-disagreement-map.json'), 'utf8')) as DisagreementMap;
    const nurseGraph = adaptLegacyDecisionGraph(nurseMap);
    const nurseJudge = JSON.parse(await readFile(join(fixtures, '09-judge-report.json'), 'utf8')) as JudgeReport;
    const ctx = makeCtx(() => ({ ok: true, text: raw, json, durationMs: 1 }));

    const plan = await s9bPlan(ctx, { ...contract, task: 'evaluate a nurse shift marketplace' }, [], nurseGraph, nurseJudge);

    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]?.stage).toBe('S9b-plan');
    expect(ctx.flags.has('plan_fallback')).toBe(false);
    expect(plan.actions).toHaveLength(7);
    expect(plan.actions.map((a) => a.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(plan.actions[0]?.action).toContain('per-worked-hour P&L spreadsheet');
    expect(plan.actions[6]?.validates).toBe('blind:kill criteria');
  });

  it('normalizes captured planner timeboxes into S, M, and L effort', async () => {
    const fixtures = join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build', '02-nurse-marketplace', 'regression');
    const raw = await readFile(join(fixtures, '09b-repair.out'), 'utf8');
    const json = extractJson(raw);
    const nurseMap = JSON.parse(await readFile(join(fixtures, '07-disagreement-map.json'), 'utf8')) as DisagreementMap;
    const nurseGraph = adaptLegacyDecisionGraph(nurseMap);
    const nurseJudge = JSON.parse(await readFile(join(fixtures, '09-judge-report.json'), 'utf8')) as JudgeReport;
    const ctx = makeCtx(() => ({ ok: true, text: raw, json, durationMs: 1 }));

    const plan = await s9bPlan(ctx, { ...contract, task: 'evaluate a nurse shift marketplace' }, [], nurseGraph, nurseJudge);

    expect(ctx.calls).toHaveLength(1);
    expect(plan.actions.map((a) => a.effort)).toEqual(['S', 'M', 'M', 'M', 'L', 'S', 'S']);
  });

  it('writes a valid anchored planner result', async () => {
    const ctx = makeCtx(() => ok(goodPlan));
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(plan.actions[0]).toMatchObject({ validates: 'D1' });
    const report = buildDecisionReport(ctx, {
      contract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: judge,
      actionPlan: plan,
    });
    expect(report.dossier.readerBrief).toEqual(goodPlan.reader_brief);
    expect(ctx.calls).toHaveLength(1);
    await expect(readFile(join(ctx.writer.dir, '09b-action-plan.json'), 'utf8')).resolves.toContain('pricing smoke test');
  });

  it('requests and preserves a feature backlog and implementation plan when the user asked for them', async () => {
    const prompts: string[] = [];
    const deliverables = {
      feature_backlog: {
        must: [{ feature: 'Golden-path run', user_value: 'Produces a judge-ready result.', rationale: 'It proves the core workflow.', effort: 'S' }],
        should: [],
        later: [],
        wont: [{ feature: 'General chat', reason: 'It dilutes the decision workflow.' }],
      },
      implementation_plan: {
        milestones: [{ order: 1, timebox: 'Day 1', outcome: 'Golden path works.', tasks: ['Wire the existing engine.'], acceptance_test: 'Complete five clean runs.' }],
      },
    };
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      return ok({
        ...goodPlan,
        ...deliverables,
        reader_brief: {
          ...goodPlan.reader_brief,
          caveats: ['Whether the council beats one strong model is unverified until you test it.'],
        },
      });
    });
    const requestedContract = {
      ...decisionContract,
      requested_outputs: ['DECISION', 'FEATURE_BACKLOG', 'IMPLEMENTATION_PLAN'] as const,
    };

    const plan = await s9bPlan(ctx, requestedContract, seats, graph, { ...judge, key_points: ['The golden path is decisive.'] }, 'Exact original feature request.');

    expect(prompts[0]).toContain('Exact original feature request.');
    expect(prompts[0]).toContain('The golden path is decisive.');
    expect(prompts[0]).toContain('FEATURE_BACKLOG');
    expect(prompts[0]).toContain('IMPLEMENTATION_PLAN');
    expect(prompts[0]).toContain('do not invent a day-count calendar');
    expect(prompts[0]).toContain('do not restate the feature backlog or milestone list');
    expect(prompts[0]).toContain('CONTEXT.chair is decision reasoning, not factual proof');
    expect(plan).toMatchObject({
      ...deliverables,
      implementation_plan: {
        milestones: [{ ...deliverables.implementation_plan.milestones[0], timebox: 'Phase 1' }],
      },
    });
    expect(ctx.calls).toHaveLength(1);
    const rendered = renderReport(ctx, {
      contract: requestedContract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: judge,
      actionPlan: plan,
    });
    expect(rendered.split('## Council audit')[0]).not.toMatch(/\bUNVERIFIED\b/i);
  });

  it('keeps calendar timeboxes when the request supplies a real schedule', async () => {
    const ctx = makeCtx(() => ok({
      ...goodPlan,
      implementation_plan: {
        milestones: [{ order: 1, timebox: 'Day 1', outcome: 'Golden path works.', tasks: ['Wire the existing engine.'], acceptance_test: 'Complete one clean run.' }],
      },
    }));
    const scheduledContract = {
      ...decisionContract,
      constraints: ['Ship within 3 days.'],
      requested_outputs: ['DECISION', 'IMPLEMENTATION_PLAN'] as const,
    };

    const plan = await s9bPlan(ctx, scheduledContract, seats, graph, judge);

    expect('kind' in plan ? undefined : plan.implementation_plan?.milestones[0]?.timebox).toBe('Day 1');
  });

  it('gives the answer editor both seats proposals and preserves its reader brief', async () => {
    const proposalSeats: SeatOutput[] = [
      {
        ...seats[0]!,
        output: {
          ...seats[0]!.output,
          deliverable_proposals: [{
            output: 'FEATURE_BACKLOG',
            title: 'Live disagreement map',
            detail: 'Show where the council branches before the chair decides.',
            user_value: 'Makes the multi-model result understandable at a glance.',
            why_distinctive: 'The debate, not chat, becomes the product.',
            evidence_ids: [],
          }],
        },
      },
      {
        ...seats[0]!,
        provider: 'codex',
        output: {
          ...seats[0]!.output,
          deliverable_proposals: [{
            output: 'IMPLEMENTATION_PLAN',
            title: 'Replay before live control',
            detail: 'Render saved runs before allowing browser-triggered execution.',
            user_value: 'Delivers a reliable demo with less security risk.',
            why_distinctive: 'It exposes the council while keeping the first build narrow.',
            evidence_ids: [],
          }],
        },
      },
    ];
    const prompts: string[] = [];
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      return ok(goodPlan);
    });

    const plan = await s9bPlan(ctx, decisionContract, proposalSeats, graph, judge);

    expect(prompts[0]).toContain('ROLE: User answer editor and action planner');
    expect(prompts[0]).toContain('Live disagreement map');
    expect(prompts[0]).toContain('Replay before live control');
    expect(plan).toMatchObject({ reader_brief: goodPlan.reader_brief });
    expect(ctx.calls).toHaveLength(1);
  });

  it('drops an unknown reader source id without spending a repair call', async () => {
    const prompts: string[] = [];
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      return ok(prompt.includes('Valid source ids:')
        ? goodPlan
        : { ...goodPlan, reader_brief: { ...goodPlan.reader_brief, source_ids: ['made-up/E9'] } });
    });

    const plan = await s9bPlan(ctx, decisionContract, seats, graph, judge);

    expect(ctx.calls).toHaveLength(1);
    expect(plan).toMatchObject({ reader_brief: { source_ids: [] } });
  });

  it('drops unanchored actions and repairs once', async () => {
    const prompts: string[] = [];
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      if (prompt.includes('previous response had invalid anchors')) return ok(goodPlan);
      return ok({ ...goodPlan, actions: [{ ...goodPlan.actions[0], validates: 'D9' }] });
    });
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(plan.actions[0]!.validates).toBe('D1');
    expect(ctx.calls).toHaveLength(2);
    expect(prompts[1]).toContain('Valid graph claim ids: D1');
  });

  it('keeps a required reader answer when every validation action is unanchored', async () => {
    const ctx = makeCtx(() => ok({ ...goodPlan, actions: [{ ...goodPlan.actions[0], validates: 'D9' }] }));

    const plan = await s9bPlan(ctx, decisionContract, seats, graph, judge);

    expect(plan).toMatchObject({ actions: [], reader_brief: goodPlan.reader_brief });
    expect(ctx.calls.map((call) => call.stage)).toEqual(['S9b-plan']);
    expect(ctx.flags.has('plan_fallback')).toBe(false);
    const report = buildDecisionReport(ctx, {
      contract: decisionContract, seats, graph, verifications: { verifications: [] }, judgeReport: judge, actionPlan: plan,
    });
    expect(report.dossier.experiments).toMatchObject({ status: 'DEGRADED', actions: [] });
  });

  it('accepts a model answer with a reader brief and zero actions', async () => {
    const ctx = makeCtx(() => ok({ ...goodPlan, actions: [] }));

    const plan = await s9bPlan(ctx, decisionContract, seats, graph, judge);

    expect(plan).toMatchObject({ actions: [], reader_brief: goodPlan.reader_brief });
    expect(ctx.calls.map((call) => call.stage)).toEqual(['S9b-plan']);
  });

  it('rejects only graph ids that exist in this run', async () => {
    const knownId = graph.claims[0]!.id;
    const prompts: string[] = [];
    const ctx = makeCtx((prompt) => {
      prompts.push(prompt);
      return ok(prompt.includes('previous response had invalid anchors')
        ? goodPlan
        : { ...goodPlan, reader_brief: { ...goodPlan.reader_brief, bottom_line: `Internal claim ${knownId} decides this.` } });
    });

    await s9bPlan(ctx, decisionContract, seats, graph, judge);
    expect(ctx.calls).toHaveLength(2);

    const ordinary = makeCtx(() => ok({
      ...goodPlan,
      reader_brief: { ...goodPlan.reader_brief, bottom_line: 'Target the G20 developer community first.' },
    }));
    await s9bPlan(ordinary, decisionContract, seats, graph, judge);
    expect(ordinary.calls).toHaveLength(1);
  });

  it('uses the one reserved planner call without requiring repair headroom', async () => {
    const ctx = makeCtx(() => ok(goodPlan), 1);
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.flags.has('plan_skipped')).toBe(false);
    expect(plan).toEqual(goodPlan);
  });

  it('records explicit unavailability when the planner call crashes', async () => {
    const ctx = makeCtx(() => ({ ok: false, error: 'CRASH', stderrTail: 'boom', durationMs: 1 }));
    const plan = await s9bPlan(ctx, contract, seats, graph, judge);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.flags.has('plan_fallback')).toBe(true);
    expect(plan).toEqual({
      kind: 'PlannerUnavailable',
      reason: 'planner_failed',
      unresolved_questions: ['Which target user has this pain?'],
    });
  });

  it('renders planner unavailability and its flag inside the validation section', () => {
    const ctx = makeCtx(() => ok(goodPlan));
    ctx.addFlag('plan_fallback');
    const report = renderReport(ctx, {
      contract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: judge,
      actionPlan: {
        kind: 'PlannerUnavailable',
        reason: 'planner_failed',
        unresolved_questions: ['Which target user has this pain?'],
      },
    });
    const section = report.slice(report.indexOf('## 2. Deliverables and action plan'), report.indexOf('## 3.'));

    expect(section).toContain('plan_fallback');
    expect(section).toContain('Planner unavailable: planner_failed');
    expect(section).toContain('Which target user has this pain?');
  });

  it('renders a concise honest fallback for a new contract when the answer editor is unavailable', () => {
    const ctx = makeCtx(() => ok(goodPlan));
    ctx.addFlag('plan_fallback');
    const fallbackJudge = {
      ...judge,
      verdict: 'Build the focused visual council demo as a thin loopback presentation layer over the existing orchestration because the local-first architecture fits the constraints, but only after the decisive risks are closed.',
      key_points: ['Demand evidence is the decisive gap.'],
    };
    const requestedContract = {
      ...decisionContract,
      requested_outputs: ['DECISION', 'FEATURE_BACKLOG'] as const,
    };
    const report = buildDecisionReport(ctx, {
      contract: requestedContract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: fallbackJudge,
      actionPlan: {
        kind: 'PlannerUnavailable', reason: 'planner_failed', unresolved_questions: ['Which target user has this pain?'],
      },
    });
    const reader = renderReport(ctx, {
      contract: requestedContract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: fallbackJudge,
      actionPlan: {
        kind: 'PlannerUnavailable', reason: 'planner_failed', unresolved_questions: ['Which target user has this pain?'],
      },
    }).split('## Council audit')[0]!;

    expect(report.dossier.readerBrief).toBeDefined();
    expect(report.dossier.readerBrief?.headline).toMatch(/…$/);
    expect(report.dossier.readerBrief?.headline.length).toBeLessThanOrEqual(160);
    expect(reader).toContain('Demand evidence is the decisive gap.');
    expect(reader).toContain('FEATURE_BACKLOG');
    expect(reader).toContain('deterministic fallback');
    expect(reader).not.toContain('## Feature priorities');
    expect(reader).not.toMatch(/\bG\d+\b|\b(?:UNVERIFIED|PARTIAL|CONFLICTED)\b/);
    expect(ctx.calls).toHaveLength(0);
  });

  it('renders synthesis_suspect beside the chairman reasoning', () => {
    const ctx = makeCtx(() => ok(goodPlan));
    ctx.addFlag('synthesis_suspect');
    const report = renderReport(ctx, {
      contract,
      seats,
      graph,
      verifications: { verifications: [] },
      judgeReport: { ...judge, key_points: ['Demand is the decisive uncertainty.'] },
      actionPlan: goodPlan,
    });
    const section = report.slice(report.indexOf('## 1. Decision'), report.indexOf('## 2.'));

    expect(section).toContain('synthesis_suspect');
  });
});
