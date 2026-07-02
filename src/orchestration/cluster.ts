// Deterministic restatement clustering for S2 (§9). Groups per-provider interpretations by
// normalized token overlap; a threshold ≥ 0.6 puts two restatements in the same cluster. Pure
// code (no model call) → directly unit-tested. This — not a model — decides whether the providers
// agree on what the task is (§19 "deterministic validators decide what enters downstream").

export const SAME_CLUSTER_THRESHOLD = 0.6; // §9

/** Lowercase, split on non-alphanumerics, drop empties. Overlap is on the resulting token SET. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard overlap of two token sets: |A∩B| / |A∪B|. 0 when both empty. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ClusterItem {
  key: string; // stable label (e.g. provider id)
  text: string; // the restatement
}

export interface Cluster {
  members: string[]; // item keys
  representative: string; // the first member's text (deterministic: input order)
}

/**
 * Single-link clustering: an item joins the first existing cluster whose representative it overlaps
 * with ≥ threshold, else it starts a new cluster. Input order is preserved → deterministic output.
 */
export function clusterInterpretations(items: ClusterItem[], threshold = SAME_CLUSTER_THRESHOLD): Cluster[] {
  const clusters: { members: string[]; representative: string; repTokens: Set<string> }[] = [];
  for (const item of items) {
    const tokens = tokenize(item.text);
    const home = clusters.find((c) => overlap(tokens, c.repTokens) >= threshold);
    if (home) home.members.push(item.key);
    else clusters.push({ members: [item.key], representative: item.text, repTokens: tokens });
  }
  return clusters.map((c) => ({ members: c.members, representative: c.representative }));
}

/** Index of the largest cluster (ties → earliest). Used by headless S2 to pick the majority. */
export function majorityClusterIndex(clusters: Cluster[]): number {
  let best = 0;
  for (let i = 1; i < clusters.length; i++) {
    if (clusters[i]!.members.length > clusters[best]!.members.length) best = i;
  }
  return best;
}
