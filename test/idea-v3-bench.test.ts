import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertIdeaV3Set,
  IDEA_V3_CALLS_PER_CASE,
  loadIdeaV3Cases,
  loadFrozenIdeaV3Protocol,
  planIdeaV3Bench,
  runIdeaV3Bench,
  type IdeaV3BenchCase,
  type IdeaV3Campaign,
  type IdeaV3Observation,
} from '../src/bench/idea-v3-bench.js';
import {
  blindIdeaV3Report,
  evaluateIdeaV3AdaptiveGates,
  evaluateIdeaV3Gates,
  exportIdeaV3BlindBundle,
  ideaV3TokenEfficiency,
  importIdeaV3Ratings,
  writeIdeaV3AdaptiveResults,
  writeFrozenIdeaV3Protocol,
  writeIdeaV3Results,
  type IdeaV3ScoredCampaign,
} from '../src/bench/idea-v3-rating.js';
import type { ProviderHandle } from '../src/orchestration/context.js';
import type { ProviderId } from '../src/providers/types.js';

function handle(id: ProviderId): ProviderHandle {
  return {
    id,
    adapter: { id, run: async () => ({ ok: false, error: 'CRASH', stderrTail: 'must not run', durationMs: 0 }) },
    flags: { id, jsonOutput: true, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
    readOnly: id === 'claude' ? 'plan' : 'sandbox',
    version: 'test',
  };
}

const handles = [handle('claude'), handle('codex'), handle('agy')];

function observation(caseId: string, arm: IdeaV3Observation['arm'], status: 'ok' | 'error' = 'ok'): IdeaV3Observation {
  return {
    case_id: caseId,
    arm,
    status,
    run_id: `${caseId}-${arm}`,
    ...(status === 'ok' ? { report_markdown: `# ${caseId} ${arm}` } : { error: 'scripted failure' }),
    calls: IDEA_V3_CALLS_PER_CASE[arm],
    calls_by_provider: { claude: 0, codex: 0, agy: 0 },
    repair_calls: 0,
    latency_ms: 1,
    flags: [],
  };
}

let temp: string | undefined;
afterEach(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
  temp = undefined;
});

async function fixtureRoot(): Promise<string> {
  temp = await mkdtemp(join(tmpdir(), 'aiki-idea-v3-'));
  await cp(
    join(process.cwd(), 'bench', 'sets', 'idea-refinement', 'build'),
    join(temp, 'bench', 'sets', 'idea-refinement', 'build'),
    { recursive: true },
  );
  return temp;
}

