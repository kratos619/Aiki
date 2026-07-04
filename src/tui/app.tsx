// The Ink app (T8, §11 screens). Thin/dumb rendering over the pure logic in timeline.ts + format.ts;
// all the engine work goes through the standard primitives (setupProviders → resolveRoles → RunCtx →
// executeRun) with an `events` object wired to React state. Ctrl+C aborts via an AbortController.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DISPLAY_NAME } from '../providers/types.js';
import {
  RunCtx,
  makeRunId,
  resolveRoles,
  setupProviders,
  type ProviderHandle,
  type RoleMap,
  type RunEvents,
} from '../orchestration/context.js';
import { executeRun } from '../orchestration/engine.js';
import { RunWriter } from '../storage/runs.js';
import { IDEA_STAGES, runIdeaRefinement } from '../workflows/idea-refinement.js';
import { GLYPH, displayNames, elapsedLabel, initTimeline, markEnd, markStart, type StageRow } from './timeline.js';
import { formatCompletion, formatError, type CompletionView, type ErrorView } from './format.js';

type Phase = 'detecting' | 'input' | 'running' | 'clarify' | 'finished';

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
}

export function App(props: AppProps): React.JSX.Element {
  const { roleOverrides, budget: budgetOverride } = props;
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('detecting');
  const [handles, setHandles] = useState<ProviderHandle[]>([]);
  const [idea, setIdea] = useState('');
  const [rows, setRows] = useState<StageRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [budget, setBudget] = useState(0);
  const [dir, setDir] = useState('');
  const [clarify, setClarify] = useState<{ question: string; options: string[]; resolve: (n: number) => void } | null>(null);
  const [completion, setCompletion] = useState<CompletionView | null>(null);
  const [errorView, setErrorView] = useState<ErrorView | null>(null);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const ctxRef = useRef<RunCtx | null>(null);

  // Detect providers once, up front.
  useEffect(() => {
    let alive = true;
    void setupProviders().then((hs) => {
      if (!alive) return;
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

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      abortRef.current?.abort();
      if (clarify) clarify.resolve(0); // unblock S2 so the run reaches its abort guard
      if (phase === 'detecting' || phase === 'input' || phase === 'finished') exit();
      return;
    }
    if (phase === 'clarify' && clarify) {
      const n = Number.parseInt(input, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= clarify.options.length) clarify.resolve(n - 1);
      return;
    }
    if (phase === 'finished') exit();
  });

  const start = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const available = handles.map((h) => h.id);
    const rs = resolveRoles('idea-refinement', available, roleOverrides);
    const runId = makeRunId('idea-refinement');
    const writer = new RunWriter(runId);
    const controller = new AbortController();
    abortRef.current = controller;
    const events: RunEvents = {
      onStageStart: (id) => setRows((r) => markStart(r, id, Date.now())),
      onStageEnd: (id, st) => setRows((r) => markEnd(r, id, st, Date.now())),
      clarify: (question, options) =>
        new Promise<number>((res) => {
          setClarify({
            question,
            options,
            resolve: (n) => {
              setClarify(null);
              setPhase('running');
              res(n);
            },
          });
          setPhase('clarify');
        }),
    };
    const ctx = new RunCtx({ runId, workflow: 'idea-refinement', handles, roles: rs, writer, cwd: writer.dir, budget: budgetOverride, signal: controller.signal, events });
    ctxRef.current = ctx;
    setRows(initTimeline(IDEA_STAGES, rs, available));
    setBudget(ctx.budget.limit);
    setDir(writer.dir);
    setPhase('running');
    void executeRun(ctx, trimmed, runIdeaRefinement).then(async (o) => {
      const wasAborted = ctx.aborted;
      setAborted(wasAborted);
      if (o.ok) setCompletion(await loadCompletion(o.dir));
      else if (!wasAborted) setErrorView(formatError(o.error?.code ?? 'CRASH', o.dir || undefined));
      setPhase('finished');
    });
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        aiki · idea-refinement
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
          <Text dimColor>providers ready:</Text>
          {handles.map((h) => (
            <Text key={h.id}>
              {'  '}
              <Text color="green">✔</Text> {DISPLAY_NAME[h.id]} {h.version ? <Text dimColor>{h.version}</Text> : null}
            </Text>
          ))}
        </Box>
      )}

      {phase === 'input' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Describe your idea in one line, then press Enter:</Text>
          <Box borderStyle="round" paddingX={1}>
            {/* Single-line input: collapse pasted newlines to spaces so multi-line paste doesn't corrupt the render. */}
            <TextInput value={idea} onChange={(v) => setIdea(v.replace(/\s*[\r\n]+\s*/g, ' '))} onSubmit={start} />
          </Box>
          <Text dimColor>tip: for a long idea, use `aiki run idea-refinement ./idea.md` instead</Text>
        </Box>
      )}

      {(phase === 'running' || phase === 'clarify' || phase === 'finished') && rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((r) => {
            const color = r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'running' ? 'yellow' : 'gray';
            return (
              <Text key={r.id}>
                <Text color={color}>{GLYPH[r.status]}</Text> {r.id.padEnd(3)} {r.label.padEnd(24)}
                <Text dimColor>{displayNames(r.providers) || '—'}</Text> {'  '}{elapsedLabel(r, now)}
              </Text>
            );
          })}
          {phase === 'running' && (
            <Text dimColor>
              {'\n'}calls used {ctxRef.current?.calls.length ?? 0}/{budget} · Ctrl+C aborts (artifacts kept)
            </Text>
          )}
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
          <Text dimColor>press 1–{clarify.options.length} to choose</Text>
        </Box>
      )}

      {phase === 'finished' && (
        <Box flexDirection="column" marginTop={1}>
          {aborted && (
            <Text color="yellow">⊘ Run aborted — partial artifacts at {dir}</Text>
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
          {!aborted && !errorView && (
            <Box flexDirection="column">
              <Text color="green" bold>
                ✔ Run complete
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
