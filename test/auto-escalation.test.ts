import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canProduceNewInformation,
  structuralEscalationGates,
} from '../src/orchestration/auto-profile.js';
import type { DecisionGraph } from '../src/orchestration/decision-graph.js';
import { RunCtx, type ProviderHandle } from '../src/orchestration/context.js';
import {
  overlayChallengeDeltas,
  s4bChallenge,
} from '../src/orchestration/stages/s4b-challenge.js';
import type { Adapter, ProviderId, RunResultAdapter } from '../src/providers/types.js';
import { ChallengeDelta } from '../src/schemas/index.js';
import { RunWriter } from '../src/storage/runs.js';

function graph(): DecisionGraph {
  const position = (
    id: string,
    proposition: string,
    ifFalse: 'STOP' | 'PIVOT' | 'CONDITION' | 'MINOR',
    evidenceIds: string[] = [],
  ): DecisionGraph['positions'][number] => ({
    id: `claude/${id}`,
    local_id: id,
    proposition,
    dimension_id: 'R1',
    stance: 'SUPPORT',
    basis: evidenceIds.length ? 'EVIDENCE' : 'ASSUMPTION',
    nature: 'FACTUAL',
    load_bearing: ifFalse !== 'MINOR',
    if_false: ifFalse,
    reasoning: proposition,
    evidence_ids: evidenceIds,
    depends_on: [],
    provider: 'claude',
    source_id: 'claude',
  });
  const positions = [
    position('P1', 'An unsupported decisive claim.', 'STOP'),
    position('P2', 'A pivot rests on model memory.', 'PIVOT', ['E2']),
    position('P3', 'A deterministic calculation is wrong.', 'CONDITION', ['E3']),
    position('P4', 'The supplied source supports this claim.', 'CONDITION', ['E4']),
    position('P5', 'Two seats disagree on this dependency.', 'CONDITION', ['E5']),
    position('P6', 'An isolated minor claim.', 'MINOR'),
  ];
  const claim = (
    id: string,
    index: number,
    state: DecisionGraph['claims'][number]['state'],
    evidenceState: DecisionGraph['claims'][number]['evidence_state'],
    sensitivity: DecisionGraph['claims'][number]['sensitivity'],
  ): DecisionGraph['claims'][number] => ({
    id,
    proposition: positions[index]!.proposition,
    position_ids: [positions[index]!.id],
    state,
    evidence_state: evidenceState,
    nature: 'FACTUAL',
    load_bearing: positions[index]!.load_bearing,
    if_false: positions[index]!.if_false,
    sensitivity,
  });
  return {
    positions,
    evidence: [
      {
        id: 'claude/E2', claim_supported: positions[1]!.proposition, source_kind: 'MODEL_KNOWLEDGE',
        support: 'SUPPORTS', freshness: 'UNKNOWN', provider: 'claude', source_id: 'claude',
      },
      {
        id: 'claude/E3', claim_supported: positions[2]!.proposition, source_kind: 'PRIMARY',
        support: 'SUPPORTS', freshness: 'CURRENT', locator: 'calculation source', provider: 'claude', source_id: 'claude',
      },
      {
        id: 'claude/E4', claim_supported: positions[3]!.proposition, source_kind: 'USER',
        support: 'CONTRADICTS', freshness: 'CURRENT', locator: 'user evidence', provider: 'claude', source_id: 'claude',
      },
      {
        id: 'claude/E5', claim_supported: positions[4]!.proposition, source_kind: 'PRIMARY',
        support: 'SUPPORTS', freshness: 'CURRENT', locator: 'primary source', provider: 'claude', source_id: 'claude',
      },
    ],
    calculations: [],
    calculation_checks: [{ calculation_id: 'claude/C1', claim_id: 'G3', status: 'FAIL', issues: ['2 + 2 != 5'] }],
    claims: [
      claim('G1', 0, 'UNCERTAIN', 'UNVERIFIED', 'DECISIVE'),
      claim('G2', 1, 'UNCERTAIN', 'UNVERIFIED', 'DECISIVE'),
      claim('G3', 2, 'UNCERTAIN', 'UNVERIFIED', 'MATERIAL'),
      claim('G4', 3, 'UNCERTAIN', 'CONFLICTED', 'MATERIAL'),
      claim('G5', 4, 'DISAGREEMENT', 'SUPPORTED', 'MATERIAL'),
      claim('G6', 5, 'UNIQUE', 'UNVERIFIED', 'LOW'),
    ],
    edges: [
      { from: 'claude/E2', to: 'G2', type: 'SUPPORTS' },
      { from: 'claude/E3', to: 'G3', type: 'SUPPORTS' },
      { from: 'claude/E4', to: 'G4', type: 'ATTACKS' },
      { from: 'claude/E5', to: 'G5', type: 'SUPPORTS' },
      { from: 'G5', to: 'G6', type: 'DEPENDS_ON' },
    ],
    holes: { coverage: [], evidence: [] },
  };
}

