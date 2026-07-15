// Core shared zod schemas (§14). Single source of truth for every stage-boundary payload.
//
// Design rules honored here:
// - Keep small; every optional field justifies itself (§14).
// - Model-facing outputs are `.strict()`: unknown keys = validation failure → §14 repair retry.
//   This is an anti-slop mechanic (§11): prose/extra fields cannot leak across a stage boundary.
// - Hard list caps come straight from the plan (§12/§13); verbosity cannot impersonate rigor (§11).
// - Internal composites we build ourselves (DisagreementMap, RunMeta) are NOT strict — we own them.
//
// NOT done here (deferred, out of T4 scope): §14's "export zod → skills/*/output.schema.json"
// JSON-Schema generation. It needs a new dep and belongs with the skills system (T5+).

import { z } from 'zod';

// ── Enums shared across schemas ─────────────────────────────────────────────

/** Provider ids (mirrors providers/types.ts PROVIDER_IDS; `agy` = Antigravity/Gemini 3.1 Pro). */
export const ProviderIdSchema = z.enum(['claude', 'codex', 'agy']);

/** What S1 classifies the request as. `other` is a valid contract but not a runnable workflow. */
export const TaskTypeSchema = z.enum(['idea-refinement', 'code-review', 'other']);

/** The two runnable v1 workflows (§12). Discriminates RoleOutput and tags RunMeta. */
export const WorkflowIdSchema = z.enum(['idea-refinement', 'code-review']);

/** Explicit user-selected idea protocol. There is deliberately no learned mode router. */
export const IdeaModeSchema = z.enum(['quick', 'council', 'research']);

export const DomainDimension = z
  .object({
    id: z.string().regex(/^D[1-5]$/),
    label: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

// ── S1: IntentContract (§13) ────────────────────────────────────────────────

export const IntentContract = z
  .object({
    task: z.string().min(1), // one-paragraph normalized restatement
    task_type: TaskTypeSchema,
    constraints: z.array(z.string()), // explicit constraints the user stated (may be empty)
    unknowns: z.array(z.string()), // things the request leaves unspecified
    success_criteria: z.array(z.string()), // what a good final output must contain
    domain_dimensions: z.array(DomainDimension).min(3).max(5).optional(), // required by the idea preflight; optional for old/code-review contracts
  })
  .strict();

/** R6 decision contract: the two-view preflight's single downstream boundary. */
export const DecisionContract = IntentContract.extend({
  alternatives: z.array(z.string().min(1)).max(8),
  success_bar: z.string().min(1),
  evidence_supplied: z.array(z.string().min(1)).max(12),
  missing_evidence: z.array(z.string().min(1)).max(12),
  core_rubric: z.array(z.string().min(1)).min(1),
  user_confirmed: z.boolean(),
  confirmation: z.enum(['user-confirmed', 'headless-defaulted']),
}).strict();

/** Code review and old idea runs keep the smaller v1 contract. */
export const DecisionContractArtifact = z.union([DecisionContract, IntentContract]);

// ── S2: Interpretation — per provider (§13) ─────────────────────────────────

export const Interpretation = z
  .object({
    my_interpretation: z.string().min(1), // one sentence: what the model believes the user wants
    plausible_misreadings: z.array(z.string()).max(2), // "top-2" (§13); empty is degenerate but legal
  })
  .strict();

// ── S0: RunBrief / contextual grill ─────────────────────────────────────────

export const GrillQuestionAxis = z.enum([
  'decision_frame',
  'evaluation_lens',
  'target_user',
  'success_bar',
  'non_negotiables',
  'risk_context',
  'evidence',
  'alternatives',
  'scope',
]);

export const RunBriefQuestion = z
  .object({
    id: z.string().min(1),
    axis: GrillQuestionAxis,
    question: z.string().min(1),
    why_it_matters: z.string().min(1),
    suggested_answers: z.array(z.string().min(1)).min(2).max(5),
  })
  .strict();

const RunBriefDraftBase = z
  .object({
    subject: z.string().min(1),
    decision_frame: z.string().min(1).nullable(),
    evaluation_lens: z.string().min(1).nullable(),
    target_user: z.string().min(1).nullable(),
    constraints: z.array(z.string().min(1)).max(10),
    claims_to_test: z.array(z.string().min(1)).max(8),
    evidence_supplied: z.array(z.string().min(1)).max(8),
    missing_axes: z.array(z.string().min(1)).max(8),
    domain_dimensions: z.array(DomainDimension).min(3).max(5),
    questions: z.array(RunBriefQuestion).min(3).max(4),
  })
  .strict();

function checkQuestionIds(questions: { id: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions'], message: `duplicate question id: ${q.id}` });
    }
    seen.add(q.id);
  }
}

function checkDomainDimensionIds(dimensions: { id: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domain_dimensions'], message: `duplicate domain dimension id: ${dimension.id}` });
    }
    seen.add(dimension.id);
  }
}

export const RunBriefDraft = RunBriefDraftBase.superRefine((brief, ctx) => {
  checkQuestionIds(brief.questions, ctx);
  checkDomainDimensionIds(brief.domain_dimensions, ctx);
});

export const GrillAnswer = z
  .object({
    question_id: z.string().min(1),
    answer: z.string().min(1),
    source: z.enum(['user', 'suggested', 'default']),
  })
  .strict();

export const RunBrief = RunBriefDraftBase.extend({
  answers: z.array(GrillAnswer).min(3).max(4),
}).superRefine((brief, ctx) => {
  checkQuestionIds(brief.questions, ctx);
  checkDomainDimensionIds(brief.domain_dimensions, ctx);
  const questionIds = new Set(brief.questions.map((q) => q.id));
  const answerIds = new Set<string>();
  for (const answer of brief.answers) {
    if (!questionIds.has(answer.question_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: `answer for unknown question id: ${answer.question_id}` });
    }
    if (answerIds.has(answer.question_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: `duplicate answer for question id: ${answer.question_id}` });
    }
    answerIds.add(answer.question_id);
  }
  for (const q of brief.questions) {
    if (!answerIds.has(q.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: `missing answer for question id: ${q.id}` });
    }
  }
});

