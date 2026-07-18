// HD5 acceptance — scoped, atomic settings persistence. No provider calls.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '../src/config/config.js';
import { FlightDeck } from '../src/serve/flight-deck.js';

describe('HD5 settings persistence', () => {
  let scratch: string;
  let home: string;
  let projectRoot: string;
  const previousHome = process.env.AIKI_HOME;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aiki-hd5-'));
    home = join(scratch, 'home');
    projectRoot = join(scratch, 'project', '.aiki');
    await mkdir(home, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    process.env.AIKI_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.AIKI_HOME;
    else process.env.AIKI_HOME = previousHome;
    await rm(scratch, { recursive: true, force: true });
  });

  it('writes project settings over global defaults and preserves unrelated project config', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ models: { claude: 'global-claude' }, roles: { judge: 'claude' } }));
    await writeFile(join(projectRoot, 'config.json'), JSON.stringify({ budget: 7, roles: { verifier: 'codex' } }));
    const deck = new FlightDeck({ runsRoot: projectRoot, version: 'test' });

    const view = await deck.updateSettings({
      models: { codex: 'gpt-5.6-sol', agy: 'gemini-3.1-pro' },
      roles: { judge: 'claude', verifier: 'codex', analyst: 'agy', s4: ['agy', 'codex'], responder: 'claude' },
    });

    expect(view).toMatchObject({
      models: { claude: 'global-claude', codex: 'gpt-5.6-sol', agy: 'gemini-3.1-pro' },
      roles: { judge: 'claude', verifier: 'codex', analyst: 'agy', s4: ['agy', 'codex'], responder: 'claude' },
      scope: 'project (.aiki/config.json)',
    });
    expect(JSON.parse(await readFile(join(projectRoot, 'config.json'), 'utf8'))).toEqual({
      budget: 7,
      roles: { verifier: 'codex', judge: 'claude', analyst: 'agy', s4: ['agy', 'codex'], responder: 'claude' },
      models: { codex: 'gpt-5.6-sol', agy: 'gemini-3.1-pro' },
    });
    expect(await readdir(projectRoot)).toEqual(['config.json']);
  });

  it('writes global settings when launched outside a repository', async () => {
    const deck = new FlightDeck({ runsRoot: home, version: 'test' });

    const view = await deck.updateSettings({ models: { claude: 'claude-opus-4-8' }, roles: { responder: 'agy' } });

    expect(view.scope).toBe('global (~/.aiki/config.json)');
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual({
      models: { claude: 'claude-opus-4-8' }, roles: { responder: 'agy' },
    });
  });

  it('refuses to clobber an invalid existing config', async () => {
    const path = join(projectRoot, 'config.json');
    await writeFile(path, '{ broken json');
    const deck = new FlightDeck({ runsRoot: projectRoot, version: 'test' });

    await expect(deck.updateSettings({ roles: { judge: 'codex' } })).rejects.toBeInstanceOf(ConfigError);
    expect(await readFile(path, 'utf8')).toBe('{ broken json');
  });

  it('refuses a project write while the inherited global config is invalid', async () => {
    await writeFile(join(home, 'config.json'), '{ broken global json');
    const deck = new FlightDeck({ runsRoot: projectRoot, version: 'test' });

    await expect(deck.updateSettings({ roles: { judge: 'codex' } })).rejects.toBeInstanceOf(ConfigError);
    await expect(readFile(join(projectRoot, 'config.json'), 'utf8')).rejects.toThrow();
  });

  it('clears a project override so the global value applies again', async () => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ models: { codex: 'global-model' }, roles: { judge: 'claude' } }));
    await writeFile(join(projectRoot, 'config.json'), JSON.stringify({ models: { codex: 'project-model' }, roles: { judge: 'agy' } }));
    const deck = new FlightDeck({ runsRoot: projectRoot, version: 'test' });

    const view = await deck.updateSettings({ models: { codex: null }, roles: { judge: null } });

    expect(view.models.codex).toBe('global-model');
    expect(view.roles.judge).toBe('claude');
    expect(JSON.parse(await readFile(join(projectRoot, 'config.json'), 'utf8'))).toEqual({});
  });
});
