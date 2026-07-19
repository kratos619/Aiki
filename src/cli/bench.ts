// `aiki bench <workflow> [--arms A,B,C,D] [--set build] [--resume] [--yes]` (§5, §17, §19) — run the
// benchmark arms on a task set, write bench/results/<suite>-<date>.json, print the per-arm summary table.
// Without --yes it prints a pre-run Opus-call estimate and exits (so a big sweep never silently drains the
// quota). --resume continues the latest results file, keeping already-scored case×arm pairs.

import { planBench, renderTable, runBench, type BenchPlan } from '../bench/harness.js';
import type { ArmId } from '../bench/arms.js';
import { setupProviders } from '../orchestration/context.js';
import { chooseLaneDefault, importLaneAdjudications, planIdeaLaneBench, runIdeaLaneBench } from '../bench/idea-lane-rotation.js';
import { IDEA_V3_ARM_IDS, planIdeaV3Bench, runIdeaV3Bench, type IdeaV3Arm } from '../bench/idea-v3-bench.js';
import { exportIdeaV3BlindBundle, importIdeaV3Ratings, publishIdeaV3Results, writeFrozenIdeaV3Protocol } from '../bench/idea-v3-rating.js';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';

const VALID_ARMS: ArmId[] = ['A', 'B', 'C', 'D', 'E', 'L'];

/** One-block pre-run summary: what will run + the ≈Opus cost, so the user commits knowingly (§19). */
function renderPlan(plan: BenchPlan): string {
  const L: string[] = [`bench ${plan.suite} — set ${plan.set} — ${plan.cases.length} case(s) × arms ${plan.arms.join(',')}`];
  if (plan.resumedFrom) L.push(`resume: continuing ${plan.resumedFrom} — ${plan.skipCompleted} case×arm already scored (kept)`);
  const unavail = plan.skipUnavailable ? ` · ${plan.skipUnavailable} skipped (provider unavailable)` : '';
  L.push(`to run: ${plan.toRun.length} case×arm pair(s) → ≈${plan.estClaudeCalls} claude/Opus call(s)${unavail}`);
  return L.join('\n');
}