/** One of the two independent R6 preflight readings. */
export const PreflightReading = z.object({
  subject: z.string().min(1),
  interpretation: z.string().min(1),
  normalized_decision: z.string().min(1),
  alternatives: z.array(z.string().min(1)).max(8),
  target_user: z.string().min(1).nullable(),
  constraints: z.array(z.string().min(1)).max(10),
  success_bar: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).max(8),
  claims_to_test: z.array(z.string().min(1)).max(8),
  evidence_supplied: z.array(z.string().min(1)).max(8),
  missing_evidence: z.array(z.string().min(1)).max(8),
  domain_dimensions: z.array(DomainDimension).min(3).max(5),
  questions: z.array(RunBriefQuestion).min(3).max(4),
}).strict().superRefine((reading, ctx) => {
  checkQuestionIds(reading.questions, ctx);
  checkDomainDimensionIds(reading.domain_dimensions, ctx);
});

export const PreflightArtifact = z.object({
  readings: z.array(z.object({ provider: ProviderIdSchema, reading: PreflightReading }).strict()).min(1).max(2),
  clusters: z.array(z.object({ members: z.array(z.string()), representative: z.string().min(1) }).strict()),
  chosen: z.object({
    interpretation: z.string().min(1),
    how: z.enum(['single-cluster', 'majority-cluster', 'user-selected', 'user-combined', 'user-typed']),
  }).strict(),
  dropped: z.array(z.object({ provider: ProviderIdSchema, error: z.string().min(1) }).strict()),
}).strict();

// ── S4: RoleOutput — workflow-discriminated union (§12, §13) ─────────────────
//
// The model output (§13) does NOT carry a `workflow` field; the engine injects the discriminator
// before `.parse()` (S4, T5): `RoleOutput.parse({ workflow, ...modelJson })`.

const Assumption = z
  .object({
    id: z.string().min(1), // "A1", "A2", ...
    statement: z.string().min(1),
    type: z.enum(['VERIFIABLE', 'JUDGMENT']),
    load_bearing: z.boolean(),
  })
  .strict();

const Attack = z
  .object({
    id: z.string().min(1), // "X1", ...
    target_assumption: z.string().min(1), // MUST reference an assumption id (validator enforces at T7)
    argument: z.string().min(1),
    severity: z.enum(['HIGH', 'MED', 'LOW']),
  })
  .strict();

export const LegacyIdeaRoleOutput = z
  .object({
    workflow: z.literal('idea-refinement'),
    task_echo: z.string().min(1), // ≤2 sentence restatement (drift check, S5)
    strongest_version: z.string().min(1), // ≤150 words
    assumptions: z.array(Assumption).max(8),
    attacks: z.array(Attack).max(6),
    open_questions: z.array(z.string()).max(5),
  })
  .strict();

export const ClaimPosition = z
  .object({
    local_id: z.string().min(1),
    proposition: z.string().min(1),
    dimension_id: z.string().min(1),
    stance: z.enum(['SUPPORT', 'OPPOSE', 'MIXED', 'UNKNOWN']),
    basis: z.enum(['EVIDENCE', 'INFERENCE', 'ASSUMPTION']),
    load_bearing: z.boolean(),
    if_false: z.enum(['STOP', 'PIVOT', 'CONDITION', 'MINOR']),
    reasoning: z.string().min(1),
    evidence_ids: z.array(z.string().min(1)),
    depends_on: z.array(z.string().min(1)),
  })
  .strict();

const EvidenceCardBase = z
  .object({
    id: z.string().min(1),
    claim_supported: z.string().min(1),
    source_kind: z.enum(['USER', 'PRIMARY', 'SECONDARY', 'MODEL_KNOWLEDGE']),
    title: z.string().min(1).optional(),
    url: z.string().url().optional(),
    published_at: z.string().min(1).optional(),
    accessed_at: z.string().min(1).optional(),
    locator: z.string().min(1).optional(),
    support: z.enum(['SUPPORTS', 'CONTRADICTS', 'CONTEXT_ONLY']),
    freshness: z.enum(['CURRENT', 'DATED', 'UNKNOWN']),
  })
  .strict();

function checkEvidenceCard(card: z.infer<typeof EvidenceCardBase>, ctx: z.RefinementCtx): void {
  const external = card.source_kind === 'PRIMARY' || card.source_kind === 'SECONDARY';
  if (external && !card.url && !card.locator) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locator'], message: `${card.source_kind} evidence requires a URL or locator` });
  }
  if (external && card.freshness === 'CURRENT' && !card.accessed_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessed_at'], message: 'current external evidence requires accessed_at' });
  }
  if (card.source_kind === 'MODEL_KNOWLEDGE' && card.freshness === 'CURRENT') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['freshness'], message: 'model knowledge cannot claim current freshness' });
  }
}

export const EvidenceCard = EvidenceCardBase.superRefine(checkEvidenceCard);

export const CalculationInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
}).strict();

export const CalculationStep = z.object({
  id: z.string().min(1),
  operation: z.enum(['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE']),
  left: z.string().min(1),
  right: z.string().min(1),
  result: z.number().finite(),
  unit: z.string().min(1),
}).strict();

export const CalculationLedger = z.object({
  id: z.string().min(1),
  claim_id: z.string().min(1),
  inputs: z.array(CalculationInput).min(1).max(12),
  steps: z.array(CalculationStep).min(1).max(12),
  result_step: z.string().min(1),
}).strict();

// Live 20260714-2142 killed both seats on shape ceremony the prompt never promised: rationale on
// COVERED entries and a question id have no consumer, so the schema now matches the documented
// either/or shape (NOT_APPLICABLE still requires its rationale).
const CoverageEntryBase = z
  .object({
    dimension_id: z.string().min(1),
    status: z.enum(['COVERED', 'NOT_APPLICABLE']),
    position_ids: z.array(z.string().min(1)).default([]),
    rationale: z.string().min(1).optional(),
  })
  .strict();

