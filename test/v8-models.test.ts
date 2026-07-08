// V8 — per-provider model config: the chosen model reaches the CLI as `--model <id>`, and config layers.
import { describe, it, expect } from 'vitest';
import { claude } from '../src/providers/claude.js';
import { codex } from '../src/providers/codex.js';
import { agy } from '../src/providers/agy.js';
import { mergeConfig, AikiConfig } from '../src/config/config.js';
import type { Adapter, FlagProfile, RawResult, RunRequest, SpawnCaptureFn } from '../src/providers/types.js';

const REQ: RunRequest = { prompt: 'hello', cwd: '.', timeoutMs: 1000, expectJson: true, readOnly: true };
const OK: RawResult = { code: 0, signal: null, stdout: '{}', stderr: '', timedOut: false, notFound: false, durationMs: 1 };

/** Run an adapter with an injected spawn that captures the argv the CLI would be launched with. */
async function argvFor(adapter: Adapter, flags: FlagProfile): Promise<string[]> {
  let captured: string[] = [];
  const spawn: SpawnCaptureFn = async (_bin, args) => {
    captured = args;
    return OK;
  };
  await adapter.run(REQ, flags, { spawn });
  return captured;
}

describe('V8 buildArgs: --model injection', () => {
  it('claude: adds --model when the flag profile carries a model', async () => {
    const args = await argvFor(claude, { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan', model: 'opus-4.9' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus-4.9');
  });

  it('codex: adds --model before the prompt (exec subcommand)', async () => {
    const args = await argvFor(codex, { id: 'codex', jsonOutput: false, readOnlyFlag: 'sandbox', model: 'gpt-5-codex' });
    expect(args.indexOf('--model')).toBeGreaterThan(-1);
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('hello')); // model precedes the prompt
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex');
  });

  it('agy: passes a spaced model id as a single argv element', async () => {
    const args = await argvFor(agy, { id: 'agy', jsonOutput: false, readOnlyFlag: 'sandbox', model: 'Gemini 3.1 Pro (High)' });
    expect(args[args.indexOf('--model') + 1]).toBe('Gemini 3.1 Pro (High)');
  });

  it('no model in the profile → no --model flag (CLI default)', async () => {
    const args = await argvFor(claude, { id: 'claude', jsonOutput: true, readOnlyFlag: 'plan' });
    expect(args).not.toContain('--model');
  });
});

describe('V8 config: models schema + layering', () => {
  it('accepts a models block; rejects an unknown provider key', () => {
    expect(AikiConfig.safeParse({ models: { agy: 'Gemini 3.1 Pro (High)', claude: 'opus' } }).success).toBe(true);
    expect(AikiConfig.safeParse({ models: { gpt: 'x' } }).success).toBe(false); // strict → typo hard-fails
  });

  it('mergeConfig: project overrides global per field, but roles/models keys merge', () => {
    const global = AikiConfig.parse({ budget: 10, roles: { judge: 'claude' }, models: { agy: 'gem-a', claude: 'opus-global' } });
    const project = AikiConfig.parse({ budget: 20, roles: { verifier: 'codex' }, models: { claude: 'opus-proj' } });
    const merged = mergeConfig(global, project);
    expect(merged.budget).toBe(20); // project wins the scalar
    expect(merged.roles).toEqual({ judge: 'claude', verifier: 'codex' }); // keys merged
    expect(merged.models).toEqual({ agy: 'gem-a', claude: 'opus-proj' }); // agy from global, claude overridden
  });
});
