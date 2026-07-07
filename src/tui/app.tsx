// The Ink app (T8, §11 screens). Thin/dumb rendering over the pure logic in timeline.ts + format.ts;
// all the engine work goes through the standard primitives (setupProviders → resolveRoles → RunCtx →
// executeRun) with an `events` object wired to React state. Ctrl+C aborts via an AbortController.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';
import {
  RunCtx,
  DEFAULT_BUDGET,
  makeRunId,
  resolveRoles,
  setupProviders,
  type ClarifyChoice,
  type ProviderHandle,
  type RoleMap,
  type RunEvents,
  type WorkflowId,
} from '../orchestration/context.js';
import { executeRun } from '../orchestration/engine.js';
import { RunWriter } from '../storage/runs.js';
import { recordSession, updateSessionStatus, readSessions, findSession } from '../storage/sessions.js';
import { buildReplayCache } from '../storage/replay.js';
import { loadLayeredConfig, effectiveConfig } from '../config/config.js';
import { formatModels } from '../cli/models.js';
import { IDEA_STAGES, runIdeaRefinement } from '../workflows/idea-refinement.js';
import { CR_STAGES, runCodeReview } from '../workflows/code-review.js';
import { computeDiff, computeWorkingTreeDiff, detectRepoStatus, type RepoStatus } from '../orchestration/git.js';
import { loadCouncilView, type CouncilView } from '../council/view.js';
import { GLYPH, displayNames, elapsedLabel, initTimeline, markEnd, markStart, progressBar, runningPhrase, totalElapsed, type StageRow } from './timeline.js';
import { formatCompletion, formatError, type CompletionView, type ErrorView } from './format.js';
import { COMMANDS, PRODUCT_LINE, filterCommands, parseCommand, routeInput, suggestCommand, type ParsedCommand, type QuickAction } from './smart-entry.js';

type Phase = 'detecting' | 'input' | 'running' | 'clarify' | 'finished';
type WorkflowRunner = (ctx: RunCtx, input: string) => Promise<void>;

async function loadCompletion(dir: string): Promise<CompletionView | null> {
  try {
    const [judge, map] = await Promise.all([
      readFile(join(dir, '09-judge-report.json'), 'utf8').then((s) => JSON.parse(s)),
      readFile(join(dir, '07-disagreement-map.json'), 'utf8').then((s) => JSON.parse(s)),
    ]);
    return formatCompletion(dir, judge, map);
  } catch {
    return null;
  }
}

/** Config passed from the CLI entry (T9): role pins + budget from .aiki/config.json. */
export interface AppProps {
  roleOverrides?: Partial<RoleMap>;
  budget?: number;
  runsRoot?: string; // hybrid runs root resolved by the CLI entry (repo .aiki vs ~/.aiki).
  providerModels?: Partial<Record<ProviderId, string>>; // V8: per-provider model → CLI --model
  version?: string; // shown in the home banner (V9)
}