function checkCoverageEntry(entry: z.infer<typeof CoverageEntryBase>, ctx: z.RefinementCtx): void {
  if (entry.status === 'NOT_APPLICABLE' && !entry.rationale) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rationale'], message: 'NOT_APPLICABLE coverage requires a rationale' });
  }
}

export const CoverageEntry = CoverageEntryBase.superRefine(checkCoverageEntry);

export const DecisionQuestion = z
  .object({
    id: z.string().min(1).optional(),
    question: z.string().min(1),
    claim_ids: z.array(z.string().min(1)),
  })
  .strict();

const IdeaRoleOutputBase = z
  .object({
    workflow: z.literal('idea-refinement'),
    task_echo: z.string().min(1),
    strongest_version: z.string().min(1),
    positions: z.array(ClaimPosition).max(12),
    evidence: z.array(EvidenceCard).max(20),
    calculations: z.array(CalculationLedger).max(8).default([]),
    coverage: z.array(CoverageEntry).max(18), // 13 core + up to 5 preflight domain dimensions
    decision_questions: z.array(DecisionQuestion).max(8),
  })
  .strict();

type SubmissionRefs = z.infer<typeof IdeaRoleOutputBase>;

function checkSubmissionRefs(submission: SubmissionRefs, ctx: z.RefinementCtx): void {
  const positionIds = new Set<string>();
  for (const [index, position] of submission.positions.entries()) {
    if (positionIds.has(position.local_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positions', index, 'local_id'], message: `duplicate position id: ${position.local_id}` });
    positionIds.add(position.local_id);
  }
  const evidenceIds = new Set<string>();
  for (const [index, evidence] of submission.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence', index, 'id'], message: `duplicate evidence id: ${evidence.id}` });
    evidenceIds.add(evidence.id);
  }
  const calculationIds = new Set<string>();
  for (const [index, calculation] of submission.calculations.entries()) {
    if (calculationIds.has(calculation.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'id'], message: `duplicate calculation id: ${calculation.id}` });
    calculationIds.add(calculation.id);
    if (!positionIds.has(calculation.claim_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'claim_id'], message: `unknown position id: ${calculation.claim_id}` });
    const refs = new Set(calculation.inputs.map((input) => input.id));
    const inputIds = new Set<string>();
    const stepIds = new Set<string>();
    for (const [inputIndex, input] of calculation.inputs.entries()) {
      if (inputIds.has(input.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'inputs', inputIndex, 'id'], message: `duplicate calculation input: ${input.id}` });
      inputIds.add(input.id);
      for (const evidenceId of input.evidence_ids) {
        if (!evidenceIds.has(evidenceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'inputs', inputIndex, 'evidence_ids'], message: `unknown evidence id: ${evidenceId}` });
      }
    }
    for (const [stepIndex, step] of calculation.steps.entries()) {
      if (!refs.has(step.left)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'steps', stepIndex, 'left'], message: `unknown or forward calculation reference: ${step.left}` });
      if (!refs.has(step.right)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'steps', stepIndex, 'right'], message: `unknown or forward calculation reference: ${step.right}` });
      if (refs.has(step.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'steps', stepIndex, 'id'], message: `duplicate calculation reference: ${step.id}` });
      refs.add(step.id);
      stepIds.add(step.id);
    }
    if (!stepIds.has(calculation.result_step)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calculations', index, 'result_step'], message: `unknown result step: ${calculation.result_step}` });
  }
  for (const [index, position] of submission.positions.entries()) {
    for (const id of position.evidence_ids) {
      if (!evidenceIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positions', index, 'evidence_ids'], message: `unknown evidence id: ${id}` });
    }
    for (const id of position.depends_on) {
      if (!positionIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['positions', index, 'depends_on'], message: `unknown position id: ${id}` });
    }
  }
  for (const [index, entry] of submission.coverage.entries()) {
    for (const id of entry.position_ids) {
      if (!positionIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage', index, 'position_ids'], message: `unknown position id: ${id}` });
    }
  }
  for (const [index, question] of submission.decision_questions.entries()) {
    for (const id of question.claim_ids) {
      if (!positionIds.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decision_questions', index, 'claim_ids'], message: `unknown position id: ${id}` });
    }
  }
}

export const IdeaRoleOutput = IdeaRoleOutputBase.superRefine(checkSubmissionRefs);

/** Defect categories a finding (and a seeded bug, T11) can carry. BENCHMARK.md's "defect class" match
 *  is equality on this enum (off-by-one→CORRECTNESS, race→CONCURRENCY, unhandled-rejection→ERROR_HANDLING,
 *  auth-gap→SECURITY, N+1→PERF). */
export const FindingCategory = z.enum(['CORRECTNESS', 'SECURITY', 'CONCURRENCY', 'ERROR_HANDLING', 'PERF', 'MAINTAINABILITY']);

export const Finding = z
  .object({
    id: z.string().min(1), // "F1", ...
    file: z.string().min(1),
    line_start: z.number().int().nonnegative(),
    line_end: z.number().int().nonnegative(),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    category: FindingCategory,
    claim: z.string().min(1),
    evidence: z.string().min(1), // the code/behavior that proves it
    suggested_fix: z.string().min(1),
    self_confidence: z.number().min(0).max(1),
  })
  .strict();

export const CodeReviewRoleOutput = z
  .object({
    workflow: z.literal('code-review'),
    task_echo: z.string().min(1),
    findings: z.array(Finding).max(12),
  })
  .strict();

export const RoleOutput = z.union([IdeaRoleOutput, CodeReviewRoleOutput]);

/** The exact JSON a code-review S4 reviewer returns: `CodeReviewRoleOutput` WITHOUT the `workflow`
 *  discriminator (§13 — model output carries no `workflow`). Mirrors `IdeaRoleOutputModel` (T6); S4
 *  validates the raw call against this, injects `workflow`, then persists as `RoleOutput` (T10). */
export const CodeReviewRoleOutputModel = CodeReviewRoleOutput.omit({ workflow: true });

const StrictIdeaRoleOutputModel = IdeaRoleOutputBase.omit({ workflow: true }).superRefine((submission, ctx) =>
  checkSubmissionRefs({ workflow: 'idea-refinement', ...submission }, ctx));

/** Case-insensitive match to an exact canonical enum word (plus known aliases); prose never matches. */
function canonicalEnum(value: unknown, canon: readonly string[], aliases: Record<string, string> = {}): unknown {
  if (typeof value !== 'string') return value;
  const upper = value.toUpperCase();
  const mapped = aliases[upper] ?? upper;
  return canon.includes(mapped) ? mapped : value;
}

/** Match a leading canonical/alias token with trailing prose ("OPPOSES: <reason>"), the observed
 *  20260714-2142 codex vocabulary. The FIRST word must itself be the token; free prose whose first
 *  word is not a known token still never matches. */
function canonicalEnumLeadingToken(value: unknown, canon: readonly string[], aliases: Record<string, string> = {}): unknown {
  if (typeof value !== 'string') return value;
  const token = value.trim().match(/^[A-Za-z_]+/)?.[0]?.toUpperCase();
  if (!token) return value;
  const mapped = aliases[token] ?? token;
  return canon.includes(mapped) ? mapped : value;
}

/** Canonicalize enum spellings observed in live provider repairs (SUPPORT, current, Current);
 *  anything that is not the exact word in some casing stays invalid. */
function canonicalizeIdeaRoleOutputModel(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const output = input as Record<string, unknown>;
  if (!Array.isArray(output.evidence)) return input;
  return {
    ...output,
    evidence: output.evidence.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const evidence = item as Record<string, unknown>;
      return {
        ...evidence,
        support: canonicalEnumLeadingToken(evidence.support, ['SUPPORTS', 'CONTRADICTS', 'CONTEXT_ONLY'],
          { SUPPORT: 'SUPPORTS', OPPOSES: 'CONTRADICTS', OPPOSE: 'CONTRADICTS' }),
        freshness: canonicalEnum(evidence.freshness, ['CURRENT', 'DATED', 'UNKNOWN']),
      };
    }),
  };
}

