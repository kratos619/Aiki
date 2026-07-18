// v6 evidence origin honesty (plan/AIKI-v6-council-integrity-plan.md T7). Run f740's coverage
// numbers counted the user's own idea-brief as evidence (8 of 12 cards, some marked VERIFIED) —
// circular. Origin is derived, never trusted from labels alone: EXTERNAL requires BOTH an
// external source_kind AND a public http(s) locator, so a mislabeled local file stays humble.

export type EvidenceOrigin = 'EXTERNAL' | 'USER_MATERIAL' | 'MODEL_KNOWLEDGE';

/** Accepts graph-card shape (`source_kind`/`locator`/`url`) and dossier-row shape
 *  (`sourceKind`/`source`/`url`). Defaults toward USER_MATERIAL — the humbler label. */
export function evidenceOrigin(card: {
  source_kind?: string;
  sourceKind?: string;
  url?: string;
  locator?: string;
  source?: string;
}): EvidenceOrigin {
  const kind = card.source_kind ?? card.sourceKind;
  if (kind === 'MODEL_KNOWLEDGE') return 'MODEL_KNOWLEDGE';
  if (kind === 'PRIMARY' || kind === 'SECONDARY') {
    const locator = card.url ?? card.locator ?? card.source ?? '';
    if (/^https?:\/\//i.test(locator.trim())) return 'EXTERNAL';
  }
  return 'USER_MATERIAL';
}