export function App(props: AppProps): React.JSX.Element {
  const { roleOverrides, budget: budgetOverride, runsRoot, providerModels, version } = props;
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('detecting');
  const [workflow, setWorkflow] = useState<WorkflowId>('idea-refinement');
  const [handles, setHandles] = useState<ProviderHandle[]>([]);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [idea, setIdea] = useState('');
  const [routerMessage, setRouterMessage] = useState('');
  const [rows, setRows] = useState<StageRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [budget, setBudget] = useState(0);
  const [dir, setDir] = useState('');
  const [clarify, setClarify] = useState<{ question: string; options: string[]; resolve: (c: ClarifyChoice) => void } | null>(null);
  const [clarifyTyping, setClarifyTyping] = useState(false); // "type your own" sub-mode
  const [clarifyText, setClarifyText] = useState('');
  const [panel, setPanel] = useState<string | null>(null); // V9: /sessions /models /config /help output
  const [sel, setSel] = useState(0); // V10: command-palette highlight index
  // V10: TextInput only puts the cursor at the end on MOUNT (ink-text-input keeps the old offset on an
  // external value change). Bumping this key remounts it after a Tab-complete so typing continues at the end.
  const [inputEpoch, setInputEpoch] = useState(0);
  const [pendingIdea, setPendingIdea] = useState<string | null>(null); // V10: confirm gate before a paid run
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [councilView, setCouncilView] = useState<CouncilView | null>(null);
  const [errorView, setErrorView] = useState<ErrorView | null>(null);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const ctxRef = useRef<RunCtx | null>(null);

  // Detect providers + repo context once, up front.
  useEffect(() => {
    let alive = true;
    void Promise.all([setupProviders(providerModels), detectRepoStatus(process.cwd())]).then(([hs, repoStatus]) => {
      if (!alive) return;
      setRepo(repoStatus);
      if (hs.length < 2) {
        setErrorView(formatError('QUORUM'));
        setPhase('finished');
        return;
      }
      setHandles(hs);
      setPhase('input');
    });
    return () => {
      alive = false;
    };
  }, []);

  // Live clock for elapsed labels while running.
  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [phase]);

  // V10 command palette: matches for what's being typed (only on the input screen, not mid-confirm).
  const paletteMatches = phase === 'input' && pendingIdea === null ? filterCommands(idea) : [];
  const selIdx = Math.min(sel, Math.max(paletteMatches.length - 1, 0));

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      abortRef.current?.abort();
      if (clarify) clarify.resolve({ kind: 'pick', index: 0 }); // unblock S2 so the run reaches its abort guard
      if (phase === 'detecting' || phase === 'input' || phase === 'finished') exit();
      return;
    }
    // V10 confirm gate: the TextInput is unmounted while pending, so Enter/Esc arrive here only.
    if (phase === 'input' && pendingIdea !== null) {
      if (key.return) {
        const text = pendingIdea;
        setPendingIdea(null);
        startIdea(text);
      } else if (key.escape) {
        setPendingIdea(null);
        setRouterMessage('cancelled — nothing was run.');
      }
      return;
    }
    // V10: Esc on the home screen clears everything typed/shown — universal "get me out" key.
    if (phase === 'input' && key.escape) {
      setIdea('');
      setPanel(null);
      setRouterMessage('');
      setSel(0);
      return;
    }
    // V10 palette keys: ↑/↓ move the highlight, Tab completes into the box. (Enter submits via TextInput.)
    if (phase === 'input' && paletteMatches.length > 0) {
      if (key.upArrow) return void setSel((selIdx - 1 + paletteMatches.length) % paletteMatches.length);
      if (key.downArrow) return void setSel((selIdx + 1) % paletteMatches.length);
      if (key.tab) {
        setIdea(`/${paletteMatches[selIdx]!.name} `);
        setSel(0);
        setInputEpoch((e) => e + 1); // remount the input → cursor lands after "/command " ready to type
        return;
      }
    }
    // Clarify key handling — the "type your own" sub-mode lets TextInput capture keys instead.
    if (phase === 'clarify' && clarify && !clarifyTyping) {
      const n = Number.parseInt(input, 10);
      const N = clarify.options.length;
      if (!Number.isNaN(n)) {
        if (n >= 1 && n <= N) clarify.resolve({ kind: 'pick', index: n - 1 });
        else if (n === N + 1) clarify.resolve({ kind: 'both' });
        else if (n === N + 2) setClarifyTyping(true);
      }
      return;
    }
    if (phase === 'finished') exit();
  });

  const startRun = (wf: WorkflowId, text: string, cwd: string | null, runner: WorkflowRunner, stages: typeof IDEA_STAGES, replay?: Map<string, string>): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPanel(null);
    const available = handles.map((h) => h.id);
    const rs = resolveRoles(wf, available, roleOverrides);
    const runId = makeRunId(wf);
    const writer = new RunWriter(runId, runsRoot);
    const controller = new AbortController();
    abortRef.current = controller;
    const events: RunEvents = {
      onStageStart: (id) => setRows((r) => markStart(r, id, Date.now())),
      onStageEnd: (id, st) => setRows((r) => markEnd(r, id, st, Date.now())),
      clarify: (question, options) =>
        new Promise<ClarifyChoice>((res) => {
          setClarify({
            question,
            options,
            resolve: (c) => {
              setClarify(null);
              setClarifyTyping(false);
              setClarifyText('');
              setPhase('running');
              res(c);
            },
          });
          setPhase('clarify');
        }),
    };
    const ctx = new RunCtx({ runId, workflow: wf, handles, roles: rs, writer, cwd: cwd ?? writer.dir, budget: budgetOverride, signal: controller.signal, events, replay });
    ctxRef.current = ctx;
    setWorkflow(wf);
    setRows(initTimeline(stages, rs, available));
    setBudget(ctx.budget.limit);
    setDir(writer.dir);
    setCompletion(null);
    setCouncilView(null);
    setErrorView(null);
    setRouterMessage('');
    setPhase('running');
    void recordSession({ id: runId, workflow: wf, cwd: cwd ?? writer.dir, runsRoot: resolve(dirname(dirname(writer.dir))), startedAt: new Date().toISOString(), status: 'running' });
    void executeRun(ctx, trimmed, runner).then(async (o) => {
      const wasAborted = ctx.aborted;
      setAborted(wasAborted);
      void updateSessionStatus(o.runId, wasAborted ? 'aborted' : o.ok ? 'ok' : 'failed');
      if (o.ok) {
        setCouncilView(await loadCouncilView(o.runId, o.dir));
        setCompletion(wf === 'idea-refinement' ? await loadCompletion(o.dir) : null);
      }
      else if (!wasAborted) setErrorView(formatError(o.error?.code ?? 'CRASH', o.dir || undefined));
      setPhase('finished');
    });
  };

  const startIdea = (text: string): void => startRun('idea-refinement', text, null, runIdeaRefinement, IDEA_STAGES);

  const startCodeReview = async (action: QuickAction): Promise<void> => {
    if (!repo || !repo.defaultBranch) {
      setRouterMessage('code review needs a git repo with a detectable default branch');
      return;
    }
    try {
      const diff = action === 'review-working-tree'
        ? await computeWorkingTreeDiff(repo.defaultBranch, repo.root)
        : await computeDiff(repo.defaultBranch, 'HEAD', repo.root);
      if (!diff.trim()) {
        setRouterMessage('no changes to review');
        return;
      }
      startRun('code-review', diff, repo.root, runCodeReview, CR_STAGES);
    } catch (e) {
      setRouterMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const sessionsPanel = async (lead?: string): Promise<string> => {
    const all = (await readSessions()).slice(0, 12);
    if (!all.length) return 'no sessions yet.';
    const mark = { running: '●', ok: '✔', failed: '✖', aborted: '⊘' } as const;
    const rows = all.map((s) => `  ${mark[s.status]} ${s.id}  ${s.workflow}${s.status === 'failed' || s.status === 'aborted' ? '   /resume ' + s.id : ''}`);
    return [lead ?? 'Recent sessions:', ...rows].join('\n');
  };
  const configPanel = async (): Promise<string> => {
    try {
      return 'Effective config:\n' + JSON.stringify(effectiveConfig(await loadLayeredConfig()), null, 2);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const helpPanel = (): string =>
    [
      'aiki — a local council of your installed AI CLIs (Claude, Codex, Gemini).',
      'It stress-tests ideas and reviews code by making the models cross-examine',
      'each other; a judge settles disputes. Artifacts land in .aiki/runs/.',
      '',
      'Commands:',
      ...COMMANDS.map((c) => `  ${c.usage.padEnd(20)} ${c.help}`),
      '',
      'Examples:',
      '  /idea a fridge-to-recipe app for students',
      '  /review --branch          review this branch vs the default branch',
      '  /resume 20260707-1645     continue a stopped run (finished calls replay free)',
      '',
      'Plain text works too — it routes to the idea flow, with a confirm step',
      'so nothing spends model calls until you say so.',
    ].join('\n');

  const resumeInTui = async (idArg?: string): Promise<void> => {
    if (!idArg) return void setPanel(await sessionsPanel('Resume which? type /resume <id>'));
    const sess = await findSession(idArg);
    if (!sess) return void setRouterMessage(`no session matches "${idArg}" — see /sessions`);
    if ('ambiguous' in sess) return void setRouterMessage(`"${idArg}" is ambiguous: ${sess.ambiguous.join(', ')}`);
    const wf = sess.workflow as WorkflowId;
    const oldDir = join(sess.runsRoot, 'runs', sess.id);
    let input: string;
    try {
      input = await readFile(join(oldDir, 'inputs', wf === 'code-review' ? 'diff.patch' : 'idea.md'), 'utf8');
    } catch {
      return void setRouterMessage(`can't recover the input for ${sess.id} — nothing to resume`);
    }
    const replay = await buildReplayCache(oldDir);
    if (replay.size === 0) return void setRouterMessage(`no completed calls for ${sess.id} — start fresh`);
    const [runner, stages] = wf === 'code-review' ? ([runCodeReview, CR_STAGES] as const) : ([runIdeaRefinement, IDEA_STAGES] as const);
    startRun(wf, input, wf === 'code-review' ? sess.cwd : null, runner, stages, replay);
  };

  const runCommand = async (p: ParsedCommand): Promise<void> => {
    setRouterMessage('');
    setPanel(null);
    switch (p.cmd) {
      case 'idea':
        if (p.rest) startIdea(p.rest);
        else setRouterMessage('type your idea after the command, e.g.  /idea a fridge-to-recipe app');
        return;
      case 'review':
        void startCodeReview(p.args.includes('--branch') || p.args.includes('-b') ? 'review-branch' : 'review-working-tree');
        return;
      case 'resume':
        void resumeInTui(p.args[0]);
        return;
      case 'sessions':
        setPanel('loading…'); setPanel(await sessionsPanel()); return;
      case 'models':
        setPanel('loading models…'); setPanel(await formatModels()); return;
      case 'config':
        setPanel(await configPanel()); return;
      case 'help': case '':
        setPanel(helpPanel()); return;
      default: {
        const near = suggestCommand(p.cmd);
        setRouterMessage(`unknown command /${p.cmd}${near ? ` — did you mean /${near}?` : ' — type /help'}`);
      }
    }
  };

  const submitInput = (text: string): void => {
    const parsed = parseCommand(text);
    if (parsed) {
      // V10: Enter with the palette open runs the HIGHLIGHTED command when the typed word isn't
      // itself a known command (so "/mo" ⏎ runs /models; "/review" ⏎ still runs review exactly).
      const known = COMMANDS.some((c) => c.name === parsed.cmd);
      setIdea('');
      setSel(0);
      if (!known && !parsed.rest && paletteMatches.length > 0) {
        void runCommand({ cmd: paletteMatches[selIdx]!.name, rest: '', args: [] });
        return;
      }
      void runCommand(parsed);
      return;
    }

    setPanel(null);
    const route = routeInput(text);
    if (route === 'question') {
      setIdea('');
      setRouterMessage(`${PRODUCT_LINE} Type /idea if you meant an idea.`);
      return;
    }
    if (route === 'code-review') {
      setIdea('');
      setRouterMessage(repo ? 'That looks code-related. Type /review (working tree) or /review --branch.' : 'That looks code-related. Open aiki inside a git repo, then /review.');
      return;
    }
    // V10 confirm gate: plain text never starts a paid run directly — show what will happen first.
    setIdea('');
    setRouterMessage('');
    setPendingIdea(text);
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold color="cyan">aiki</Text>
        {version ? <Text dimColor> v{version}</Text> : null}
        <Text dimColor> · {phase === 'input' ? 'local model council — ideas & code review' : workflow}</Text>
      </Text>

      {phase === 'detecting' && (
        <Text>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>{' '}
          detecting providers…
        </Text>
      )}

      {(phase === 'input' || phase === 'running' || phase === 'clarify' || phase === 'finished') && handles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {repo && (
            <Text>
              repo: {repo.name} — {repo.changedFiles} changed files vs {repo.defaultBranch ?? 'unknown default branch'}
            </Text>
          )}
          <Text>
            {handles.map((h, i) => (
              <Text key={h.id}>
                {i > 0 ? <Text dimColor> · </Text> : null}
                <Text color="green">✔</Text> {DISPLAY_NAME[h.id]}
                {h.version ? <Text dimColor> {h.version}</Text> : null}
              </Text>
            ))}
            <Text dimColor> — council ready</Text>
          </Text>
        </Box>
      )}

      {phase === 'input' && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color="cyan">/idea </Text>
              <Text dimColor>{'<text>'}</Text>
              {'   stress-test an idea'}
            </Text>
            <Text>
              <Text color="cyan">/review </Text>
              <Text dimColor>[--branch]</Text>
              {'  review your changes'}
              {repo ? '' : <Text dimColor>  (needs a git repo)</Text>}
            </Text>
            <Text>
              <Text color="cyan">/resume </Text>
              <Text dimColor>{'<id>'}</Text>
              {'   continue a stopped run  ·  '}
              <Text color="cyan">/sessions</Text>
              {'  '}
              <Text color="cyan">/models</Text>
              {'  '}
              <Text color="cyan">/config</Text>
              {'  '}
              <Text color="cyan">/help</Text>
            </Text>
          </Box>
          {pendingIdea !== null ? (
            /* V10 confirm gate — nothing spends model calls until Enter. */
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text>Run the idea council on:</Text>
              <Text color="cyan">  “{pendingIdea.length > 100 ? `${pendingIdea.slice(0, 97)}…` : pendingIdea}”</Text>
              <Text dimColor>  10-stage pipeline · up to {budgetOverride ?? DEFAULT_BUDGET} model calls · Ctrl+C aborts mid-run</Text>
              <Text>
                <Text color="green">enter</Text> run  ·  <Text color="yellow">esc</Text> cancel
              </Text>
            </Box>
          ) : (
            <>
              <Text dimColor>Type a command, or just describe your idea and press Enter:</Text>
              <Box borderStyle="round" paddingX={1}>
                <Text>▸ </Text>
                {/* Single-line input: collapse pasted newlines to spaces (multi-line paste) and strip tabs (Tab = palette-complete). */}
                <TextInput key={inputEpoch} value={idea} onChange={(v) => setIdea(v.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ''))} onSubmit={submitInput} />
              </Box>
            </>
          )}
          {paletteMatches.length > 0 && (
            /* V10 live command palette — filtered as you type; ↑↓ move, Tab completes, Enter runs. */
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {paletteMatches.map((m, i) => (
                <Text key={m.name}>
                  <Text color={i === selIdx ? 'cyan' : undefined} bold={i === selIdx}>
                    {i === selIdx ? '▸ ' : '  '}
                    /{m.name}
                  </Text>
                  <Text dimColor>{`  ${m.usage.replace(`/${m.name}`, '').trim().padEnd(10)}  ${m.help}`}</Text>
                </Text>
              ))}
              <Text dimColor>↑↓ select · tab complete · enter run</Text>
            </Box>
          )}
          {routerMessage ? <Text color="yellow">{routerMessage}</Text> : null}
          {panel ? (
            <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
              {panel.split('\n').map((l, i) => (
                <Text key={i}>{l}</Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>new here? /help explains how aiki works · long idea? `aiki run idea-refinement ./idea.md`</Text>
          )}
        </Box>
      )}

      {(phase === 'running' || phase === 'clarify' || phase === 'finished') && rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((r) => {
            const color = r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'running' ? 'yellow' : 'gray';
            return (
              <Text key={r.id}>
                {r.status === 'running' ? (
                  <Text color="yellow">
                    <Spinner type="dots" />
                  </Text>
                ) : (
                  <Text color={color}>{GLYPH[r.status]}</Text>
                )}{' '}
                {r.id.padEnd(3)} {r.label.padEnd(24)}
                <Text dimColor>{displayNames(r.providers) || '—'}</Text> {'  '}{elapsedLabel(r, now)}
              </Text>
            );
          })}
          {phase === 'running' &&
            (() => {
              const running = rows.find((r) => r.status === 'running');
              const p = progressBar(rows);
              const secs = running?.startedAt !== undefined ? Math.floor((now - running.startedAt) / 1000) : 0;
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color="cyan">{p.bar}</Text>
                    <Text dimColor> {p.done}/{p.total}</Text>
                    {running ? <Text color="yellow">  {runningPhrase(running.id, secs)}…</Text> : null}
                  </Text>
                  <Text dimColor>calls used {ctxRef.current?.calls.length ?? 0}/{budget} · Ctrl+C aborts (artifacts kept)</Text>
                </Box>
              );
            })()}
        </Box>
      )}

      {phase === 'clarify' && clarify && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{clarify.question}</Text>
          {clarify.options.map((o, i) => (
            <Text key={i}>
              {'  '}
              <Text color="cyan">{i + 1}</Text>. {o}
            </Text>
          ))}
          <Text>
            {'  '}
            <Text color="cyan">{clarify.options.length + 1}</Text>. {clarify.options.length === 2 ? 'both readings — combine them' : 'all readings — combine them'}
          </Text>
          <Text>
            {'  '}
            <Text color="cyan">{clarify.options.length + 2}</Text>. other — type your own
          </Text>
          {clarifyTyping ? (
            <Box borderStyle="round" paddingX={1} marginTop={1}>
              <Text>▸ </Text>
              <TextInput
                value={clarifyText}
                onChange={(v) => setClarifyText(v.replace(/\s*[\r\n]+\s*/g, ' '))}
                onSubmit={() => clarifyText.trim() && clarify.resolve({ kind: 'text', text: clarifyText })}
              />
            </Box>
          ) : (
            <Text dimColor>press 1–{clarify.options.length + 2} to choose</Text>
          )}
        </Box>
      )}

      {phase === 'finished' && (
        <Box flexDirection="column" marginTop={1}>
          {aborted && (
            <Box flexDirection="column">
              <Text color="yellow">⊘ Run aborted — partial artifacts at {dir}</Text>
              <Text dimColor>  finished calls replay free: aiki resume {basename(dir)}</Text>
            </Box>
          )}
          {!aborted && errorView && (
            <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
              <Text color="red" bold>
                ✖ Run failed [{errorView.code}]
              </Text>
              <Text>{errorView.fix}</Text>
              {errorView.partialDir ? <Text dimColor>partial artifacts: {errorView.partialDir}</Text> : null}
            </Box>
          )}
          {!aborted && !errorView && councilView && (
            <Box flexDirection="column">
              <Text>
                <Text color="green" bold>✔ Run complete</Text>
                {totalElapsed(rows) ? <Text dimColor> · council adjourned in {totalElapsed(rows)}</Text> : null}
              </Text>
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Verdict</Text>
                <Text>{councilView.verdict}</Text>
                <Text dimColor>{councilView.calls} · {councilView.stats.join(' · ')}</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Providers</Text>
                {councilView.columns.map((c) => (
                  <Text key={c.provider}>{c.title}: {c.lines[0] ?? 'no role output recorded'}</Text>
                ))}
              </Box>
              {councilView.rows.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>Council map</Text>
                  {councilView.rows.slice(0, 5).map((r, i) => (
                    <Text key={i}>
                      {r.kind.toUpperCase()} · {r.title}{r.ruling ? ` · judge: ${r.ruling}` : ''}
                    </Text>
                  ))}
                </Box>
              )}
              <Text dimColor>{'\n'}report: {dir}/final-report.md</Text>
              <Text dimColor>html: aiki show {councilView.runId} --html</Text>
            </Box>
          )}
          {!aborted && !errorView && !councilView && (
            <Box flexDirection="column">
              <Text>
                <Text color="green" bold>✔ Run complete</Text>
                {totalElapsed(rows) ? <Text dimColor> · council adjourned in {totalElapsed(rows)}</Text> : null}
              </Text>
              {completion ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>Verdict</Text>
                  <Text>{completion.verdict}</Text>
                  {completion.disagreements.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text bold>Top disagreements</Text>
                      {completion.disagreements.map((d, i) => (
                        <Text key={i}>{'  '}{d}</Text>
                      ))}
                    </Box>
                  )}
                  <Text dimColor>{'\n'}report: {completion.reportPath}</Text>
                </Box>
              ) : (
                <Text dimColor>artifacts: {dir}</Text>
              )}
            </Box>
          )}
          <Text dimColor>{'\n'}press any key to exit</Text>
        </Box>
      )}
    </Box>
  );
}
