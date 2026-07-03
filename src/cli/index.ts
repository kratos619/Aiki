#!/usr/bin/env node
// aiki CLI entrypoint. Subcommands: doctor / providers / run. Bare `aiki` mounts the interactive TUI (T8).

import { Command } from 'commander';
import { doctor } from './doctor.js';
import { providers } from './providers.js';
import { runCommand } from './run.js';
import { startTui } from '../tui/index.js';

export const VERSION = '0.1.0';

const program = new Command();

program
  .name('aiki')
  .description('Local multi-model orchestration — coordinate your installed AI CLIs.')
  .version(VERSION);

program
  .command('doctor')
  .description('Detect providers + probe flags + smoke test; print status table. Exit 0 iff ≥2 ready.')
  .option('--no-smoke', 'skip the live smoke test (detection + probe only; no model calls)')
  .action(async (opts: { smoke?: boolean }) => {
    process.exit(await doctor({ smoke: opts.smoke }));
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
  .description('Headless run of a workflow on inline text or a file path (§5).')
  .argument('<workflow>', 'workflow id: idea-refinement | code-review')
  .argument('[input]', 'inline text or a path to a .md file')
  .option('--budget <n>', 'max provider calls for this run (default 12)', (v) => parseInt(v, 10))
  .action(async (workflow: string, input: string | undefined, opts: { budget?: number }) => {
    process.exit(await runCommand(workflow, input, { budget: opts.budget }));
  });

// Bare `aiki` (no subcommand) → interactive TUI.
program.action(() => {
  startTui();
});

program.parseAsync(process.argv);
