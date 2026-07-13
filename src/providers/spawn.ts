import { execa } from 'execa';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, RunFn, SpawnCaptureFn } from './types.js';

const STDERR_TAIL_CAP = 8000;
let seq = 0;

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

/**
 * Run a provider CLI and capture its full output for adapter run() (§7.2).
 * - stdout → temp file via inherited fd (true redirect; avoids claude's 8KB pipe truncation).
 * - stderr → pipe, kept as a tail (for error classification / stderrTail).
 * - detached process group so a timeout kills the whole tree, not just the direct child.
 * - env is supplied filtered by the caller (adapter-core strips /KEY|TOKEN|SECRET/i).
 */
export const spawnCapture: SpawnCaptureFn = (bin, args, { cwd, timeoutMs, env, signal }) => {
  const started = Date.now();
  const outPath = join(tmpdir(), `aiki-run-${process.pid}-${seq++}.out`);
  const fd = openSync(outPath, 'w');
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    let notFound = false;
    let settled = false;

    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', fd, 'pipe'] });
    child.unref(); // a child that survives the group-kill must never keep our process alive post-resolve

    // SIGKILL the whole detached process group. Shared by the timeout and the Ctrl+C abort (T8).
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // Bound the call at timeoutMs even if the group-kill missed a detached child holding our pipe/fd
      // (observed with the claude CLI). Waiting on 'close' alone lets one hung call overrun the wall-clock
      // deadline by an unbounded amount; force-resolve instead. A late 'close' is ignored (`settled`).
      finish(null, 'SIGKILL');
    }, timeoutMs);

    // Ctrl+C: kill the in-flight child immediately so no orphaned metered call survives (§472, T8).
    const onAbort = () => killGroup();
    if (signal) {
      if (signal.aborted) killGroup();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, signal2: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      let stdout = '';
      try {
        stdout = readFileSync(outPath, 'utf8');
      } catch {
        /* empty */
      }
      rmSync(outPath, { force: true });
      resolve({
        code,
        signal: signal2 ?? null,
        stdout,
        stderr: stderr.length > STDERR_TAIL_CAP ? stderr.slice(-STDERR_TAIL_CAP) : stderr,
        timedOut,
        notFound,
        durationMs: Date.now() - started,
      });
    };

    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STDERR_TAIL_CAP * 2) stderr = stderr.slice(-STDERR_TAIL_CAP);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      notFound = e.code === 'ENOENT';
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
};
