#!/usr/bin/env node
// aiki CLI entrypoint. T1: `doctor` wired. TUI (bare `aiki`) + other commands land later.

import { Command } from 'commander';
import { doctor } from './doctor.js';

export const VERSION = '0.1.0';

const program = new Command();

program
  .name('aiki')
  .description('Local multi-model orchestration — coordinate your installed AI CLIs.')
  .version(VERSION);

program
  .command('doctor')
  .description('Detect providers + probe flags; print status table. Exit 0 iff ≥2 ready.')
  .action(async () => {
    process.exit(await doctor());
  });

// Bare `aiki` launches the TUI in T8; until then, show help.
program.action(() => {
  program.help();
});

program.parseAsync(process.argv);