/** Deterministic last resort after a failed §14 repair. Three live failures shaped it:
 *  run 20260712-0011 wrote evidence prose into `support`; run 20260713-1503 added an unknown `content`
 *  key to every card and leaked `MODEL_KNOWLEDGE` into a position's `basis`; run 20260714-2142 killed
 *  BOTH seats via an over-cap calculation ledger and coverage/question entries the old salvage never
 *  touched. Policy, strictly deterministic (never invents a value):
 *  - unknown extra keys are stripped (zod `.strip()` re-parse);
 *  - an evidence card that still fails is dropped, and its id scrubbed from positions;
 *  - a position that still fails is dropped, and its id scrubbed from depends_on / coverage /
 *    decision_questions — one bad position costs one position, not the whole seat;
 *  - a calculation that still fails, or whose position/evidence anchors were dropped, is dropped;
 *    the survivors are truncated to the schema cap in order (one bad ledger costs one ledger);
 *  - a coverage entry or decision question that still fails is dropped (a dropped coverage entry
 *    becomes a visible structural hole downstream, never a dead seat);
 *  - a seat with NO surviving position stays a hard failure (nothing to analyze). */
export function salvageIdeaRoleOutputModel(input: unknown): unknown {
  const canonical = canonicalizeIdeaRoleOutputModel(input);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return canonical;
  const output = canonical as Record<string, unknown>;
  if (!Array.isArray(output.evidence) || !Array.isArray(output.positions)) return canonical;

  const evidence = output.evidence
    .map((item) => EvidenceCardBase.strip().superRefine(checkEvidenceCard).safeParse(item))
    .flatMap((result) => (result.success ? [result.data] : []));
  const keptEvidence = new Set(evidence.map((card) => card.id));

  const parsedPositions = output.positions
    .map((item) => ClaimPosition.strip().safeParse(item))
    .flatMap((result) => (result.success ? [result.data] : []));
  if (parsedPositions.length === 0) return canonical; // empty claim set → let strict validation fail it
  const keptPositions = new Set(parsedPositions.map((position) => position.local_id));

  const positions = parsedPositions.map((position) => ({
    ...position,
    evidence_ids: position.evidence_ids.filter((id) => keptEvidence.has(id)),
    depends_on: position.depends_on.filter((id) => keptPositions.has(id)),
  }));

  const scrubIds = (value: unknown, key: 'position_ids' | 'claim_ids'): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const entry = item as Record<string, unknown>;
      if (!Array.isArray(entry[key])) return item;
      return { ...entry, [key]: (entry[key] as unknown[]).filter((id) => keptPositions.has(id as string)) };
    });
  };

  const parseOrDrop = (value: unknown, parse: (item: unknown) => { success: boolean; data?: unknown }): unknown =>
    Array.isArray(value)
      ? value.map((item) => parse(item)).flatMap((result) => (result.success ? [result.data] : []))
      : value;

  const calculations = Array.isArray(output.calculations)
    ? (parseOrDrop(output.calculations, (item) => CalculationLedger.strip().safeParse(item)) as Array<z.infer<typeof CalculationLedger>>)
      .filter((calc) => keptPositions.has(calc.claim_id)
        && calc.inputs.every((input) => input.evidence_ids.every((id) => keptEvidence.has(id))))
      .slice(0, 8)
    : output.calculations;

  return {
    ...output,
    evidence,
    positions,
    calculations,
    coverage: parseOrDrop(scrubIds(output.coverage, 'position_ids'),
      (item) => CoverageEntryBase.strip().superRefine(checkCoverageEntry).safeParse(item)),
    decision_questions: parseOrDrop(scrubIds(output.decision_questions, 'claim_ids'),
      (item) => DecisionQuestion.strip().safeParse(item)),
  };
}

