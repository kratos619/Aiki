import {
  IdeaRoleOutput,
  LegacyIdeaRoleOutput,
  type DecisionGraph,
  type DisagreementMap,
  type IdeaRoleOutput as IdeaRoleOutputT,
} from '../schemas/index.js';

/** Read old assumption/attack artifacts without treating an assumption or self-attack as a stance. */
export function adaptIdeaOutput(input: unknown): IdeaRoleOutputT {
  const current = IdeaRoleOutput.safeParse(input);
  if (current.success) return current.data;

  const legacy = LegacyIdeaRoleOutput.parse(input);
  const positions = legacy.assumptions.map((assumption) => ({
    local_id: assumption.id,
    proposition: assumption.statement,
    dimension_id: 'R12',
    stance: 'UNKNOWN' as const,
    basis: 'ASSUMPTION' as const,
    load_bearing: assumption.load_bearing,
    if_false: assumption.load_bearing ? 'STOP' as const : 'MINOR' as const,
    reasoning: `Legacy ${assumption.type.toLowerCase()} assumption; no stance or evidence was recorded.`,
    evidence_ids: [],
    depends_on: [],
  }));
  const assumptionIds = new Set(positions.map((position) => position.local_id));
  const decision_questions = [
    ...legacy.open_questions.map((question, index) => ({ id: `Q${index + 1}`, question, claim_ids: [] })),
    ...legacy.attacks.map((attack) => ({
      id: attack.id,
      question: attack.argument,
      claim_ids: assumptionIds.has(attack.target_assumption) ? [attack.target_assumption] : [],
    })),
  ];

  return IdeaRoleOutput.parse({
    workflow: 'idea-refinement',
    task_echo: legacy.task_echo,
    strongest_version: legacy.strongest_version,
    positions,
    evidence: [],
    coverage: positions.length > 0
      ? [{ dimension_id: 'R12', status: 'COVERED', position_ids: positions.map((position) => position.local_id), rationale: 'Migrated legacy assumptions.' }]
      : [],
    decision_questions,
  });
}

/** Convert pre-R2 disagreement artifacts for read-only display/regression compatibility. */
export function adaptLegacyDecisionGraph(map: DisagreementMap): DecisionGraph {
  const contradictionByClaim = new Map(map.contradictions.flatMap((item) => item.claim_ids.map((id) => [id, item] as const)));
  const claims = [...map.consensus, ...map.unique].map((legacy) => {
    const dispute = contradictionByClaim.get(legacy.id);
    const supporting = legacy.providers.map((provider) => ({
      id: `${provider}/${legacy.id}`,
      provider,
      source_id: provider,
      local_id: legacy.id,
      proposition: legacy.statement,
      dimension_id: 'R12',
      stance: 'SUPPORT' as const,
      basis: 'ASSUMPTION' as const,
      nature: 'JUDGMENT' as const,
      load_bearing: false,
      if_false: 'MINOR' as const,
      reasoning: 'Migrated legacy assumption.',
      evidence_ids: [],
      depends_on: [],
    }));
    const opposing = (dispute?.attacks ?? []).map((attack, index) => ({
      id: `${attack.provider}/${dispute!.id}-X${index + 1}`,
      provider: attack.provider,
      source_id: attack.provider,
      local_id: `${dispute!.id}-X${index + 1}`,
      proposition: legacy.statement,
      dimension_id: 'R12',
      stance: 'OPPOSE' as const,
      basis: 'ASSUMPTION' as const,
      nature: 'JUDGMENT' as const,
      load_bearing: false,
      if_false: 'MINOR' as const,
      reasoning: attack.argument,
      evidence_ids: [],
      depends_on: [],
    }));
    return {
      claim: {
        id: dispute?.id ?? legacy.id,
        proposition: legacy.statement,
        position_ids: [...supporting, ...opposing].map((position) => position.id),
        state: dispute ? 'DISAGREEMENT' as const : legacy.providers.length >= 2 ? 'CONSENSUS' as const : 'UNIQUE' as const,
        evidence_state: 'UNVERIFIED' as const,
        nature: 'JUDGMENT' as const,
        load_bearing: false,
        if_false: 'MINOR' as const,
        sensitivity: 'LOW' as const,
      },
      positions: [...supporting, ...opposing],
    };
  });
  return {
    positions: claims.flatMap((item) => item.positions),
    evidence: [],
    calculations: [],
    calculation_checks: [],
    claims: claims.map((item) => item.claim),
    edges: [],
    holes: {
      coverage: map.blind_spots.map((label) => ({ dimension_id: label, label })),
      evidence: [],
    },
  };
}
