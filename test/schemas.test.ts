import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ActionPlan,
  DisagreementMap,
  RunBrief,
  RunBriefDraft,
  IntentContract,
  Interpretation,
  IdeaRoleOutputModel,
  JudgeReport,
  ReaderBrief,
  RoleOutput,
  RunMeta,
  salvageIdeaRoleOutputModel,
  VerificationSet,
} from '../src/schemas/index.js';

describe('IntentContract', () => {
  const valid = {
    task: 'Refine the pitch for a local-first orchestration CLI.',
    task_type: 'idea-refinement' as const,
    constraints: ['no cloud'],
    unknowns: ['target user'],
    success_criteria: ['clear verdict'],
    domain_dimensions: [
      { id: 'D1', label: 'provider interoperability', rationale: 'The idea depends on multiple installed CLIs.' },
      { id: 'D2', label: 'workflow adoption', rationale: 'Developers must change review habits.' },
      { id: 'D3', label: 'output comparability', rationale: 'The council must compare unlike provider outputs.' },
    ],
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
    domain_dimensions: [
      { id: 'D1', label: 'provider interoperability', rationale: 'The idea depends on multiple installed CLIs.' },
      { id: 'D2', label: 'workflow adoption', rationale: 'Developers must change review habits.' },
      { id: 'D3', label: 'output comparability', rationale: 'The council must compare unlike provider outputs.' },
    ],
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

  it('allows no redundant questions when supplied evidence resolves the context, but rejects unknown keys', () => {
    expect(RunBriefDraft.parse({ ...draft, questions: [] })).toMatchObject({ questions: [] });
    expect(RunBrief.parse({ ...draft, questions: [], answers: [] })).toMatchObject({ questions: [], answers: [] });
    expect(() => RunBriefDraft.parse({ ...draft, extra: true })).toThrow();
  });

  it('requires 3-5 unique domain-specific dimensions in preflight', () => {
    expect(() => RunBriefDraft.parse({ ...draft, domain_dimensions: draft.domain_dimensions.slice(0, 2) })).toThrow();
    expect(() => RunBriefDraft.parse({
      ...draft,
      domain_dimensions: [...draft.domain_dimensions.slice(0, 2), { ...draft.domain_dimensions[0], label: 'duplicate id' }],
    })).toThrow(/duplicate domain dimension id/);
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

  it('canonicalizes observed provider enum aliases at the model-output boundary', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const parsed = IdeaRoleOutputModel.parse({
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support: 'SUPPORT', freshness: 'current' }],
    });

    expect(parsed.evidence[0]).toMatchObject({ support: 'SUPPORTS', freshness: 'CURRENT' });
    expect(IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support: 'POSITIVE', freshness: 'recent' }],
    }).success).toBe(false);
  });

  it('keeps requested deliverable proposals separate from graph positions and validates their evidence', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const proposal = {
      output: 'FEATURE_BACKLOG',
      title: 'Council replay',
      detail: 'Replay the independent analyses and final ruling as a visual timeline.',
      user_value: 'Makes the multi-model advantage understandable in seconds.',
      why_distinctive: 'Most AI tools hide disagreement inside one answer.',
      evidence_ids: ['E1'],
    };

    expect(IdeaRoleOutputModel.parse({ ...modelOutput, deliverable_proposals: [proposal] }).deliverable_proposals)
      .toEqual([proposal]);
    expect(IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      deliverable_proposals: [{ ...proposal, evidence_ids: ['E404'] }],
    }).success).toBe(false);
    expect(IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      deliverable_proposals: Array.from({ length: 9 }, (_, index) => ({ ...proposal, title: `Feature ${index}` })),
    }).success).toBe(false);
  });

  it('canonicalizes case variants of exact enum words, still rejecting prose', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const parsed = IdeaRoleOutputModel.parse({
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support: 'supports', freshness: 'Current' }],
    });

    expect(parsed.evidence[0]).toMatchObject({ support: 'SUPPORTS', freshness: 'CURRENT' });
    expect(IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support: 'The vendor retains data for two years.' }],
    }).success).toBe(false);
  });

  it('salvage drops still-invalid evidence cards and scrubs their position references', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const broken = {
      ...modelOutput,
      evidence: [
        modelOutput.evidence[0],
        { ...modelOutput.evidence[0], id: 'E2', support: 'Teachers must handle escalations.' },
      ],
      positions: [{ ...modelOutput.positions[0], evidence_ids: ['E1', 'E2'] }],
    };

    expect(IdeaRoleOutputModel.safeParse(broken).success).toBe(false);
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(broken));
    expect(salvaged.evidence.map((card) => card.id)).toEqual(['E1']);
    expect(salvaged.positions[0]!.evidence_ids).toEqual(['E1']);
  });

  it('salvage refuses a seat whose every position is broken — an empty claim set is a hard failure', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const broken = { ...modelOutput, positions: [{ ...modelOutput.positions[0], stance: 'strongly agree' }] };

    expect(IdeaRoleOutputModel.safeParse(salvageIdeaRoleOutputModel(broken)).success).toBe(false);
  });

  it('salvage rescues an evidence card whose only defect is an unknown extra key', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const broken = {
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], content: 'verbatim excerpt the schema never asked for' }],
    };

    expect(IdeaRoleOutputModel.safeParse(broken).success).toBe(false);
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(broken));
    expect(salvaged.evidence).toHaveLength(1);
    expect('content' in salvaged.evidence[0]!).toBe(false);
  });

  it('salvage drops a position with a cross-field enum leak and scrubs every reference to it', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const broken = {
      ...modelOutput,
      positions: [
        modelOutput.positions[0],
        { ...modelOutput.positions[0], local_id: 'P5', basis: 'MODEL_KNOWLEDGE', evidence_ids: [], depends_on: [] },
        { ...modelOutput.positions[0], local_id: 'P6', evidence_ids: [], depends_on: ['P5'] },
      ],
      coverage: [{ dimension_id: 'R1', status: 'COVERED', position_ids: ['P1', 'P5', 'P6'], rationale: 'covered' }],
      decision_questions: [{ id: 'Q1', question: 'q?', claim_ids: ['P5', 'P6'] }],
    };

    expect(IdeaRoleOutputModel.safeParse(broken).success).toBe(false);
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(broken));
    expect(salvaged.positions.map((position) => position.local_id)).toEqual(['P1', 'P6']);
    expect(salvaged.positions[1]!.depends_on).toEqual([]);
    expect(salvaged.coverage[0]!.position_ids).toEqual(['P1', 'P6']);
    expect(salvaged.decision_questions[0]!.claim_ids).toEqual(['P6']);
  });

  it('replays the 20260713-1503 failed Gemini repair: extra-key cards rescued, leaked-enum position dropped', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s4-repair-position-enum-leak.json', import.meta.url), 'utf8'));

    expect(IdeaRoleOutputModel.safeParse(raw).success).toBe(false);
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(raw));
    expect(salvaged.positions).toHaveLength(8); // P5 (basis MODEL_KNOWLEDGE) dropped, the rest survive
    expect(salvaged.positions.some((position) => position.local_id === 'P5')).toBe(false);
    expect(salvaged.evidence).toHaveLength(8); // all cards rescued: enums canonicalized, `content` stripped
    // P6 depended on P2 + P5: only the dropped P5 is scrubbed, the healthy P2 reference survives.
    expect(salvaged.positions.find((position) => position.local_id === 'P6')!.depends_on).toEqual(['P2']);
  });

  it('replays the 20260712-0011 failed Gemini repair: prose cards drop, all positions survive', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s4-repair-prose-enums.json', import.meta.url), 'utf8'));

    expect(IdeaRoleOutputModel.safeParse(raw).success).toBe(false);
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(raw));
    expect(salvaged.positions).toHaveLength(6);
    expect(salvaged.evidence).toHaveLength(0);
    expect(salvaged.positions.every((position) => position.evidence_ids.length === 0)).toBe(true);
  });

  it('canonicalizes a leading stance token with trailing prose (20260714-2142 codex vocabulary)', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const parse = (support: string) => IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support }],
    });

    expect(parse('SUPPORTS: the quote lists exact hardware costs.').data?.evidence[0]?.support).toBe('SUPPORTS');
    expect(parse('OPPOSES: the clinic has no full-time IT staff.').data?.evidence[0]?.support).toBe('CONTRADICTS');
    expect(parse('OPPOSES unconditional retention: the longest outage exceeded tolerance.').data?.evidence[0]?.support).toBe('CONTRADICTS');
    expect(parse('MIXED: achievable but conditional on registration status.').success).toBe(false);
    expect(parse('The vendor retains data for two years.').success).toBe(false);
  });

  it('accepts both documented coverage shapes and a question without an id (20260714-2142 agy shapes)', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const parsed = IdeaRoleOutputModel.parse({
      ...modelOutput,
      coverage: [
        { dimension_id: 'R1', status: 'COVERED', position_ids: ['P1'] },
        { dimension_id: 'R2', status: 'NOT_APPLICABLE', rationale: 'No market dimension in a pure policy decision.' },
      ],
      decision_questions: [{ question: 'How long is the certification queue?', claim_ids: ['P1'] }],
    });

    expect(parsed.coverage[1]?.position_ids).toEqual([]);
    expect(parsed.decision_questions[0]?.id).toBeUndefined();
    expect(IdeaRoleOutputModel.safeParse({
      ...modelOutput,
      coverage: [{ dimension_id: 'R2', status: 'NOT_APPLICABLE' }],
    }).success).toBe(false);
  });

  it('salvage drops a calculation whose position or evidence anchor was dropped', () => {
    const { workflow: _workflow, ...modelOutput } = idea;
    const broken = {
      ...modelOutput,
      evidence: [{ ...modelOutput.evidence[0], support: 'prose that never matches any token' }],
      calculations: [{
        id: 'C1', claim_id: 'P1',
        inputs: [{ id: 'C1I1', name: 'cost', value: 100, unit: 'INR', evidence_ids: ['E1'] }],
        steps: [{ id: 'C1S1', operation: 'MULTIPLY', left: 'C1I1', right: 'C1I1', result: 10000, unit: 'INR' }],
        result_step: 'C1S1',
      }],
    };

    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(broken));
    expect(salvaged.evidence).toHaveLength(0); // E1 dropped → the ledger anchored on it goes too
    expect(salvaged.calculations).toHaveLength(0);
  });

  it('replays the 20260714-2142 failed codex repair: stance vocabulary canonicalized, MIXED card dropped, ledger capped', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s4-repair-support-vocab.json', import.meta.url), 'utf8'));

    expect(IdeaRoleOutputModel.safeParse(raw).success).toBe(false); // MIXED card + 10 calculations
    const salvaged = IdeaRoleOutputModel.parse(salvageIdeaRoleOutputModel(raw));
    expect(salvaged.positions).toHaveLength(12);
    expect(salvaged.evidence).toHaveLength(11); // E6 (MIXED) dropped, stance vocabulary canonicalized
    expect(salvaged.evidence.some((card) => card.id === 'E6')).toBe(false);
    expect(salvaged.calculations).toHaveLength(8); // deterministic cap, order preserved
    expect(salvaged.calculations.map((calc) => calc.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  });

  it('replays the 20260714-2142 failed agy repair: documented coverage/question shapes validate without salvage', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/s4-repair-coverage-shape.json', import.meta.url), 'utf8'));

    const parsed = IdeaRoleOutputModel.parse(raw);
    expect(parsed.positions).toHaveLength(6);
    expect(parsed.coverage).toHaveLength(9);
    expect(parsed.decision_questions).toHaveLength(3);
  });

  it('rejects position references to missing evidence', () => {
    expect(() => RoleOutput.parse({ ...idea, positions: [{ ...idea.positions[0], evidence_ids: ['E404'] }] })).toThrow();
  });

  it('rejects duplicate local position ids at the stage boundary', () => {
    expect(() => RoleOutput.parse({ ...idea, positions: [...idea.positions, { ...idea.positions[0] }] })).toThrow();
  });

  it('rejects NOT_APPLICABLE coverage without a reason', () => {
    expect(() => RoleOutput.parse({
      ...idea,
      coverage: [{ dimension_id: 'R6', status: 'NOT_APPLICABLE', position_ids: [], rationale: '' }],
    })).toThrow();
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
    feature_backlog: {
      must: [{ feature: 'Provider readiness', user_value: 'Shows whether the workflow can run.', rationale: 'Required for the golden path.', effort: 'S' as const }],
      should: [],
      later: [],
      wont: [{ feature: 'General chat', reason: 'Outside the decision workflow.' }],
    },
    implementation_plan: {
      milestones: [{ order: 1, timebox: 'Day 1', outcome: 'Golden path works.', tasks: ['Wire the existing engine.'], acceptance_test: 'Five clean runs.' }],
    },
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

  it('caps the user-facing reader brief and its citations', () => {
    const brief = {
      headline: 'Build the narrow workflow',
      bottom_line: 'Ship the smallest useful council experience first.',
      sections: [
        { heading: 'Direction', summary: 'Make the council visible.', bullets: ['Lead with the decision.'] },
        { heading: 'Delivery', summary: 'Start with replay.', bullets: [] },
      ],
      next_step: 'Build the replay golden path.',
      caveats: ['Live execution still needs a security gate.'],
      source_ids: ['codex/E1'],
    };
    expect(ReaderBrief.parse(brief)).toEqual(brief);
    expect(() => ReaderBrief.parse({ ...brief, sections: [brief.sections[0]] })).toThrow();
    expect(() => ReaderBrief.parse({ ...brief, caveats: ['1', '2', '3', '4'] })).toThrow();
    expect(() => ReaderBrief.parse({ ...brief, source_ids: Array.from({ length: 9 }, (_, i) => `E${i}`) })).toThrow();
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
