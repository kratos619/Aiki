import { describe, it, expect } from 'vitest';
import {
  ActionPlan,
  DisagreementMap,
  RunBrief,
  RunBriefDraft,
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

describe('RunBrief preflight', () => {
  const draft = {
    subject: 'local multi-model orchestration CLI',
    decision_frame: 'decide whether this is worth building',
    evaluation_lens: 'developer tool viability',
    target_user: 'developers already paying for multiple AI CLIs',
    constraints: ['no API keys', 'read-only'],
    claims_to_test: ['1.3x bug-catch rate'],
    evidence_supplied: ['held-out benchmark claim'],
    missing_axes: ['pricing'],
    questions: [
      {
        id: 'Q1',
        axis: 'decision_frame' as const,
        question: 'What decision should the council help you make?',
        why_it_matters: 'The verdict depends on whether you want a build/no-build call or positioning feedback.',
        suggested_answers: ['Decide build/no-build', 'Find the biggest risks'],
      },
      {
        id: 'Q2',
        axis: 'target_user' as const,
        question: 'Who should be treated as the first target user?',
        why_it_matters: 'A tool for solo developers is judged differently than a team governance tool.',
        suggested_answers: ['Solo senior developers', 'Small engineering teams'],
      },
      {
        id: 'Q3',
        axis: 'success_bar' as const,
        question: 'What would make this worth pursuing?',
        why_it_matters: 'The judge needs a concrete success bar.',
        suggested_answers: ['Clear wedge and risk plan', 'Evidence it beats one strong model'],
      },
    ],
  };

  it('accepts a strict 3-question draft from the preflight model', () => {
    expect(RunBriefDraft.parse(draft)).toEqual(draft);
  });

  it('rejects fewer than 3 questions and unknown keys', () => {
    expect(() => RunBriefDraft.parse({ ...draft, questions: draft.questions.slice(0, 2) })).toThrow();
    expect(() => RunBriefDraft.parse({ ...draft, extra: true })).toThrow();
  });

  it('accepts the persisted brief only when every question has an answer', () => {
    const answers = draft.questions.map((q) => ({ question_id: q.id, answer: 'Use the supplied prompt.', source: 'user' as const }));
    expect(RunBrief.parse({ ...draft, answers })).toMatchObject({ answers });
    expect(() => RunBrief.parse({ ...draft, answers: answers.slice(0, 2) })).toThrow();
  });
});

describe('RoleOutput (workflow-discriminated union)', () => {
  const idea = {
    workflow: 'idea-refinement' as const,
    task_echo: 'restate',
    strongest_version: 'best version',
    positions: [{
      local_id: 'P1', proposition: 's', dimension_id: 'R1', stance: 'SUPPORT' as const,
      basis: 'EVIDENCE' as const, load_bearing: true, if_false: 'STOP' as const,
      reasoning: 'because', evidence_ids: ['E1'], depends_on: [],
    }],
    evidence: [{
      id: 'E1', claim_supported: 's', source_kind: 'USER' as const,
      support: 'SUPPORTS' as const, freshness: 'CURRENT' as const,
    }],
    coverage: [{ dimension_id: 'R1', status: 'COVERED' as const, position_ids: ['P1'], rationale: 'P1 addresses it.' }],
    decision_questions: [{ id: 'Q1', question: 'q?', claim_ids: ['P1'] }],
  };

  it('routes to the idea-refinement member', () => {
    expect(RoleOutput.parse(idea)).toMatchObject({ workflow: 'idea-refinement' });
  });

  it('rejects position references to missing evidence', () => {
    expect(() => RoleOutput.parse({ ...idea, positions: [{ ...idea.positions[0], evidence_ids: ['E404'] }] })).toThrow();
  });

  it('rejects duplicate local position ids at the stage boundary', () => {
    expect(() => RoleOutput.parse({ ...idea, positions: [...idea.positions, { ...idea.positions[0] }] })).toThrow();
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
      contradictions: [
        { id: 'D1', claim_ids: ['C2'], attacks: [{ provider: 'codex' as const, argument: 'weak', severity: 'HIGH' as const }] },
      ],
      unique: [],
      blind_spots: ['kill criteria'],
    };
    expect(DisagreementMap.parse(dm)).toMatchObject({ blind_spots: ['kill criteria'] });
  });

  it('rejects a contradiction with no attacks (a dispute must carry its conflict content, §9 S8)', () => {
    expect(() =>
      DisagreementMap.parse({
        consensus: [],
        contradictions: [{ id: 'D1', claim_ids: ['C1'], attacks: [] }],
        unique: [],
        blind_spots: [],
      }),
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

  it('requires conditions only for PROCEED_WITH_CONDITIONS', () => {
    expect(JudgeReport.parse({ ...valid, recommendation: 'PROCEED' })).toMatchObject({ recommendation: 'PROCEED' });
    expect(() => JudgeReport.parse({ ...valid, recommendation: 'PROCEED_WITH_CONDITIONS' })).toThrow();
    expect(() => JudgeReport.parse({ ...valid, recommendation: 'STOP', conditions: ['check'] })).toThrow();
    expect(JudgeReport.parse({ ...valid, recommendation: 'PROCEED_WITH_CONDITIONS', conditions: ['check'] })).toMatchObject({ conditions: ['check'] });
  });
});

describe('ActionPlan', () => {
  const valid = {
    actions: [{
      order: 1,
      action: 'Interview 5 target users about the pain.',
      why: 'Validates the load-bearing demand risk.',
      validates: 'D1',
      effort: 'S' as const,
      kill_signal: 'Fewer than 2 users describe the pain unprompted.',
    }],
    sequencing_note: 'Start with demand because it can kill the idea cheapest.',
  };

  it('accepts a valid strict plan', () => {
    expect(ActionPlan.parse(valid)).toEqual(valid);
  });

  it('rejects bad effort, empty actions, too many actions, and unknown keys', () => {
    expect(() => ActionPlan.parse({ ...valid, actions: [] })).toThrow();
    expect(() => ActionPlan.parse({ ...valid, actions: Array.from({ length: 8 }, (_, i) => ({ ...valid.actions[0], order: i + 1 })) })).toThrow();
    expect(() => ActionPlan.parse({ ...valid, actions: [{ ...valid.actions[0], effort: 'XL' }] })).toThrow();
    expect(() => ActionPlan.parse({ ...valid, extra: true })).toThrow();
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
