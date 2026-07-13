import { describe, it, expect } from 'vitest';

import { spawnCapture } from '../src/providers/spawn.js';

describe('spawnCapture per-call timeout', () => {
  // Reproduces the school-ai-tutor hang: the direct child exits fast but leaves a grandchild in a NEW
  // session (detached) still holding the captured stderr pipe. `process.kill(-childPid)` misses that
  // grandchild, so waiting on 'close' would block until the grandchild ends. The timeout MUST bound the
  // call regardless — resolve at ~timeoutMs with timedOut=true, not when the survivor finally exits.
  it('resolves at the timeout even when a detached grandchild survives the group kill', async () => {
    const grandchildSeconds = 8;
    const code = `const cp=require('child_process');`
      + `cp.spawn('sleep',['${grandchildSeconds}'],{detached:true,stdio:['ignore','ignore',2]}).unref();`;
    const started = Date.now();
    const result = await spawnCapture('node', ['-e', code], { timeoutMs: 500 });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(grandchildSeconds * 1000 - 2000); // must NOT wait for the survivor
  });

  it('returns normally when the child exits before the timeout', async () => {
    const result = await spawnCapture('node', ['-e', "process.stdout.write('hi')"], { timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('hi');
  });
});
