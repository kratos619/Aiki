import { execa } from 'execa';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, RunFn } from './types.js';

/**
 * Real process runner backing detection and flag probes (metadata calls only).
 * `shell: false` (execa default) — argv array, no shell interpolation (§7.2 injection safety).
 * Adapter run() in T2 adds env filtering, process-tree kill, and retry on top of this shape.
 */
export const runCommand: RunFn = async (bin, args, timeoutMs) => {
  try {
    const r = await execa(bin, args, { timeout: timeoutMs, reject: false });
    return {
      code: r.exitCode ?? null,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
      notFound: false,
    };
  } catch (e: unknown) {
    const err = e as { code?: string; exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean; message?: string };
    return {
      code: err.exitCode ?? null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      timedOut: err.timedOut ?? false,
      notFound: err.code === 'ENOENT',
    };
  }
};

/**
 * Capture a command's full output by redirecting the child's stdout/stderr straight
 * to a temp file (true fd redirect, not a pipe). Some CLIs (claude) call process.exit()
 * which truncates async *pipe* writes at ~8KB; execa's own pipe/`{file}` capture hits
 * this. Inheriting a file fd lets the child write the full ~16KB --help. Fixed internal
 * argv only — no user input reaches here.
 */
export function captureFull(id: ProviderId, bin: string, args: string[], timeoutMs: number): Promise<string> {
  const path = join(tmpdir(), `aiki-probe-${id}-${process.pid}.txt`);
  const fd = openSync(path, 'w');
  return new Promise<void>((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('close', done);
    child.on('error', done); // ENOENT etc → empty file, probe reports drift
  }).then(() => {
    closeSync(fd);
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    } finally {
      rmSync(path, { force: true });
    }
  });
}
