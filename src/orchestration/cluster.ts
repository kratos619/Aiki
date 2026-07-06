// Deterministic restatement clustering for S2 (§9). Groups per-provider interpretations by
// normalized token overlap; a threshold ≥ 0.6 puts two restatements in the same cluster. Pure
// code (no model call) → directly unit-tested. This — not a model — decides whether the providers
// agree on what the task is (§19 "deterministic validators decide what enters downstream").
//
// The overlap metric is the OVERLAP COEFFICIENT (|A∩B|/min), not Jaccard. §9 says "normalized token
// overlap ≥ 0.6"; Jaccard was too strict on real prose — two same-meaning 1-sentence readings scored
// right at ~0.60 and split, spuriously triggering the S2 clarification (observed live at T8). The
// coefficient isn't penalized by length/filler differences: the two same-meaning readings score 0.76,
// a genuine divergence scores ~0.50 — so real disagreement still clusters apart. (Fixed 2026-07-03.)

export const SAME_CLUSTER_THRESHOLD = 0.6; // §9

// Function words + restatement boilerplate ("the user is asking to…") carry no meaning about WHAT the
// task is; keeping them dilutes the content-word overlap so two same-meaning readings that phrase the
// framing differently split spuriously (V7). Dropping them makes the coefficient compare content only.
// This does NOT loosen the 0.6 threshold — genuinely different readings still have disjoint content
// words and split (see cluster.test). Deliberately conservative: no stemming (would risk false merges).
const STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'without',
  'from', 'into', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'their', 'them', 'they', 'i', 'you', 'we', 'he', 'she', 'his', 'her', 'our', 'your',
  'my', 'me', 'us', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'if', 'then', 'than',
  'so', 'such', 'not', 'no', 'over', 'under', 'about', 'up', 'down', 'out', 'how', 'what', 'which',
  // restatement framing verbs/nouns
  'user', 'users', 'wants', 'want', 'wanting', 'asking', 'asks', 'ask', 'request', 'requesting', 'needs',
  'need', 'wishes', 'wish', 'seeking', 'looking', 'like',
]);

/** Lowercase, split on non-alphanumerics, drop empties + stopwords. Overlap is on the resulting SET. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
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

/**
 * Overlap coefficient of two token sets: |A∩B| / min(|A|,|B|). 0 when either is empty. Unlike
 * Jaccard, it is not penalized when one text is much longer than the other — the right measure for
 * "is this short restatement a subset of this longer text" (S5 drift: task_echo vs contract.task).
 */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
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
    const home = clusters.find((c) => overlapCoefficient(tokens, c.repTokens) >= threshold);
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
