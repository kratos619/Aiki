#!/usr/bin/env node
// aiki CLI entrypoint. Subcommands: doctor / providers / run / show / resolve / config.
// Bare `aiki` mounts the interactive TUI (T8), honoring .aiki/config.json (T9).

import { Command } from 'commander';
import { doctor } from './doctor.js';
import { providers } from './providers.js';
import { runCommand } from './run.js';
import { show } from './show.js';
import { resolve } from './resolve.js';
import { resumeCommand } from './resume.js';
import { sessionsCommand } from './sessions.js';
import { config } from './config.js';
import { modelsCommand } from './models.js';
import { benchCommand } from './bench.js';
import { VERSION } from './version.js';
import { ConfigError, loadLayeredConfig } from '../config/config.js';
import { resolveRunsRoot } from '../storage/paths.js';
import { startTui } from '../tui/index.js';

const program = new Command();

/** commander collector for a repeatable option. */
const collect = (v: string, acc: string[]): string[] => {
  acc.push(v);
  return acc;
};

program
  .name('aiki')
  .description('Local multi-model orchestration — coordinate your installed AI CLIs.')
  .version(VERSION);

program
  .command('doctor')
  .description('Detect providers + probe flags + smoke test; print status table. Exit 0 iff ≥2 ready.')
  .option('--no-smoke', 'skip the live smoke test (detection + probe only; no model calls)')
  .option('--fresh', 'bypass the 6h smoke cache and re-run the smoke test')
  .action(async (opts: { smoke?: boolean; fresh?: boolean }) => {
    process.exit(await doctor({ smoke: opts.smoke, fresh: opts.fresh }));
  });

program
  .command('providers')
  .description('Machine-readable provider status: resolved capability profiles (§7.4). No model calls.')
  .option('--json', 'print the resolved capability profiles as JSON')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await providers({ json: opts.json }));
  });

program
  .command('run')
  .description('Headless run of a workflow (§5). idea-refinement: text/file. code-review: git diff or --diff.')
  .argument('<workflow>', 'workflow id: idea-refinement | code-review')
  .argument('[input]', 'idea-refinement: inline text or a path to a .md file')
  .option('--budget <n>', 'max provider calls for this run (default is mode-aware)', (v) => parseInt(v, 10))
  .option('--base <ref>', 'code-review: base git ref to diff from (default: detected default branch)')
  .option('--head <ref>', 'code-review: head git ref to diff to (default HEAD)')
  .option('--diff <file>', 'code-review: review a patch file instead of computing a git diff')
  .option('--evidence <path>', 'idea-refinement: local source file/directory (stores paths + hashes, not copies)')
  .option('--mode <mode>', 'idea-refinement: quick | council (research is an alias for council)')
  .option('--cheap', 'code-review: Gemini+Codex review, Claude judges only disputes (~⅓ the Opus; experimental)')
  .option('--yes', 'skip the run-cost confirmation prompt')
  .action(async (workflow: string, input: string | undefined, opts: { budget?: number; base?: string; head?: string; diff?: string; evidence?: string; mode?: string; cheap?: boolean; yes?: boolean }) => {
    process.exit(await runCommand(workflow, input, { budget: opts.budget, base: opts.base, head: opts.head, diff: opts.diff, evidence: opts.evidence, mode: opts.mode, cheap: opts.cheap, yes: opts.yes }));
  });

program
  .command('show')
  .description('Print a stored run\'s final report; --raw lists artifact files. No id → latest run.')
  .argument('[run-id]', 'run id or a unique suffix/substring (omit for the most recent run)')
  .option('--raw', 'list the run\'s artifact files instead of the report')
  .option('--html', 'write a self-contained council-view HTML file and print its path')
  .option('--open', 'with --html, open the generated file in the default browser')
  .action(async (runId: string | undefined, opts: { raw?: boolean; html?: boolean; open?: boolean }) => {
    process.exit(await show(runId, { raw: opts.raw, html: opts.html, open: opts.open, root: await resolveRunsRoot() }));
  });

program
  .command('resolve')
  .description('Annotate a run\'s adjudicated disputes → .aiki/feedback.jsonl (§127). No id → latest run.')
  .argument('[run-id]', 'run id or a unique suffix/substring (omit for the most recent run)')
  .option('--verdict <id=verdict>', 'non-interactive verdict, repeatable: <item-id>=<correct|incorrect|unsure>', collect, [])
  .action(async (runId: string | undefined, opts: { verdict?: string[] }) => {
    process.exit(await resolve(runId, { verdict: opts.verdict, root: await resolveRunsRoot() }));
  });

