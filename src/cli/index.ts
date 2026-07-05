#!/usr/bin/env node
// aiki CLI entrypoint. Subcommands: doctor / providers / run / show / resolve / config.
// Bare `aiki` mounts the interactive TUI (T8), honoring .aiki/config.json (T9).

import { Command } from 'commander';
import { doctor } from './doctor.js';
import { providers } from './providers.js';
import { runCommand } from './run.js';
import { show } from './show.js';
import { resolve } from './resolve.js';
import { config } from './config.js';
import { benchCommand } from './bench.js';
import { ConfigError, loadConfig } from '../config/config.js';
import { startTui } from '../tui/index.js';

export const VERSION = '0.1.0';

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
  .description('Headless run of a workflow (§5). idea-refinement: text/file. code-review: --base/--head or --diff.')
  .argument('<workflow>', 'workflow id: idea-refinement | code-review')
  .argument('[input]', 'idea-refinement: inline text or a path to a .md file')
  .option('--budget <n>', 'max provider calls for this run (default 12)', (v) => parseInt(v, 10))
  .option('--base <ref>', 'code-review: base git ref to diff from')
  .option('--head <ref>', 'code-review: head git ref to diff to (default HEAD)')
  .option('--diff <file>', 'code-review: review a patch file instead of computing a git diff')
  .option('--cheap', 'code-review: Gemini+Codex review, Claude judges only disputes (~⅓ the Opus; experimental)')
  .action(async (workflow: string, input: string | undefined, opts: { budget?: number; base?: string; head?: string; diff?: string; cheap?: boolean }) => {
    process.exit(await runCommand(workflow, input, { budget: opts.budget, base: opts.base, head: opts.head, diff: opts.diff, cheap: opts.cheap }));
  });

program
  .command('show')
  .description('Print a stored run\'s final report; --raw lists artifact files. No id → latest run.')
  .argument('[run-id]', 'run id or a unique suffix/substring (omit for the most recent run)')
  .option('--raw', 'list the run\'s artifact files instead of the report')
  .action(async (runId: string | undefined, opts: { raw?: boolean }) => {
    process.exit(await show(runId, { raw: opts.raw }));
  });

program
  .command('resolve')
  .description('Annotate a run\'s adjudicated disputes → .aiki/feedback.jsonl (§127). No id → latest run.')
  .argument('[run-id]', 'run id or a unique suffix/substring (omit for the most recent run)')
  .option('--verdict <id=verdict>', 'non-interactive verdict, repeatable: <item-id>=<correct|incorrect|unsure>', collect, [])
  .action(async (runId: string | undefined, opts: { verdict?: string[] }) => {
    process.exit(await resolve(runId, { verdict: opts.verdict }));
  });

program
  .command('bench')
  .description('Run benchmark arms A–D on a task set; writes bench/results/*.json + summary table (§17).')
  .argument('<workflow>', 'workflow id (v1: code-review)')
  .option('--arms <list>', 'comma-separated arms to run', 'A,B,C,D')
  .option('--set <name>', 'task set: build | holdout', 'build')
  .option('--resume', 'continue the latest results file: keep already-scored case×arm pairs, retry the rest')
  .option('--yes', 'actually run; without it, print the pre-run Opus-call estimate and exit')
  .action(async (workflow: string, opts: { arms?: string; set?: string; resume?: boolean; yes?: boolean }) => {
    process.exit(await benchCommand(workflow, { arms: opts.arms, set: opts.set, resume: opts.resume, yes: opts.yes }));
  });

program
  .command('config')
  .description('Print the effective config; --edit opens .aiki/config.json (§128).')
  .option('--edit', 'open .aiki/config.json in $VISUAL/$EDITOR (created if missing)')
  .action(async (opts: { edit?: boolean }) => {
    process.exit(await config({ edit: opts.edit }));
  });

// Bare `aiki` (no subcommand) → interactive TUI, honoring config (roles/budget).
program.action(async () => {
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  startTui({ roleOverrides: cfg.roles, budget: cfg.budget });
});

program.parseAsync(process.argv);