/** The model-facing S4 shape. Exact known enum aliases are canonicalized, then the strict schema validates
 *  the full output; persisted `IdeaRoleOutput` remains canonical-only. */
export const IdeaRoleOutputModel: z.ZodType<z.infer<typeof StrictIdeaRoleOutputModel>, z.ZodTypeDef, unknown> =
  z.preprocess(canonicalizeIdeaRoleOutputModel, StrictIdeaRoleOutputModel);

// ── S3: StagePrompts (§9, §13) ──────────────────────────────────────────────
//
// S3 output: the role-specific S4 prompts with every {{SLOT}} filled. Deterministic validator
// (S3) additionally rejects any prompt still containing an unresolved `{{...}}` (§9 S3 row).

export const StagePrompts = z
  .object({
    prompts: z.record(z.string(), z.string()), // role name → filled prompt (non-empty map)
  })
  .strict();

// ── S7: ClaimGroups — semantic grouping call output (T7, decision B refined) ──
//
// The one constrained model call inside S7 (run on the judge role). It receives claim IDs +
// statements with attribution WITHHELD and returns ONLY groupings of existing IDs that mean the
// same thing. Strict + IDs-only is the anti-blending guard: the model groups by reference, never
// rewrites a claim. Empty `groups` = nothing merged (legal). Each group needs ≥2 IDs to be a merge.
export const ClaimGroups = z
  .object({
    groups: z.array(z.array(z.string().min(1)).min(2)),
  })
  .strict();

// ── R2: typed decision graph ────────────────────────────────────────────────

const GraphPosition = ClaimPosition.extend({
  id: z.string().min(1),
  provider: ProviderIdSchema,
  source_id: z.string().min(1),
});

const GraphEvidence = EvidenceCardBase.extend({
  id: z.string().min(1),
  provider: ProviderIdSchema,
  source_id: z.string().min(1),
}).superRefine(checkEvidenceCard);

const GraphCalculation = CalculationLedger.extend({
  id: z.string().min(1),
  claim_id: z.string().min(1),
  provider: ProviderIdSchema,
  source_id: z.string().min(1),
});

export const CalculationCheck = z.object({
  calculation_id: z.string().min(1),
  claim_id: z.string().min(1),
  status: z.enum(['PASS', 'FAIL']),
  issues: z.array(z.string()),
}).strict();

export const DecisionClaim = z.object({
  id: z.string().min(1),
  proposition: z.string().min(1),
  position_ids: z.array(z.string().min(1)).min(1),
  state: z.enum(['CONSENSUS', 'SHARED_CONCERN', 'DISAGREEMENT', 'UNIQUE', 'UNCERTAIN']),
  evidence_state: z.enum(['SUPPORTED', 'CONFLICTED', 'UNVERIFIED']),
  load_bearing: z.boolean(),
  if_false: z.enum(['STOP', 'PIVOT', 'CONDITION', 'MINOR']),
  sensitivity: z.enum(['DECISIVE', 'MATERIAL', 'LOW']),
});

export const DecisionGraph = z.object({
  positions: z.array(GraphPosition),
  evidence: z.array(GraphEvidence),
  calculations: z.array(GraphCalculation).default([]),
  calculation_checks: z.array(CalculationCheck).default([]),
  claims: z.array(DecisionClaim),
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.enum(['DEPENDS_ON', 'SUPPORTS', 'ATTACKS', 'CONTRADICTS']),
  })),
  holes: z.object({
    coverage: z.array(z.object({ dimension_id: z.string().min(1), label: z.string().min(1) })),
    evidence: z.array(z.object({ claim_id: z.string().min(1), reason: z.string().min(1) })),
  }),
});

// ── S8: Verification (§13) ──────────────────────────────────────────────────
//
// `Verification` is the per-item verdict (§9 "per-item Verification"). `VerificationSet` is the
// actual S8 stage output. Each item is judged independently; no verdict distribution is required.

export const Verification = z
  .object({
    target_id: z.string().min(1),
    verdict: z.enum(['CONFIRM', 'REFUTE', 'UNCERTAIN']),
    evidence: z.string().min(1), // the verifier's own independent evidence
    note: z.string(), // ≤2 sentences
  })
  .strict();

export const VerificationSet = z
  .object({
    verifications: z.array(Verification),
    // Accepted for backward compatibility with pre-R1 artifacts; the R1 prompt no longer requests it.
    all_confirmed_justification: z.string().optional(),
  })
  .strict();

export const ClaimVerification = z.object({
  claim_id: z.string().min(1),
  status: z.enum(['VERIFIED', 'PARTIAL', 'CONTRADICTED', 'UNVERIFIABLE']),
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)),
  calculation_check: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']).optional(),
  missing_evidence: z.array(z.string().min(1)),
}).strict();

export const ClaimVerificationSet = z.object({
  verifications: z.array(ClaimVerification),
}).strict();

// ── R5: bounded, append-only rebuttal events ───────────────────────────────

const RebuttalResponseBase = z.object({
  claim_id: z.string().min(1),
  response: z.enum(['CONCEDE', 'COUNTER', 'NARROW', 'UNRESOLVED']),
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)),
  narrowed_proposition: z.string().min(1).optional(),
}).strict();

const checkNarrowedRebuttal = (
  event: z.infer<typeof RebuttalResponseBase>,
  ctx: z.RefinementCtx,
): void => {
  if (event.response === 'NARROW' && !event.narrowed_proposition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['narrowed_proposition'],
      message: 'NARROW requires narrowed_proposition',
    });
  }
};

export const RebuttalResponse = RebuttalResponseBase.superRefine(checkNarrowedRebuttal);

/** Exact model output for one scout's single rebuttal round. */
export const RebuttalResponseSet = z.object({
  events: z.array(RebuttalResponse).max(3),
}).strict();

