// Run 20260718-1720-idea-refinement-e1ce (REAL, 2026-07-18): S9 died BAD_OUTPUT
// "invalid verification references: unknown claim id: G2; missing claim verification: G7" — with a
// FULLY-COMPLIANT S8 verification set on disk. Time-of-check/time-of-use: S8 selects its 8 targets
// from the pre-overlay graph and validates its own output against them; the workflow then applies
// overlayClaimGroups (S8's OWN claim_groups create it), which shifts claim states and re-ranks the
// escalation ordering; S9 recomputed selectVerificationEscalations on the JOINED graph (G2 out,
// G7 in) and demanded S8's output match a selection that did not exist when S8 ran. The chair also
// structurally requires a verification per adjudicated claim (adjudicationEvidenceViolations), so
// the verified set IS the chair's scope — S9 must adjudicate what S8 actually verified.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunCtx, makeRunId } from '../src/orchestration/context.js';
import { buildJudgePrompt, s9Judge } from '../src/orchestration/stages/s9-judge.js';
import { claimVerificationRefIssues, selectVerificationEscalations } from '../src/orchestration/stages/s8-verify.js';
import { overlayClaimGroups } from '../src/orchestration/claim-groups.js';
import type { DecisionGraph } from '../src/orchestration/decision-graph.js';
import { buildIdeaRubric } from '../src/workflows/idea-refinement.js';
import { RunWriter } from '../src/storage/runs.js';
import type { ClaimVerificationSet, IntentContract, RebuttalEventSet } from '../src/schemas/index.js';

import fixture from './fixtures/s9-scope-e1ce.json' with { type: 'json' };

const contract = fixture.contract as unknown as IntentContract;
const graph = fixture.graph as unknown as DecisionGraph;
const verifications = fixture.verifications as unknown as ClaimVerificationSet;
const rebuttals = fixture.rebuttals as unknown as RebuttalEventSet;
// exactly what the workflow hands S9
const joined = overlayClaimGroups(graph, verifications.claim_groups);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiki-s9-scope-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** No provider handles: reaching the chair call throws "provider claude not available" — the
 *  sentinel that S9's pre-chair validation PASSED. The old bug threw BAD_OUTPUT before it. */
function chairlessCtx(): RunCtx {
  const writer = new RunWriter(makeRunId('idea-refinement'), root);
  return new RunCtx({
    runId: writer.runId,
    workflow: 'idea-refinement',
    handles: [],
    roles: { analyst: 'claude', judge: 'claude', verifier: 'claude', s4: ['claude'] },
    writer,
    cwd: writer.dir,
    budget: 12,
  });
}

describe('S9 verification scope', () => {
  it('sanity: the overlay really re-ranks the selection on this run (G2 out, G7 in)', () => {
    const before = selectVerificationEscalations(graph).map((item) => item.claim_id);
    const after = selectVerificationEscalations(joined).map((item) => item.claim_id);
    expect(before).toContain('G2');
    expect(after).not.toContain('G2');
    expect(after).toContain('G7');
  });

  it('REPLAY e1ce: a compliant verification set reaches the chair (was: BAD_OUTPUT before it)', async () => {
    const rubric = buildIdeaRubric(contract.domain_dimensions);
    await expect(s9Judge(chairlessCtx(), contract, joined, verifications, rubric, rebuttals))
      .rejects.toThrow(/provider claude not available/); // past validation, died only on the missing handle
  });

  it('chair prompt scope = the verified claims: G2 escalated with its record, G7 stays context', () => {
    const rubric = buildIdeaRubric(contract.domain_dimensions);
    const prompt = buildJudgePrompt(contract, joined, verifications, rubric, rebuttals, 'claude');
    const escalated = prompt.slice(
      prompt.indexOf('ESCALATED CLAIMS + VERIFICATION:'),
      prompt.indexOf('APPEND-ONLY REBUTTAL EVENTS:'),
    );
    expect(escalated).toContain('"id": "G2"'); // verified → the chair rules on it
    expect(escalated).not.toContain('"id": "G7"'); // unverified → context only, no fabricated record
    expect(escalated).not.toContain('No verifier record.');
  });

  it('a verification referencing a claim missing from the graph is still rejected', () => {
    const dangling: ClaimVerificationSet = {
      verifications: [{ ...verifications.verifications[0]!, claim_id: 'G99', evidence_ids: [] , status: 'UNVERIFIABLE'}],
    };
    const issues = claimVerificationRefIssues(joined, dangling, dangling.verifications.map((v) => v.claim_id));
    expect(issues.join('; ')).toContain('unknown claim id: G99');
  });

  it('S8-side contract unchanged: a verification outside the expected selection is flagged', () => {
    const issues = claimVerificationRefIssues(graph, verifications, ['G1']);
    expect(issues.length).toBeGreaterThan(0);
  });
});