program
  .command('sessions')
  .description('List runs from the global registry (~/.aiki/sessions.jsonl), newest first.')
  .option('--json', 'print the registry as JSON')
  .action(async (opts: { json?: boolean }) => {
    process.exit(await sessionsCommand({ json: opts.json }));
  });

program
  .command('resume')
  .description('Continue a killed/timed-out run from where it stopped (replays completed calls; §V6.3).')
  .argument('[run-id]', 'run id or a unique suffix/substring (see `aiki sessions`)')
  .action(async (runId: string | undefined) => {
    process.exit(await resumeCommand(runId, { root: await resolveRunsRoot() }));
  });

program
  .command('bench')
  .description('Run code-review, idea lane, or frozen idea-v3 benchmark arms; writes bench/results/*.json.')
  .argument('<workflow>', 'code-review | idea-refinement | idea-v3')
  .option('--arms <list>', 'comma-separated arms to run (code review defaults A,B,C,D; idea-v3 defaults B,C,D2,R on build)')
  .option('--set <name>', 'task set: build | holdout', 'build')
  .option('--resume', 'continue the latest results file: keep already-scored case×arm pairs, retry the rest')
  .option('--yes', 'actually run; without it, print the pre-run Opus-call estimate and exit')
  .option('--import <file>', 'idea-refinement: import blind adjudications into the latest campaign file (offline, frozen R0 scorer)')
  .option('--case <id>', 'idea-refinement: restrict the metered run to one build case (combine with --resume)')
  .option('--baseline-provider <id>', 'idea-v3 build tuning: provider used for B/C (claude | codex | agy)', 'claude')
  .option('--d2-import <file>', 'idea-v3 build: observations produced by the archived R0 runner at commit 680fba3')
  .option('--export-blind <dir>', 'idea-v3: export 3 independently ordered offline rating packets from a complete campaign')
  .option('--import-ratings <file>', 'idea-v3: score a locked three-rater resolution once (offline, frozen R0 scorer)')
  .option('--freeze-protocol <draft-file>', 'idea-v3: freeze a complete scored build protocol once (offline)')
  .option('--publish-results <scores-file>', 'idea-v3: write RESULTS-IDEA-V3.md from frozen holdout scores (offline)')
  .option('--campaign <file>', 'idea-v3 offline operation: explicit campaign file (default: latest)')
  .action(async (workflow: string, opts: { arms?: string; set?: string; resume?: boolean; yes?: boolean; import?: string; case?: string; baselineProvider?: string; d2Import?: string; exportBlind?: string; importRatings?: string; freezeProtocol?: string; publishResults?: string; campaign?: string }) => {
    process.exit(await benchCommand(workflow, {
      arms: opts.arms,
      set: opts.set,
      resume: opts.resume,
      yes: opts.yes,
      import: opts.import,
      case: opts.case,
      baselineProvider: opts.baselineProvider,
      d2Import: opts.d2Import,
      exportBlind: opts.exportBlind,
      importRatings: opts.importRatings,
      freezeProtocol: opts.freezeProtocol,
      publishResults: opts.publishResults,
      campaign: opts.campaign,
    }));
  });

program
  .command('models')
  .description('Show configurable models per provider (lists via the CLI where supported) + your current pins.')
  .action(async () => {
    process.exit(await modelsCommand());
  });

program
  .command('config')
  .description('Print the effective config; --edit opens .aiki/config.json (§128).')
  .option('--edit', 'open .aiki/config.json in $VISUAL/$EDITOR (created if missing)')
  .action(async (opts: { edit?: boolean }) => {
    process.exit(await config({ edit: opts.edit }));
  });

// Bare `aiki` (no subcommand) → interactive TUI, honoring layered config (roles/budget/models).
program.action(async () => {
  let cfg;
  try {
    cfg = await loadLayeredConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  startTui({ roleOverrides: cfg.roles, budget: cfg.budget, runsRoot: await resolveRunsRoot(), providerModels: cfg.models, version: VERSION });
});

program.parseAsync(process.argv);