export const RebuttalEvent = RebuttalResponseBase.extend({
  id: z.string().min(1),
  round: z.literal(1),
  responder: ProviderIdSchema,
  target_position_ids: z.array(z.string().min(1)),
}).superRefine(checkNarrowedRebuttal);

/** Persisted separately from DecisionGraph so original claims/evidence remain immutable. */
export const RebuttalEventSet = z.object({
  round: z.literal(1),
  selected_claim_ids: z.array(z.string().min(1)).max(3),
  events: z.array(RebuttalEvent).max(6),
  stop_reason: z.enum([
    'NO_ESCALATIONS',
    'NO_ELIGIBLE_SCOUT',
    'BUDGET_RESERVED',
    'ROUND_COMPLETE',
    'NO_NEW_EVIDENCE',
    'CALL_CAP_REACHED',
  ]),
}).strict();

/** Shared artifact slot: code review keeps the v1 cross-exam shape; idea refinement uses R4 claims. */
export const VerificationArtifact = z.union([VerificationSet, ClaimVerificationSet]);

// ── S7: DisagreementMap (§7, §9) ────────────────────────────────────────────
//
// The plan (§7/§9) names only the four arrays. `Claim` shape is from §6. NOTE two under-specified
// points resolved here as documented T4 choices, to be firmed when S6/S7 are built (T6/T7):
//   1. §6's snippet shows singular `provider`, but its prose says merged claims carry
//      "multi-provider attribution" → we use `providers: []` (array) to hold that attribution.
//   2. The plan gives no element shape for `contradictions` → minimal {claim_ids, note?}.
// These are internal (engine-built), so this schema is not `.strict()`.

export const Claim = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  type: z.enum(['VERIFIABLE', 'JUDGMENT']),
  providers: z.array(ProviderIdSchema).min(1), // attribution; ≥2 after an S6 merge
  evidence: z.string().optional(),
});

// A dispute over a claim. For idea-refinement (T6) a contradiction is a contested assumption: one
// or more analysts asserted the claim, and ≥1 analyst attacked it. The `attacks` ARE the dispute
// content — they are exactly the "disputed items + evidence" the S8 verifier loop consumes (§9 S8),
// so a contradiction without attacks would be meaningless. `id` is the stable target S8/S9 reference.
// (Shape firmed at T6, as the T4 note anticipated: the old `claim_ids ≥2` assumed contradictions
//  linked two claims, but the deterministic idea-refinement signal centers on one contested claim.)
export const Contradiction = z.object({
  id: z.string().min(1), // "D1", ...
  claim_ids: z.array(z.string()).min(1), // the contested claim id(s)
  attacks: z
    .array(
      z.object({
        provider: ProviderIdSchema,
        argument: z.string().min(1),
        severity: z.enum(['HIGH', 'MED', 'LOW']),
      }),
    )
    .min(1),
  note: z.string().optional(),
});

export const DisagreementMap = z.object({
  consensus: z.array(Claim), // agreed by ≥2 providers
  contradictions: z.array(Contradiction), // direct conflicts; empty is legal (→ low_diversity flag)
  unique: z.array(Claim), // raised by exactly one provider
  blind_spots: z.array(z.string()), // rubric checklist items no provider addressed
});

// ── code-review: ReviewMap (§12.2, T10) ─────────────────────────────────────
//
// The code-review analog of DisagreementMap. Findings are line-anchored, so unlike idea's prose
// claims we CAN deterministically detect when both reviewers independently flagged the same bug
// (the §487 matcher: same file + overlapping lines + same category). Built pre-S9 from {reviewer
// findings, mutual cross-exam}; the judge then adjudicates only `disputed`. Final HIGH/MED/LOW
// confidence + false-positive exclusion are DERIVED at S10 (not stored here) — one source of truth.
// Internal (engine-built) → not strict.

/** The other reviewer's cross-exam verdict on a finding. `NONE` = both reviewers raised it
 *  independently (§487-matched), so no cross-exam was needed to confirm it. */
export const CrossVerdict = z.enum(['CONFIRM', 'REFUTE', 'UNCERTAIN', 'NONE']);

/** A finding tagged with who raised it, the other reviewer's cross-exam verdict, and (if disputed)
 *  the refuting argument. `reviewers` has 2 entries only when both independently found the same bug. */
export const AnnotatedFinding = z.object({
  finding: Finding,
  reviewers: z.array(ProviderIdSchema).min(1),
  cross_verdict: CrossVerdict,
  refutation: z.string().optional(),
});

export const ReviewMap = z.object({
  consensus: z.array(AnnotatedFinding), // both-independent or CONFIRMed → HIGH
  disputed: z.array(AnnotatedFinding), // REFUTEd → adjudicated by S9
  single_reviewer: z.array(AnnotatedFinding), // one reviewer, UNCERTAIN/unexamined → MEDIUM
  per_reviewer: z.array(
    z.object({ provider: ProviderIdSchema, raised: z.number().int().nonnegative(), kept: z.number().int().nonnegative(), dropped: z.number().int().nonnegative() }),
  ),
});

// ── S9: JudgeReport (§13) ───────────────────────────────────────────────────

const Adjudication = z
  .object({
    id: z.string().min(1), // disputed item id
    ruling: z.enum(['UPHOLD', 'REJECT', 'UNRESOLVED']),
    reasoning: z.string().min(1), // ≤3 sentences
    evidence_cited: z.string().min(1).optional(), // code-review / legacy idea artifacts
    evidence_ids: z.array(z.string().min(1)).optional(), // R4 idea chair citations, validated by reference
    effect_on_decision: z.string().min(1).optional(), // R5 idea chair; optional for legacy/code-review artifacts
    what_would_change_it: z.string().min(1).optional(), // required by S9 when an idea ruling is UNRESOLVED
  })
  .strict()
  .refine((item) => item.evidence_cited || item.evidence_ids?.length, { message: 'adjudication requires evidence' });

