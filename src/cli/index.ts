#!/usr/bin/env node
// aiki CLI entrypoint. T0 skeleton — commands wired in T1+.

export const VERSION = '0.1.0';

function main(): void {
  process.stdout.write(`aiki v${VERSION}\n`);
}

main();