describe('R8 idea-v3 protocol benchmark', () => {
  it('loads the frozen eight-case build set and plans B/C/D2/R without provider calls', async () => {
    const cases = await loadIdeaV3Cases('build');
    assertIdeaV3Set(cases, 'build');
    expect(cases.map((item) => item.id)).toEqual([
      'water-reminder',
      'nurse-marketplace',
      'postgres-multitenancy',
      'library-sunday-hours',
      'school-ai-tutor',
      'restaurant-surplus-marketplace',
      'heat-pump-financing',
      'support-four-day-week',
    ]);

    const plan = await planIdeaV3Bench();
    expect(plan.toRun).toHaveLength(32);
    expect(plan.estimatedProviderCalls).toBe(8 * (1 + 4 + 8 + 10));
  });

  it('plans Phase F A/B2 explicitly without changing the frozen default arms', async () => {
    const plan = await planIdeaV3Bench({ arms: ['A', 'B2'] });
    expect(plan.arms).toEqual(['A', 'B2']);
    expect(plan.toRun).toHaveLength(16);
    expect(plan.estimatedProviderCalls).toBe(8 * (4 + 2));
    expect(IDEA_V3_CALLS_PER_CASE).toMatchObject({ A: 4, B2: 2 });
  });

  it('runs B2 as the B primary call plus one focused same-provider verification', async () => {
    const root = await fixtureRoot();
    const prompts: string[] = [];
    const report = (verified: boolean) => ({
      recommendation: 'INCONCLUSIVE',
      summary: verified ? 'Verified summary.' : 'Primary summary.',
      rationale: 'Evidence remains incomplete.',
      load_bearing_claims: [{
        id: 'C1', proposition: 'Demand is unverified.', stance: 'UNRESOLVED', fact_kind: 'INFERENCE',
        evidence_status: 'NOT_REQUIRED', reasoning: 'No demand evidence was supplied.',
      }],
      risks: ['Demand may be weak.'],
      actions: [{
        action: 'Run a demand test.', method: 'Landing page', sample_or_source: '100 visitors',
        metric: 'signup rate', threshold: '10%', kill_or_pivot_signal: 'below 5%', timebox: 'one week',
        claim_ids: ['C1'],
      }],
    });
    const scripted: ProviderHandle = {
      ...handle('claude'),
      adapter: {
        id: 'claude',
        run: async (request) => {
          prompts.push(request.prompt);
          const value = report(request.prompt.includes('FOCUSED SELF-VERIFICATION'));
          return {
            ok: true as const,
            text: JSON.stringify(value),
            json: value,
            durationMs: 1,
            usage: { inputTokens: 100, outputTokens: 20, estimated: false },
          };
        },
      },
    };

    const result = await runIdeaV3Bench({ root, arms: ['B2'], handles: [scripted] });

    expect(prompts).toHaveLength(16);
    expect(prompts.filter((prompt) => prompt.includes('FOCUSED SELF-VERIFICATION'))).toHaveLength(8);
    expect(result.campaign.observations[0]).toMatchObject({
      arm: 'B2', calls: 2,
      usage: { inputTokens: 200, outputTokens: 40, reportedCalls: 2, estimatedCalls: 0 },
    });
    expect(result.campaign.observations[0]!.report_markdown).toContain('Verified summary.');
  });

  it('keeps baseline-provider build candidates in separate campaigns', async () => {
    const root = await fixtureRoot();
    const claude = await planIdeaV3Bench({ root, arms: ['B'], baselineProvider: 'claude' });
    const codex = await planIdeaV3Bench({ root, arms: ['B'], baselineProvider: 'codex' });
    expect(claude.resultsPath).toMatch(/idea-v3-build-claude-/);
    expect(codex.resultsPath).toMatch(/idea-v3-build-codex-/);
    expect(claude.resultsPath).not.toBe(codex.resultsPath);
  });

  it('refuses D2 on holdout because the frozen arm is build diagnostic only', async () => {
    await expect(planIdeaV3Bench({ set: 'holdout', arms: ['D2'] })).rejects.toThrow(/build-set diagnostic only/);
  });

  it('keeps Phase F A/B2 build-only so the frozen holdout protocol cannot drift', async () => {
    await expect(planIdeaV3Bench({ set: 'holdout', arms: ['A', 'B2'] }))
      .rejects.toThrow(/Phase F arms are build-set validation only/);
  });

  it('keeps holdout sealed until the protocol, roles, models, and hashes are frozen', async () => {
    const root = await fixtureRoot();
    await expect(planIdeaV3Bench({ root, set: 'holdout', arms: ['B', 'C', 'R'] }))
      .rejects.toThrow(/protocol is not frozen/);
  });

  it('enforces all frozen holdout tag minimums', () => {
    const manifest = (id: string, tags: string[]): IdeaV3BenchCase => ({
      id,
      dir: `/tmp/${id}`,
      input: id,
      manifest: {
        id,
        title: id,
        set: 'holdout',
        provenance: 'SEALED_HOLDOUT',
        tags,
        input_file: 'input.md',
        critical_claims: [{ id: `${id}-C1`, proposition: 'p', acceptable_stances: ['UNRESOLVED'], evidence_required: false }],
        common_false_claims: [],
        required_dimensions: Array.from({ length: 12 }, (_, index) => `d${index}`),
        source_pack: [],
        acceptable_unresolved_outcomes: [],
      },
    });
    const fullTags = ['obvious', 'contestable', 'ambiguous', 'evidence-rich', 'evidence-poor', 'current-fact', 'regulated', 'technical', 'marketplace', 'non-commercial'];
    const cases = Array.from({ length: 12 }, (_, index) => manifest(`h${index}`, index < 2 ? fullTags : ['misc']));
    expect(() => assertIdeaV3Set(cases, 'holdout')).not.toThrow();
    cases[1]!.manifest.tags = ['misc'];
    expect(() => assertIdeaV3Set(cases, 'holdout')).toThrow(/obvious requires at least 2/);
  });

  it('checkpoints every scripted pair and resumes without re-running successes or failures', async () => {
    const root = await fixtureRoot();
    const seen: string[] = [];
    const first = await runIdeaV3Bench({
      root,
      arms: ['B', 'R'],
      handles,
      execute: async ({ arm, case: item }) => {
        seen.push(`${item.id}:${arm}`);
        return observation(item.id, arm, item.id === 'water-reminder' && arm === 'B' ? 'error' : 'ok');
      },
    });
    expect(seen).toHaveLength(16);
    expect(first.campaign.observations).toHaveLength(16);
    expect(JSON.parse(await readFile(first.path, 'utf8')).observations).toHaveLength(16);

    const resumedSeen: string[] = [];
    const resumed = await runIdeaV3Bench({
      root,
      arms: ['B', 'R'],
      handles,
      resume: true,
      execute: async ({ arm, case: item }) => {
        resumedSeen.push(`${item.id}:${arm}`);
        return observation(item.id, arm);
      },
    });
    expect(resumedSeen).toEqual([]);
    expect(resumed.campaign.observations).toHaveLength(16);
  });

  it('refuses to clobber a same-day campaign without --resume, protecting recorded paid observations', async () => {
    const root = await fixtureRoot();
    const reran: string[] = [];
    await runIdeaV3Bench({ root, arms: ['B'], handles, execute: async ({ arm, case: item }) => observation(item.id, arm) });

    // Second same-day invocation WITHOUT --resume would overwrite the paid file — must fail loud.
    await expect(runIdeaV3Bench({
      root,
      arms: ['B'],
      handles,
      execute: async ({ arm, case: item }) => { reran.push(`${item.id}:${arm}`); return observation(item.id, arm); },
    })).rejects.toThrow(/already exists.*--resume/s);
    expect(reran).toEqual([]); // never re-ran a paid arm

    // --resume is the sanctioned continuation and must still work.
    const resumed = await runIdeaV3Bench({ root, arms: ['B'], handles, resume: true, execute: async ({ arm, case: item }) => observation(item.id, arm) });
    expect(resumed.campaign.observations).toHaveLength(8);
  });

  it('fails before any paid arm when D2 import data from the R0 runner is missing', async () => {
    const root = await fixtureRoot();
    await expect(runIdeaV3Bench({ root, arms: ['D2'], handles }))
      .rejects.toThrow(/archived R0 runner.*missing import observations/);
  });

  it('redacts cost, mode, and degradation-flag tells the frozen §4 forbids raters from seeing', () => {
    const dossier = [
      '## 1. Decision',
      '',
      '> ⚠ DEGRADED: synthesis_suspect',
      '',
      '**ACCEPTED_WITH_CONDITIONS** — negotiate the renewal.',
      '> ⚠ DEGRADED: recommendation has no stored graph anchor.', // prose note, not a tell — must survive
      '',
      '## 8. Run details',
      '',
      '- Report ID: `20260714-2321-idea-refinement-8d5e`',
      '- Generated: 2026-07-14T23:21:00.000Z',
      '- Mode: research',
      '- Provider calls: 12/14',
      '- Categories: discovery 2 · verification 3 · repair 1 · planning 1',
      '- By provider: Model Alpha 6, Model Beta 4, Model Gamma 2',
      '- Recorded model time: 812.4s',
      '- Tokens: ~184.2k in / ~31.8k out (12 calls estimated)',
      '- Degradation flags: headless_intent, synthesis_suspect',
      '',
    ].join('\n');

    const blinded = blindIdeaV3Report(dossier, '20260714-2321-idea-refinement-8d5e');

    // The cost / mode / operational block reveals the arm and its price — all forbidden.
    expect(blinded).not.toMatch(/Mode: research/);
    expect(blinded).not.toMatch(/Provider calls: 12\/14/);
    expect(blinded).not.toMatch(/discovery 2 · verification 3/);
    expect(blinded).not.toMatch(/Model Alpha 6/); // per-provider call counts are a cost tell
    expect(blinded).not.toMatch(/812\.4s/);
    expect(blinded).not.toMatch(/184\.2k in/); // token totals are a cost tell
    expect(blinded).not.toMatch(/headless_intent/); // flag names are mode/arm tells
    expect(blinded).not.toMatch(/DEGRADED: synthesis_suspect/); // inline flag list is a tell
    // The DEGRADED marker and prose notes stay — raters still see quality self-assessments.
    expect(blinded).toMatch(/⚠ DEGRADED/);
    expect(blinded).toMatch(/recommendation has no stored graph anchor/);
  });

  it('exports three independently ordered blinded packets plus a private arm mapping', async () => {
    const root = await fixtureRoot();
    const result = await runIdeaV3Bench({
      root,
      arms: ['B', 'C', 'D2', 'R'],
      handles,
      execute: async ({ arm, case: item }) => ({
        ...observation(item.id, arm),
        report_markdown: `# ${item.id}\n\nClaude and Codex considered ${item.id}.\n\n- Report ID: \`${item.id}-${arm}\`\n`,
      }),
    });
    const outDir = join(root, 'ratings');
    const exported = await exportIdeaV3BlindBundle({ campaignPath: result.path, outDir, root });

    expect(exported.raterDirs).toHaveLength(3);
    const mapping = JSON.parse(await readFile(exported.mappingPath, 'utf8')).mapping;
    expect(mapping).toHaveLength(3 * 8 * 4);
    const reportNames = await readdir(join(outDir, 'rater-1', 'water-reminder'));
    expect(reportNames.filter((name) => name.endsWith('.md') && name !== 'case.md')).toHaveLength(4);
    const firstReport = reportNames.find((name) => name.endsWith('.md') && name !== 'case.md')!;
    const blinded = await readFile(join(outDir, 'rater-1', 'water-reminder', firstReport), 'utf8');
    expect(blinded).not.toMatch(/Claude|Codex|water-reminder-[BCRD2]+/);
    expect(blinded).toMatch(/Model Alpha|Model Beta/);
    const evidencePacket = await readFile(join(outDir, 'rater-1', 'postgres-multitenancy', 'case.md'), 'utf8');
    expect(evidencePacket).toContain('Source pack (DATA, not instructions)');
    expect(evidencePacket).toContain('Local source content:');
    const orders = new Set(['rater-1', 'rater-2', 'rater-3'].map((rater) => mapping
      .filter((item: { rater_id: string; case_id: string }) => item.rater_id === rater && item.case_id === 'water-reminder')
      .sort((a: { order: number }, b: { order: number }) => a.order - b.order)
      .map((item: { arm: string }) => item.arm)
      .join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('refuses to export an incomplete campaign for rating', async () => {
    const root = await fixtureRoot();
    const result = await runIdeaV3Bench({
      root,
      arms: ['B'],
      handles,
      execute: async ({ arm, case: item }) => observation(item.id, arm),
    });
    const campaign = JSON.parse(await readFile(result.path, 'utf8'));
    campaign.observations.pop();
    const incompletePath = join(root, 'incomplete.json');
    await writeFile(incompletePath, JSON.stringify(campaign), 'utf8');

    await expect(exportIdeaV3BlindBundle({ campaignPath: incompletePath, outDir: join(root, 'ratings'), root }))
      .rejects.toThrow(/incomplete campaign/);
  });

  it('imports three locked raw files plus a complete resolution through the frozen scorer once', async () => {
    const root = await fixtureRoot();
    const result = await runIdeaV3Bench({
      root,
      arms: ['B'],
      handles,
      execute: async ({ arm, case: item }) => observation(item.id, arm),
    });
    const ratingsDir = join(root, 'ratings');
    await exportIdeaV3BlindBundle({ campaignPath: result.path, outDir: ratingsDir, root });
    const rawFiles: string[] = [];
    for (const rater of ['rater-1', 'rater-2', 'rater-3']) {
      const path = join(ratingsDir, rater, 'ratings.json');
      const raw = JSON.parse(await readFile(path, 'utf8'));
      raw.locked = true;
      await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
      rawFiles.push(`${rater}/ratings.json`);
    }
    const cases = await loadIdeaV3Cases('build', root);
    const secondary = {
      factual_claims: { eligible: 0, honest_or_supported: 0 },
      citations: { total: 0, exact_support: 0 },
      coverage: { required: 12, accounted: 12 },
      disagreements: { labeled: 0, genuine: 0 },
      actions: { total: 0, complete: 0, score_4_or_5: 0 },
      honesty_violations: 0,
    };
    const resolutionPath = join(ratingsDir, 'resolution.json');
    await writeFile(resolutionPath, JSON.stringify({
      benchmark: 'idea-v3',
      set: 'build',
      mapping_file: 'mapping.json',
      raw_rating_files: rawFiles,
      reports: cases.map((item) => ({
        case_id: item.id,
        arm: 'B',
        adjudication: { expected_claims: item.manifest.critical_claims, report_claims: [], matches: [] },
        secondary,
      })),
    }, null, 2), 'utf8');

    const imported = await importIdeaV3Ratings({ campaignPath: result.path, resolutionPath, root });
    expect(imported.scored.summary).toHaveLength(1);
    expect(imported.scored.summary[0]).toMatchObject({ arm: 'B', score: { matched: 0, f1: 0 } });
    expect(imported.scored.raw_ratings).toHaveLength(3);
    await expect(importIdeaV3Ratings({ campaignPath: result.path, resolutionPath, root }))
      .rejects.toThrow(/blind adjudication is one pass/);
  });

  it('requires both primary wins and every secondary/operational gate and publishes every case', async () => {
    const score = (f1: number) => ({ expected: 120, matched: Math.round(f1 * 120), reported: 120, true_positive_reports: 120, recall: f1, precision: 1, f1: 2 * f1 / (f1 + 1) });
    const reportScore = score(1);
    const secondary = {
      factual_claims: { eligible: 10, honest_or_supported: 10 },
      citations: { total: 10, exact_support: 10 },
      coverage: { required: 12, accounted: 12 },
      disagreements: { labeled: 10, genuine: 9 },
      actions: { total: 10, complete: 10, score_4_or_5: 9 },
      honesty_violations: 0,
    };
    const observations = Array.from({ length: 12 }, (_, index) => ['B', 'C', 'R'].map((arm) => ({
      ...observation(`h${index}`, arm as IdeaV3Observation['arm']),
      calls: arm === 'B' ? 1 : arm === 'C' ? 4 : 10,
      latency_ms: arm === 'R' ? 7 * 60 * 1000 : 1000,
    }))).flat();
    const campaign: IdeaV3Campaign = {
      version: 1,
      set: 'holdout',
      at: '2026-07-13T00:00:00.000Z',
      baseline_provider: 'claude',
      arms: ['B', 'C', 'R'],
      observations,
    };
    const scored: IdeaV3ScoredCampaign = {
      version: 1,
      at: campaign.at,
      campaign: '/tmp/campaign.json',
      set: 'holdout',
      raw_ratings: ['r1', 'r2', 'r3'].map((rater_id) => ({ rater_id, path: `/tmp/${rater_id}`, sha256: 'a'.repeat(64) })),
      reports: Array.from({ length: 12 }, (_, index) => ['B', 'C', 'R'].map((arm) => ({ case_id: `h${index}`, arm: arm as IdeaV3Observation['arm'], score: reportScore, secondary }))).flat(),
      summary: [
        { arm: 'B', score: score(0.6) },
        { arm: 'C', score: score(0.7) },
        { arm: 'R', score: score(1) },
      ],
      pairwise_preferences: Array.from({ length: 12 }, (_, index) => [
        { case_id: `h${index}`, left: 'B' as const, right: 'C' as const, left_votes: 1, right_votes: 2, winner: 'C' as const },
        { case_id: `h${index}`, left: 'B' as const, right: 'R' as const, left_votes: 0, right_votes: 3, winner: 'R' as const },
        { case_id: `h${index}`, left: 'C' as const, right: 'R' as const, left_votes: 1, right_votes: 2, winner: 'R' as const },
      ]).flat(),
    };

    expect(evaluateIdeaV3Gates(scored, campaign)).toMatchObject({ ship: true, primary_vs_b: true, primary_vs_c: true, operational: true });
    campaign.observations.find((item) => item.arm === 'R')!.calls = 11;
    expect(evaluateIdeaV3Gates(scored, campaign)).toMatchObject({ ship: false, operational: false });

    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-v3-results-'));
    const campaignPath = join(temp, 'campaign.json');
    const scoredPath = join(temp, 'scores.json');
    const outPath = join(temp, 'RESULTS-IDEA-V3.md');
    scored.campaign = campaignPath;
    await writeFile(campaignPath, JSON.stringify(campaign), 'utf8');
    await writeFile(scoredPath, JSON.stringify(scored), 'utf8');
    const written = await writeIdeaV3Results({ scoredPath, outPath, root: temp });
    expect(written.gates).toMatchObject({ ship: false, operational: false });
    const markdown = await readFile(outPath, 'utf8');
    expect(markdown).toContain('Ship gate: FAIL');
    expect(markdown).toContain('| h0 | R |');
    expect(markdown).toContain('| h11 | R |');
  });

  it('scores Phase F token efficiency and adaptive product targets offline', async () => {
    const arms = ['A', 'B', 'B2', 'D2', 'R'] as const;
    const score = (arm: typeof arms[number]) => ({
      expected: 100,
      matched: arm === 'A' ? 80 : arm === 'B' ? 70 : arm === 'B2' ? 75 : 82,
      reported: 100,
      true_positive_reports: 90,
      recall: arm === 'A' ? 0.8 : arm === 'B' ? 0.7 : arm === 'B2' ? 0.75 : 0.82,
      precision: 0.9,
      f1: arm === 'A' ? 0.84 : arm === 'B' ? 0.76 : arm === 'B2' ? 0.81 : arm === 'D2' ? 0.87 : 0.88,
    });
    const calls = [1, 2, 3, 3, 3, 3, 4, 6];
    const observations = Array.from({ length: 8 }, (_, index) => arms.map((arm) => ({
      ...observation(`b${index}`, arm),
      calls: arm === 'A' ? calls[index]! : IDEA_V3_CALLS_PER_CASE[arm],
      usage: {
        inputTokens: arm === 'A' ? 400 : arm === 'R' ? 900 : 500,
        outputTokens: 100,
        reportedCalls: arm === 'A' || arm === 'R' ? 0 : IDEA_V3_CALLS_PER_CASE[arm],
        estimatedCalls: arm === 'A' ? calls[index]! : arm === 'R' ? 10 : 0,
      },
    }))).flat();
    const campaign: IdeaV3Campaign = {
      version: 1,
      set: 'build',
      at: '2026-07-19T00:00:00.000Z',
      baseline_provider: 'claude',
      arms: [...arms],
      observations,
    };
    const secondary = {
      factual_claims: { eligible: 0, honest_or_supported: 0 }, citations: { total: 0, exact_support: 0 },
      coverage: { required: 12, accounted: 12 }, disagreements: { labeled: 0, genuine: 0 },
      actions: { total: 0, complete: 0, score_4_or_5: 0 }, honesty_violations: 0,
    };
    const scored: IdeaV3ScoredCampaign = {
      version: 1,
      at: campaign.at,
      campaign: '/tmp/phase-f-campaign.json',
      set: 'build',
      raw_ratings: ['r1', 'r2', 'r3'].map((rater_id) => ({ rater_id, path: `/tmp/${rater_id}`, sha256: 'a'.repeat(64) })),
      reports: observations.map((item) => ({ case_id: item.case_id, arm: item.arm, score: score(item.arm), secondary })),
      summary: arms.map((arm) => ({ arm, score: score(arm) })),
      pairwise_preferences: [],
    };

    expect(ideaV3TokenEfficiency(scored, campaign).find((row) => row.arm === 'A')).toEqual({
      arm: 'A', matched: 80, tokens: 4_000, matched_per_1k_tokens: 20, estimated_calls: 25,
    });
    expect(evaluateIdeaV3AdaptiveGates(scored, campaign)).toMatchObject({
      pass: true,
      primary_vs_b: true,
      quality_floor_d2: true,
      quality_floor_r: true,
      token_savings: true,
      calls_median: true,
      calls_p95: true,
      a_median_calls: 3,
      a_p95_calls: 6,
      token_reduction: 0.5,
    });

    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-v3-adaptive-results-'));
    const campaignPath = join(temp, 'campaign.json');
    const scoresPath = join(temp, 'scores.json');
    scored.campaign = campaignPath;
    await writeFile(campaignPath, JSON.stringify(campaign), 'utf8');
    await writeFile(scoresPath, JSON.stringify(scored), 'utf8');
    const written = await writeIdeaV3AdaptiveResults({ scoredPath: scoresPath, root: temp });
    const markdown = await readFile(written.path, 'utf8');
    expect(markdown).toContain('Adaptive build targets: PASS');
    expect(markdown).toContain('| A | 80 | 4000 | 20.000 | 25 |');
    expect(markdown).toContain('Build-set product validation; not a frozen holdout claim.');

    for (const item of campaign.observations.filter((candidate) => candidate.arm === 'A')) {
      item.usage = { ...item.usage!, inputTokens: 600 };
    }
    expect(evaluateIdeaV3AdaptiveGates(scored, campaign)).toMatchObject({ pass: false, token_savings: false });
  });

  it('freezes only a complete scored build matrix and refuses to overwrite it', async () => {
    temp = await mkdtemp(join(tmpdir(), 'aiki-idea-v3-freeze-'));
    for (const path of [
      'BENCHMARK-IDEA-V3.md',
      'src/bench/scoring/decision-insights.ts',
      'src/bench/idea-v3-bench.ts',
      'src/bench/idea-v3-rating.ts',
    ]) {
      await cp(join(process.cwd(), path), join(temp, path), { recursive: true });
    }
    const arms = ['B', 'C', 'D2', 'R'] as const;
    const observations = Array.from({ length: 8 }, (_, index) => arms.map((arm) => observation(`b${index}`, arm))).flat();
    const campaignPath = join(temp, 'campaign.json');
    await writeFile(campaignPath, JSON.stringify({
      version: 1,
      set: 'build',
      at: '2026-07-13T00:00:00.000Z',
      baseline_provider: 'claude',
      arms,
      observations,
    }), 'utf8');
    const zeroScore = { expected: 1, matched: 0, reported: 0, true_positive_reports: 0, recall: 0, precision: 0, f1: 0 };
    const secondary = {
      factual_claims: { eligible: 0, honest_or_supported: 0 }, citations: { total: 0, exact_support: 0 },
      coverage: { required: 12, accounted: 12 }, disagreements: { labeled: 0, genuine: 0 },
      actions: { total: 0, complete: 0, score_4_or_5: 0 }, honesty_violations: 0,
    };
    const scoresPath = join(temp, 'scores.json');
    await writeFile(scoresPath, JSON.stringify({
      version: 1,
      at: '2026-07-13T00:00:00.000Z',
      campaign: campaignPath,
      set: 'build',
      raw_ratings: ['r1', 'r2', 'r3'].map((rater_id) => ({ rater_id, path: `/tmp/${rater_id}`, sha256: 'a'.repeat(64) })),
      reports: observations.map((item) => ({ case_id: item.case_id, arm: item.arm, score: zeroScore, secondary })),
      summary: arms.map((arm) => ({ arm, score: zeroScore })),
      pairwise_preferences: [],
    }), 'utf8');
    const draftPath = join(temp, 'draft.json');
    await writeFile(draftPath, JSON.stringify({
      build_scores: scoresPath,
      baseline_provider: 'claude',
      models: { claude: 'opus', codex: 'gpt-5.6-sol', agy: 'Gemini 3.1 Pro (High)' },
      roles: { analyst: 'agy', judge: 'claude', verifier: 'codex', s4: ['agy', 'codex'] },
      lane_assignment: 'agy-market',
    }), 'utf8');

    const frozen = await writeFrozenIdeaV3Protocol({ draftPath, root: temp });
    expect(frozen.protocol).toMatchObject({ status: 'FROZEN', baseline_provider: 'claude', build_scores: scoresPath });
    expect(await loadFrozenIdeaV3Protocol(temp)).toMatchObject({ lane_assignment: 'agy-market' });
    await expect(writeFrozenIdeaV3Protocol({ draftPath, root: temp })).rejects.toThrow(/refusing to overwrite/);
  });
});