export const Recommendation = z.enum(['PROCEED', 'PROCEED_WITH_CONDITIONS', 'PIVOT', 'STOP']);

const JudgeReportBase = z
  .object({
    adjudications: z.array(Adjudication),
    verdict: z.string().min(1), // the recommendation + core reason (idea: 2-5 sentences; grounded in adjudicated + consensus claims)
    recommendation: Recommendation.optional(), // idea workflow; code-review omits it
    conditions: z.array(z.string().min(1)).max(6).optional(), // present only for PROCEED_WITH_CONDITIONS
    recommendation_claim_ids: z.array(z.string().min(1)).min(1).max(8).optional(),
    condition_claim_ids: z.array(z.string().min(1)).min(1).max(8).optional(),
    pivot: z.object({
      changed_claim_id: z.string().min(1),
      new_risk_claim_id: z.string().min(1),
    }).strict().optional(),
    strongest_counter_case: z.object({
      claim_ids: z.array(z.string().min(1)).min(1).max(4),
      reasoning: z.string().min(1),
    }).strict().optional(),
    key_points: z.array(z.string()).max(10).optional(), // chairman's bulleted reasoning (idea workflow); code-review omits it
    dissent: z.array(z.string()).min(1), // ≥1 — empty dissent is invalid (§9); strongest counter-argument
    confidence_notes: z.string().min(1), // which conclusions are HIGH/MEDIUM/LOW and why
  })
  .strict();

export const JudgeReport = JudgeReportBase.superRefine((r, ctx) => {
  const hasConditions = (r.conditions?.length ?? 0) > 0;
  if (r.recommendation === 'PROCEED_WITH_CONDITIONS' && !hasConditions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conditions'],
      message: 'conditions are required when recommendation is PROCEED_WITH_CONDITIONS',
    });
  }
  if (hasConditions && r.recommendation !== 'PROCEED_WITH_CONDITIONS') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['conditions'],
      message: 'conditions are only valid for PROCEED_WITH_CONDITIONS',
    });
  }
});

/** S9 call-time variant: `dissent` relaxed to min-0 so an empty dissent does NOT auto-throw inside
 *  jsonCall. S9 enforces the non-empty rule itself (one re-ask → else flag `synthesis_suspect` +
 *  inject a placeholder) so it can salvage the rest of the report instead of failing the run (§260).
 *  Recommendation/condition consistency is also enforced inside idea S9, not by this relaxed schema. */
export const JudgeReportModel = JudgeReportBase.extend({
  dissent: z.array(z.string()),
});

/** R5 idea-chair boundary. Persisted JudgeReport keeps its legacy adjudication names so code-review
 *  and old run readers stay compatible; S9 translates only after this exact model shape validates. */
export const IdeaChairRuling = z.object({
  claim_id: z.string().min(1),
  ruling: z.enum(['HOLDS', 'FAILS', 'UNRESOLVED']),
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)).min(1),
  effect_on_decision: z.string().min(1),
  what_would_change_it: z.string().min(1).optional(),
}).strict().superRefine((ruling, ctx) => {
  if (ruling.ruling === 'UNRESOLVED' && !ruling.what_would_change_it) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['what_would_change_it'],
      message: 'UNRESOLVED requires what_would_change_it',
    });
  }
});

export const IdeaChairReportModel = JudgeReportModel.omit({ adjudications: true }).extend({
  adjudications: z.array(IdeaChairRuling),
});

// ── S9b: ActionPlan (idea-refinement report v3) ─────────────────────────────

