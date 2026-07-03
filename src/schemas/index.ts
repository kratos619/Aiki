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

// ── S1: IntentContract (§13) ────────────────────────────────────────────────

export const IntentContract = z
  .object({
    task: z.string().min(1), // one-paragraph normalized restatement
    task_type: TaskTypeSchema,
    constraints: z.array(z.string()), // explicit constraints the user stated (may be empty)
    unknowns: z.array(z.string()), // things the request leaves unspecified
    success_criteria: z.array(z.string()), // what a good final output must contain
  })
  .strict();

// ── S2: Interpretation — per provider (§13) ─────────────────────────────────

export const Interpretation = z
  .object({
    my_interpretation: z.string().min(1), // one sentence: what the model believes the user wants
    plausible_misreadings: z.array(z.string()).max(2), // "top-2" (§13); empty is degenerate but legal
  })
  .strict();

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

export const IdeaRoleOutput = z
  .object({
    workflow: z.literal('idea-refinement'),
    task_echo: z.string().min(1), // ≤2 sentence restatement (drift check, S5)
    strongest_version: z.string().min(1), // ≤150 words
    assumptions: z.array(Assumption).max(8),
    attacks: z.array(Attack).max(6),
    open_questions: z.array(z.string()).max(5),
  })
  .strict();

const Finding = z
  .object({
    id: z.string().min(1), // "F1", ...
    file: z.string().min(1),
    line_start: z.number().int().nonnegative(),
    line_end: z.number().int().nonnegative(),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    category: z.enum(['CORRECTNESS', 'SECURITY', 'CONCURRENCY', 'ERROR_HANDLING', 'PERF', 'MAINTAINABILITY']),
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

export const RoleOutput = z.discriminatedUnion('workflow', [IdeaRoleOutput, CodeReviewRoleOutput]);

/** The exact JSON the model returns for an idea-refinement S4 seat: `IdeaRoleOutput` WITHOUT the
 *  `workflow` discriminator (§13 — model output carries no `workflow`). S4 validates the raw call
 *  against this, then injects `workflow` and re-validates as `RoleOutput` before persisting.
 *  `.omit` preserves the object's strict mode, so extra keys still trigger the §14 repair retry. */
export const IdeaRoleOutputModel = IdeaRoleOutput.omit({ workflow: true });

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

// ── S8: Verification (§13) ──────────────────────────────────────────────────
//
// `Verification` is the per-item verdict (§9 "per-item Verification"). `VerificationSet` is the
// actual S8 stage output: the array plus the mandatory justification when zero REFUTEs (§13).

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
    // Required by the S8 prompt only when the verifier issued zero REFUTEs (§13).
    all_confirmed_justification: z.string().optional(),
  })
  .strict();

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

// ── S9: JudgeReport (§13) ───────────────────────────────────────────────────

const Adjudication = z
  .object({
    id: z.string().min(1), // disputed item id
    ruling: z.enum(['UPHOLD', 'REJECT', 'UNRESOLVED']),
    reasoning: z.string().min(1), // ≤3 sentences
    evidence_cited: z.string().min(1),
  })
  .strict();

export const JudgeReport = z
  .object({
    adjudications: z.array(Adjudication),
    verdict: z.string().min(1), // ≤80 words, grounded in adjudicated + consensus claims only
    dissent: z.array(z.string()).min(1), // ≥1 — empty dissent is invalid (§9); strongest counter-argument
    confidence_notes: z.string().min(1), // which conclusions are HIGH/MEDIUM/LOW and why
  })
  .strict();

/** S9 call-time variant: `dissent` relaxed to min-0 so an empty dissent does NOT auto-throw inside
 *  jsonCall. S9 enforces the non-empty rule itself (one re-ask → else flag `synthesis_suspect` +
 *  inject a placeholder) so it can salvage the rest of the report instead of failing the run (§260). */
export const JudgeReportModel = JudgeReport.extend({
  dissent: z.array(z.string()),
});

// ── RunMeta (§15, §16) ──────────────────────────────────────────────────────
//
// Written by the artifact writer; assembled by the engine's RunCtx (T5). Internal → not strict.

/** One provider call's accounting entry (§15 "per-call timings"). */
export const CallRecord = z.object({
  provider: ProviderIdSchema,
  stage: z.string(), // e.g. "S4", "S1"
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
});

export const RunMeta = z.object({
  run_id: z.string().min(1), // encodes the timestamp (e.g. 20260702-1412-idea-refinement-a3f9)
  workflow: WorkflowIdSchema,
  provider_versions: z.record(ProviderIdSchema, z.string()), // detected `--version` strings
  flag_profiles: z.record(ProviderIdSchema, FlagProfileSchema),
  roles: z.record(z.string(), ProviderIdSchema), // role name → assigned provider
  read_only: z.record(ProviderIdSchema, ReadOnlyFlagSchema), // enforcement level per provider
  calls: z.array(CallRecord),
  call_count: z.number().int().nonnegative(),
  budget: z.object({ limit: z.number().int().positive(), used: z.number().int().nonnegative() }),
  exit_status: z.enum(['ok', 'failed', 'aborted', 'partial']),
  aborted: z.boolean(), // §16: Ctrl+C finalizes meta with aborted:true
  // §16 report-header flags; absent = none.
  flags: z.array(z.enum(['synthesis_suspect', 'low_diversity'])).optional(),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type IntentContract = z.infer<typeof IntentContract>;
export type Interpretation = z.infer<typeof Interpretation>;
export type StagePrompts = z.infer<typeof StagePrompts>;
export type RoleOutput = z.infer<typeof RoleOutput>;
export type IdeaRoleOutput = z.infer<typeof IdeaRoleOutput>;
export type IdeaRoleOutputModel = z.infer<typeof IdeaRoleOutputModel>;
export type CodeReviewRoleOutput = z.infer<typeof CodeReviewRoleOutput>;
export type ClaimGroups = z.infer<typeof ClaimGroups>;
export type Verification = z.infer<typeof Verification>;
export type VerificationSet = z.infer<typeof VerificationSet>;
export type Claim = z.infer<typeof Claim>;
export type Contradiction = z.infer<typeof Contradiction>;
export type DisagreementMap = z.infer<typeof DisagreementMap>;
export type JudgeReport = z.infer<typeof JudgeReport>;
export type JudgeReportModel = z.infer<typeof JudgeReportModel>;
export type RunMeta = z.infer<typeof RunMeta>;
export type CallRecord = z.infer<typeof CallRecord>;