describe('Phase D structural escalation gates', () => {
  it('selects the five hard gates in stable order and ignores an isolated minor claim', () => {
    expect(structuralEscalationGates(graph())).toEqual([
      { claimId: 'G1', kind: 'NO_INDEPENDENT_EVIDENCE', reason: 'decisive claim has no independent evidence' },
      { claimId: 'G2', kind: 'NO_INDEPENDENT_EVIDENCE', reason: 'decisive claim has no independent evidence' },
      { claimId: 'G2', kind: 'MODEL_KNOWLEDGE_DECISION', reason: 'STOP/PIVOT claim rests on model knowledge' },
      { claimId: 'G3', kind: 'FAILED_CALCULATION', reason: 'deterministic calculation failed' },
      { claimId: 'G4', kind: 'SUPPLIED_SOURCE_CONTRADICTION', reason: 'user-supplied evidence contradicts a load-bearing claim' },
      { claimId: 'G5', kind: 'LOAD_BEARING_DISAGREEMENT', reason: 'load-bearing claims are mutually inconsistent' },
    ]);
  });

  it('challenges only when evidence, a failed calculation, or a dependency can add information', () => {
    const value = graph();
    expect(canProduceNewInformation(value, 'G1')).toBe(false);
    expect(canProduceNewInformation(value, 'G3')).toBe(true);
    expect(canProduceNewInformation(value, 'G4')).toBe(true);
    expect(canProduceNewInformation(value, 'G5')).toBe(true);
    expect(canProduceNewInformation(value, 'G404')).toBe(false);
  });
});

describe('Phase D challenge boundary', () => {
  const delta = {
    claimId: 'G3',
    response: 'COUNTER',
    reasoning: 'The deterministic check refutes the stated result.',
    newEvidenceIds: ['claude/E3'],
    changedDecisionImpact: 'Treat the condition as unresolved.',
  };

  it('accepts only the exact ChallengeDelta contract', () => {
    expect(ChallengeDelta.parse(delta)).toEqual(delta);
    expect(ChallengeDelta.safeParse({ ...delta, response: 'CONCEDE' }).success).toBe(false);
    expect(ChallengeDelta.safeParse({ ...delta, extra: true }).success).toBe(false);
  });
});

describe('Phase D targeted challenger', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiki-auto-challenge-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function handle(id: ProviderId, prompts: string[]): ProviderHandle {
    const adapter: Adapter = {
      id,
      run: async (request): Promise<RunResultAdapter> => {
        prompts.push(request.prompt);
        const value = {
          deltas: [
            {
              claimId: 'G3', response: 'COUNTER',
              reasoning: 'The failed deterministic check refutes the numeric proposition.',
              newEvidenceIds: ['E2'], changedDecisionImpact: 'Do not rely on this condition.',
            },
            {
              claimId: 'G4', response: 'UNRESOLVED',
              reasoning: 'The supplied evidence contradicts the proposition.',
              newEvidenceIds: ['E3'], changedDecisionImpact: 'Keep this condition unresolved.',
            },
          ],
        };
        return { ok: true, text: JSON.stringify(value), json: value, durationMs: 1 };
      },
    };
    return {
      id,
      adapter,
      flags: { id, jsonOutput: true, readOnlyFlag: id === 'claude' ? 'plan' : 'sandbox' },
      readOnly: id === 'claude' ? 'plan' : 'sandbox',
      version: 'test',
    };
  }

  function context(prompts: string[]): RunCtx {
    const writer = new RunWriter('20260719-1200-idea-refinement-delta', root);
    return new RunCtx({
      runId: writer.runId,
      workflow: 'idea-refinement',
      mode: 'quick',
      handles: [handle('claude', prompts), handle('codex', prompts)],
      roles: { analyst: 'claude', judge: 'claude', verifier: 'codex', s4: ['codex'] },
      writer,
      cwd: writer.dir,
      budget: 4,
    });
  }

  it('groups targeted claims into one call and excludes the full task and unselected claims', async () => {
    const prompts: string[] = [];
    const run = context(prompts);
    const value = graph();
    const gates = structuralEscalationGates(value).filter((gate) => gate.claimId === 'G3' || gate.claimId === 'G4');

    const result = await s4bChallenge(run, value, gates, 'claude');

    expect(run.budget.used).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('A deterministic calculation is wrong.');
    expect(prompts[0]).toContain('The supplied source supports this claim.');
    expect(prompts[0]).not.toContain('An isolated minor claim.');
    expect(prompts[0]).not.toMatch(/TASK CONTRACT|INPUT DOCUMENT|TWO-VIEW PREFLIGHT/);
    expect(result.deltas.map((delta) => delta.newEvidenceIds)).toEqual([['claude/E3'], ['claude/E4']]);

    const stored = JSON.parse(await readFile(join(run.writer.dir, '04b-challenge-deltas.json'), 'utf8'));
    expect(stored).toEqual(result);
  });

  it('spends no call when the graph cannot add information', async () => {
    const prompts: string[] = [];
    const run = context(prompts);
    const value = graph();
    const gates = structuralEscalationGates(value).filter((gate) => gate.claimId === 'G1');

    expect(await s4bChallenge(run, value, gates, 'claude')).toEqual({ deltas: [] });
    expect(run.budget.used).toBe(0);
    expect(prompts).toEqual([]);
  });

  it('overlays target states without mutating the source graph', () => {
    const value = graph();
    const overlaid = overlayChallengeDeltas(value, [
      { claimId: 'G3', response: 'COUNTER', reasoning: 'Counter.', newEvidenceIds: [], changedDecisionImpact: 'Changed.' },
      { claimId: 'G6', response: 'CONFIRM', reasoning: 'Confirmed.', newEvidenceIds: [], changedDecisionImpact: 'Stable.' },
    ]);

    expect(overlaid.claims.find((claim) => claim.id === 'G3')?.state).toBe('DISAGREEMENT');
    expect(overlaid.claims.find((claim) => claim.id === 'G6')?.state).toBe('CONSENSUS');
    expect(value.claims.find((claim) => claim.id === 'G3')?.state).toBe('UNCERTAIN');
    expect(value.claims.find((claim) => claim.id === 'G6')?.state).toBe('UNIQUE');
  });
});
