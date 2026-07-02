import { describe, it, expect } from 'vitest';
import {
  DisagreementMap,
  IntentContract,
  Interpretation,
  JudgeReport,
  RoleOutput,
  RunMeta,
  VerificationSet,
} from '../src/schemas/index.js';

describe('IntentContract', () => {
  const valid = {
    task: 'Refine the pitch for a local-first orchestration CLI.',
    task_type: 'idea-refinement' as const,
    constraints: ['no cloud'],
    unknowns: ['target user'],
    success_criteria: ['clear verdict'],
  };

  it('accepts a valid contract', () => {
    expect(IntentContract.parse(valid)).toEqual(valid);
  });

  it('rejects unknown keys (strict — anti-slop §11)', () => {
    expect(() => IntentContract.parse({ ...valid, answer: 'oops' })).toThrow();
  });

  it('rejects an invalid task_type', () => {
    expect(() => IntentContract.parse({ ...valid, task_type: 'refactor' })).toThrow();
  });
});

describe('Interpretation', () => {
  it('accepts up to 2 misreadings', () => {
    const v = { my_interpretation: 'x', plausible_misreadings: ['a', 'b'] };
    expect(Interpretation.parse(v)).toEqual(v);
  });

  it('rejects more than 2 misreadings (top-2 cap §13)', () => {
    expect(() => Interpretation.parse({ my_interpretation: 'x', plausible_misreadings: ['a', 'b', 'c'] })).toThrow();
  });
});

describe('RoleOutput (workflow-discriminated union)', () => {
  const idea = {
    workflow: 'idea-refinement' as const,
    task_echo: 'restate',
    strongest_version: 'best version',
    assumptions: [{ id: 'A1', statement: 's', type: 'VERIFIABLE' as const, load_bearing: true }],
    attacks: [{ id: 'X1', target_assumption: 'A1', argument: 'a', severity: 'HIGH' as const }],
    open_questions: ['q?'],
  };

  it('routes to the idea-refinement member', () => {
    expect(RoleOutput.parse(idea)).toMatchObject({ workflow: 'idea-refinement' });
  });

  it('rejects >8 assumptions (cap §12.1)', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `A${i}`,
      statement: 's',
      type: 'JUDGMENT' as const,
      load_bearing: false,
    }));
    expect(() => RoleOutput.parse({ ...idea, assumptions: many })).toThrow();
  });

  it('routes to the code-review member and enforces self_confidence range', () => {
    const finding = {
      id: 'F1',
      file: 'src/a.ts',
      line_start: 10,
      line_end: 12,
      severity: 'P0' as const,
      category: 'SECURITY' as const,
      claim: 'auth gap',
      evidence: 'no check',
      suggested_fix: 'add check',
      self_confidence: 0.9,
    };
    const cr = { workflow: 'code-review' as const, task_echo: 'restate', findings: [finding] };
    expect(RoleOutput.parse(cr)).toMatchObject({ workflow: 'code-review' });
    expect(() => RoleOutput.parse({ ...cr, findings: [{ ...finding, self_confidence: 2 }] })).toThrow();
  });
});

describe('VerificationSet', () => {
  it('accepts verifications', () => {
    const v = { verifications: [{ target_id: 'F1', verdict: 'REFUTE' as const, evidence: 'e', note: '' }] };
    expect(VerificationSet.parse(v)).toEqual(v);
  });

  it('rejects a bad verdict', () => {
    expect(() =>
      VerificationSet.parse({ verifications: [{ target_id: 'F1', verdict: 'MAYBE', evidence: 'e', note: '' }] }),
    ).toThrow();
  });
});

describe('DisagreementMap', () => {
  it('accepts the four buckets', () => {
    const dm = {
      consensus: [{ id: 'C1', statement: 's', type: 'VERIFIABLE' as const, providers: ['claude' as const, 'codex' as const] }],
      contradictions: [{ claim_ids: ['C2', 'C3'] }],
      unique: [],
      blind_spots: ['kill criteria'],
    };
    expect(DisagreementMap.parse(dm)).toMatchObject({ blind_spots: ['kill criteria'] });
  });

  it('rejects a contradiction referencing <2 claims', () => {
    expect(() =>
      DisagreementMap.parse({ consensus: [], contradictions: [{ claim_ids: ['C1'] }], unique: [], blind_spots: [] }),
    ).toThrow();
  });
});

describe('JudgeReport', () => {
  const valid = {
    adjudications: [{ id: 'F1', ruling: 'UPHOLD' as const, reasoning: 'r', evidence_cited: 'e' }],
    verdict: 'ship it',
    dissent: ['it might not scale'],
    confidence_notes: 'HIGH on F1',
  };

  it('accepts a valid report', () => {
    expect(JudgeReport.parse(valid)).toEqual(valid);
  });

  it('rejects empty dissent (§9 mandatory non-empty)', () => {
    expect(() => JudgeReport.parse({ ...valid, dissent: [] })).toThrow();
  });
});

describe('RunMeta', () => {
  it('accepts a finalized meta', () => {
    const meta = {
      run_id: '20260702-1412-idea-refinement-a3f9',
      workflow: 'idea-refinement' as const,
      provider_versions: { claude: '2.1.198', codex: '0.135.0', agy: '1.0.15' },
      flag_profiles: {
        claude: { id: 'claude' as const, jsonOutput: true, readOnlyFlag: 'plan' as const },
      },
      roles: { judge: 'claude' as const, analyst: 'agy' as const },
      read_only: { claude: 'plan' as const, codex: 'sandbox' as const, agy: 'sandbox' as const },
      calls: [{ provider: 'claude' as const, stage: 'S9', durationMs: 4200 }],
      call_count: 1,
      budget: { limit: 9, used: 1 },
      exit_status: 'ok' as const,
      aborted: false,
    };
    expect(RunMeta.parse(meta)).toMatchObject({ exit_status: 'ok' });
  });
});