export async function benchCommand(
  workflow: string,
  opts: {
    arms?: string;
    set?: string;
    resume?: boolean;
    yes?: boolean;
    import?: string;
    case?: string;
    baselineProvider?: string;
    d2Import?: string;
    exportBlind?: string;
    campaign?: string;
    importRatings?: string;
    publishResults?: string;
    freezeProtocol?: string;
  } = {},
): Promise<number> {
  if (workflow === 'idea-v3') {
    if (opts.freezeProtocol) {
      try {
        const result = await writeFrozenIdeaV3Protocol({ draftPath: opts.freezeProtocol });
        process.stdout.write(`\nprotocol frozen: ${result.path}\n`);
        process.stdout.write('Commit this file before opening holdout. No provider calls were made.\n\n');
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (opts.publishResults) {
      try {
        const result = await publishIdeaV3Results({ scoredPath: opts.publishResults });
        process.stdout.write(`\nresults: ${result.path}\n`);
        process.stdout.write(`${result.label}: ${result.passed ? 'PASS' : 'FAIL'}\n\n`);
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (opts.importRatings) {
      try {
        const result = await importIdeaV3Ratings({ campaignPath: opts.campaign, resolutionPath: opts.importRatings });
        process.stdout.write(`\nscored campaign: ${result.path}\n`);
        for (const item of result.scored.summary) {
          process.stdout.write(`${item.arm}: recall ${item.score.recall.toFixed(3)} · precision ${item.score.precision.toFixed(3)} · F1 ${item.score.f1.toFixed(3)}\n`);
        }
        process.stdout.write('Raw locked ratings and hashes were retained. No provider calls were made.\n\n');
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (opts.exportBlind) {
      try {
        const result = await exportIdeaV3BlindBundle({ campaignPath: opts.campaign, outDir: opts.exportBlind });
        process.stdout.write(`\nblinded rating packets: ${result.outDir}\n`);
        process.stdout.write(`private mapping (do not give to raters): ${result.mappingPath}\n`);
        process.stdout.write('Give each rater only their own rater-* directory. No provider calls were made.\n\n');
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    if (opts.set && opts.set !== 'build' && opts.set !== 'holdout') {
      process.stderr.write(`idea-v3 set must be build or holdout (got "${opts.set}")\n`);
      return 1;
    }
    const set = (opts.set ?? 'build') as 'build' | 'holdout';
    const requested = opts.arms
      ? opts.arms.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
      : set === 'build' ? ['B', 'C', 'D2', 'R'] : ['B', 'C', 'R'];
    const invalid = requested.filter((arm) => !(IDEA_V3_ARM_IDS as readonly string[]).includes(arm));
    if (invalid.length) {
      process.stderr.write(`invalid idea-v3 arm(s): ${invalid.join(', ')}. Valid: A,B,B2,C,D2,R\n`);
      return 1;
    }
    const arms = requested as IdeaV3Arm[];
    const provider = opts.baselineProvider ?? 'claude';
    if (!['claude', 'codex', 'agy'].includes(provider)) {
      process.stderr.write(`invalid baseline provider "${provider}". Valid: claude,codex,agy\n`);
      return 1;
    }
    let plan;
    try {
      plan = await planIdeaV3Bench({ set, arms, resume: opts.resume, baselineProvider: provider as ProviderId });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    process.stdout.write(`\nidea-v3 protocol comparison — ${set} — ${plan.cases.length} case(s) × arms ${arms.join(',')}\n`);
    process.stdout.write(`B/B2/C baseline provider: ${DISPLAY_NAME[provider as ProviderId]}\n`);
    if (plan.resumedFrom) process.stdout.write(`resume: continuing ${plan.resumedFrom} — ${plan.skipCompleted} recorded pair(s) kept\n`);
    process.stdout.write(`to run: ${plan.toRun.length} case×arm pair(s) → ≤${plan.estimatedProviderCalls} nominal provider call(s)\n`);
    if (arms.includes('D2')) process.stdout.write('D2 source: archived R0 runner at commit 680fba3 (supply --d2-import when executing)\n');
    if (!plan.toRun.length) {
      process.stdout.write('\nnothing to run — every requested pair is already recorded.\n\n');
      return 0;
    }
    if (!opts.yes) {
      process.stdout.write('\nRe-run with --yes to execute. Paid calls are never started by this dry-run.\n\n');
      return 0;
    }
    try {
      const result = await runIdeaV3Bench({
        set,
        arms,
        resume: opts.resume,
        baselineProvider: provider as ProviderId,
        d2ImportPath: opts.d2Import,
      });
      process.stdout.write(`\nresults: ${result.path}\n`);
      process.stdout.write('Reports remain unscored until the frozen blinded-rating import step.\n\n');
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (workflow === 'idea-refinement') {
    if (opts.set && opts.set !== 'build') {
      process.stderr.write('idea lane rotation is build-set-only; holdout remains sealed\n');
      return 1;
    }
    // --import is offline: blind adjudications → frozen R0 scorer → filled campaign metrics. No provider calls.
    if (opts.import) {
      try {
        const { path, scored, observations } = await importLaneAdjudications({ importPath: opts.import });
        for (const o of scored) {
          process.stdout.write(`scored ${o.case_id}/${o.rotation} — recall ${o.decision_critical_recall} · evidence precision ${o.evidence_precision}\n`);
        }
        const pending = observations.filter((o) => o.decision_critical_recall === null || o.evidence_precision === null).length;
        const selected = pending === 0 ? chooseLaneDefault(observations) : null;
        process.stdout.write(`\nresults: ${path}\n`);
        process.stdout.write(selected
          ? `default lane assignment: ${selected}\n\n`
          : pending > 0
            ? `${pending} pair(s) still unscored — the lane default stays provisional until every pair is adjudicated.\n\n`
            : 'all pairs scored but no winner (incomplete matrix or exact tie) — default stays provisional.\n\n');
        return 0;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    const handles = await setupProviders();
    let plan;
    try {
      plan = await planIdeaLaneBench({ handles, resume: opts.resume, caseId: opts.case });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (plan.cases.length === 0) {
      process.stderr.write('no cases found in bench/sets/idea-refinement/build/\n');
      return 1;
    }
    process.stdout.write(`\nidea lane rotation — ${plan.cases.length} case(s) × 2 assignments\n`);
    if (plan.resumedFrom) process.stdout.write(`resume: continuing ${plan.resumedFrom} — completed pairs are kept, not re-run\n`);
    process.stdout.write(`to run: ${plan.runs.length} council run(s) → ≈${plan.estimatedCalls} provider call(s)\n`);
    if (plan.runs.length === 0) {
      process.stdout.write('\nnothing to run — every case×rotation pair is already recorded.\n\n');
      return 0;
    }
    if (!opts.yes) {
      const resumeHint = opts.resume ? '' : ' (add --resume to continue a partial run across quota windows)';
      process.stdout.write(`\nRe-run with --yes to execute${resumeHint}. Paid calls are never started by this dry-run.\n\n`);
      return 0;
    }
    const result = await runIdeaLaneBench({ handles, resume: opts.resume, caseId: opts.case });
    const selected = chooseLaneDefault(result.observations);
    process.stdout.write(`\nresults: ${result.path}\n`);
    process.stdout.write(selected
      ? `default lane assignment: ${selected}\n\n`
      : 'default remains provisional — blind-score recall/evidence precision before selection.\n\n');
    return 0;
  }
  if (workflow !== 'code-review') {
    process.stderr.write(`bench supports "code-review", "idea-refinement", or "idea-v3" (got "${workflow}")\n`);
    return 1;
  }
  const arms = (opts.arms ?? 'A,B,C,D')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((a): a is ArmId => (VALID_ARMS as string[]).includes(a));
  if (arms.length === 0) {
    process.stderr.write(`no valid arms in "${opts.arms}". Valid: A,B,C,D,E,L\n`);
    return 1;
  }
  const set = opts.set ?? 'build';
  const handles = await setupProviders(); // detection only (no model calls); shared by plan + run

  const plan = await planBench({ suite: 'code-review', set, arms, resume: opts.resume, handles });
  if (plan.cases.length === 0) {
    process.stderr.write(`no cases found in bench/sets/code-review/${set}/ — create <name>/{diff.patch,bugs.json} case dirs first\n`);
    return 1;
  }

  process.stdout.write(`\n${renderPlan(plan)}\n`);
  if (plan.toRun.length === 0) {
    process.stdout.write(`\nnothing to run — every requested arm is already scored on every case.\n\n`);
    return 0;
  }
  if (!opts.yes) {
    const resumeHint = opts.resume ? '' : ' (add --resume to continue a partial run across quota windows)';
    process.stdout.write(`\nThis makes ≈${plan.estClaudeCalls} claude/Opus call(s). Re-run with --yes to execute${resumeHint}.\n\n`);
    return 0;
  }

  const result = await runBench({ suite: 'code-review', set, arms, resume: opts.resume, handles });
  process.stdout.write(`\n${renderTable(result)}\n\n  results: ${plan.resultsPath}\n\n`);
  return 0;
}