export const ActionPlan = z
  .object({
    actions: z
      .array(
        z
          .object({
            order: z.number().int().min(1),
            action: z.string().min(1),
            why: z.string().min(1),
            validates: z.string().min(1),
            effort: z.enum(['S', 'M', 'L']),
            kill_signal: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(7),
    sequencing_note: z.string().min(1),
  })
  .strict();

export const PlannerUnavailable = z.object({
  kind: z.literal('PlannerUnavailable'),
  reason: z.enum(['budget_exhausted', 'planner_failed']),
  unresolved_questions: z.array(z.string().min(1)).min(1).max(10),
}).strict();

export const ActionPlanArtifact = z.union([ActionPlan, PlannerUnavailable]);

/** R6 quick mode: one strong analyst produces the analysis, recommendation, and plan in one call. */
export const QuickDecisionModel = z.object({
  analysis: IdeaRoleOutputModel,
  verdict: z.string().min(1),
  recommendation: Recommendation,
  conditions: z.array(z.string().min(1)).max(6),
  key_points: z.array(z.string().min(1)).min(2).max(8),
  dissent: z.array(z.string().min(1)).min(1).max(4),
  confidence_notes: z.string().min(1),
  action_plan: ActionPlan,
}).strict().superRefine((decision, ctx) => {
  const hasConditions = decision.conditions.length > 0;
  if (decision.recommendation === 'PROCEED_WITH_CONDITIONS' && !hasConditions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions'], message: 'conditions are required for PROCEED_WITH_CONDITIONS' });
  }
  if (decision.recommendation !== 'PROCEED_WITH_CONDITIONS' && hasConditions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['conditions'], message: 'conditions are only valid for PROCEED_WITH_CONDITIONS' });
  }
});

// ── RunMeta (§15, §16) ──────────────────────────────────────────────────────
//
// Written by the artifact writer; assembled by the engine's RunCtx (T5). Internal → not strict.

/** One provider call's accounting entry (§15 "per-call timings"). */
export const CallRecord = z.object({
  provider: ProviderIdSchema,
  stage: z.string(), // e.g. "S4", "S1"
  category: z.enum(['discovery', 'verification', 'repair', 'planning']).optional(),
  durationMs: z.number().nonnegative(),
  error: z.enum(['NOT_FOUND', 'AUTH', 'QUOTA', 'TIMEOUT', 'BAD_OUTPUT', 'CRASH']).optional(),
});

/** How read-only was actually enforced per provider (§15, §19). Mirrors providers ReadOnlyFlag. */
const ReadOnlyFlagSchema = z.enum(['plan', 'sandbox', 'none']);

/** Resolved flag profile as recorded in meta (mirrors providers/types.ts FlagProfile). */
const FlagProfileSchema = z.object({
  id: ProviderIdSchema,
  jsonOutput: z.boolean(),
  readOnlyFlag: ReadOnlyFlagSchema,
  model: z.string().optional(),
});

export const RunMeta = z.object({
  run_id: z.string().min(1), // encodes the timestamp (e.g. 20260702-1412-idea-refinement-a3f9)
  workflow: WorkflowIdSchema,
  mode: IdeaModeSchema.optional(),
  provider_versions: z.record(ProviderIdSchema, z.string()), // detected `--version` strings
  flag_profiles: z.record(ProviderIdSchema, FlagProfileSchema),
  roles: z.record(z.string(), ProviderIdSchema), // role name → assigned provider
  read_only: z.record(ProviderIdSchema, ReadOnlyFlagSchema), // enforcement level per provider
  calls: z.array(CallRecord),
  call_count: z.number().int().nonnegative(),
  budget: z.object({ limit: z.number().int().positive(), used: z.number().int().nonnegative() }),
  receipt: z.object({
    discovery: z.number().int().nonnegative(),
    verification: z.number().int().nonnegative(),
    repair: z.number().int().nonnegative(),
    planning: z.number().int().nonnegative(),
  }).optional(),
  exit_status: z.enum(['ok', 'failed', 'aborted', 'partial']),
  aborted: z.boolean(), // §16: Ctrl+C finalizes meta with aborted:true
  // §16 report-header flags; absent = none.
  flags: z.array(z.enum([
    'synthesis_suspect',
    'low_diversity',
    'plan_skipped',
    'plan_fallback',
    'headless_intent',
    'verification_skipped',
    'research_ungrounded',
    'single_model',
  ])).optional(),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type IntentContract = z.infer<typeof IntentContract>;
export type DecisionContract = z.infer<typeof DecisionContract>;
export type DomainDimension = z.infer<typeof DomainDimension>;
export type IdeaMode = z.infer<typeof IdeaModeSchema>;
export type Interpretation = z.infer<typeof Interpretation>;
export type GrillQuestionAxis = z.infer<typeof GrillQuestionAxis>;
export type RunBriefQuestion = z.infer<typeof RunBriefQuestion>;
export type RunBriefDraft = z.infer<typeof RunBriefDraft>;
export type GrillAnswer = z.infer<typeof GrillAnswer>;
export type RunBrief = z.infer<typeof RunBrief>;
export type PreflightReading = z.infer<typeof PreflightReading>;
export type PreflightArtifact = z.infer<typeof PreflightArtifact>;
export type StagePrompts = z.infer<typeof StagePrompts>;
export type RoleOutput = z.infer<typeof RoleOutput>;
export type IdeaRoleOutput = z.infer<typeof IdeaRoleOutput>;
export type IdeaRoleOutputModel = z.infer<typeof IdeaRoleOutputModel>;
export type LegacyIdeaRoleOutput = z.infer<typeof LegacyIdeaRoleOutput>;
export type ClaimPosition = z.infer<typeof ClaimPosition>;
export type EvidenceCard = z.infer<typeof EvidenceCard>;
export type CalculationInput = z.infer<typeof CalculationInput>;
export type CalculationStep = z.infer<typeof CalculationStep>;
export type CalculationLedger = z.infer<typeof CalculationLedger>;
export type CalculationCheck = z.infer<typeof CalculationCheck>;
export type CoverageEntry = z.infer<typeof CoverageEntry>;
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;
export type CodeReviewRoleOutput = z.infer<typeof CodeReviewRoleOutput>;
export type CodeReviewRoleOutputModel = z.infer<typeof CodeReviewRoleOutputModel>;
export type Finding = z.infer<typeof Finding>;
export type FindingCategory = z.infer<typeof FindingCategory>;
export type CrossVerdict = z.infer<typeof CrossVerdict>;
export type AnnotatedFinding = z.infer<typeof AnnotatedFinding>;
export type ReviewMap = z.infer<typeof ReviewMap>;
export type ClaimGroups = z.infer<typeof ClaimGroups>;
export type DecisionClaim = z.infer<typeof DecisionClaim>;
export type DecisionGraph = z.infer<typeof DecisionGraph>;
export type Verification = z.infer<typeof Verification>;
export type VerificationSet = z.infer<typeof VerificationSet>;
export type ClaimVerification = z.infer<typeof ClaimVerification>;
export type ClaimVerificationSet = z.infer<typeof ClaimVerificationSet>;
export type RebuttalResponse = z.infer<typeof RebuttalResponse>;
export type RebuttalResponseSet = z.infer<typeof RebuttalResponseSet>;
export type RebuttalEvent = z.infer<typeof RebuttalEvent>;
export type RebuttalEventSet = z.infer<typeof RebuttalEventSet>;
export type Claim = z.infer<typeof Claim>;
export type Contradiction = z.infer<typeof Contradiction>;
export type DisagreementMap = z.infer<typeof DisagreementMap>;
export type Recommendation = z.infer<typeof Recommendation>;
export type JudgeReport = z.infer<typeof JudgeReport>;
export type JudgeReportModel = z.infer<typeof JudgeReportModel>;
export type IdeaChairRuling = z.infer<typeof IdeaChairRuling>;
export type IdeaChairReportModel = z.infer<typeof IdeaChairReportModel>;
export type ActionPlan = z.infer<typeof ActionPlan>;
export type PlannerUnavailable = z.infer<typeof PlannerUnavailable>;
export type ActionPlanArtifact = z.infer<typeof ActionPlanArtifact>;
export type QuickDecisionModel = z.infer<typeof QuickDecisionModel>;
export type RunMeta = z.infer<typeof RunMeta>;
export type CallRecord = z.infer<typeof CallRecord>;
