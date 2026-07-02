#!/usr/bin/env node
// aiki CLI entrypoint. T1: `doctor` wired. TUI (bare `aiki`) + other commands land later.

import { Command } from 'commander';
import { doctor } from './doctor.js';
import { providers } from './providers.js';

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

// Bare `aiki` launches the TUI in T8; until then, show help.
program.action(() => {
  program.help();
});

program.parseAsync(process.argv);
