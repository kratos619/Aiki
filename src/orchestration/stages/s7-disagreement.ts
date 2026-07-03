// S7 — disagreement map (§7, §9). Folds the ClaimSet into the four buckets (§9): consensus (a claim
// ≥2 analysts asserted), unique (exactly one analyst), contradictions (a claim that was attacked —
// the dispute the S8 verifier examines), and blind_spots (rubric coverage items no analyst touched,
// §12.1). Empty contradictions is legal but suspicious → run flagged `low_diversity` (§9).
//
// T7: S7 is no longer pure — it makes ONE constrained model call first (the "cheap call" the plan
// budgets in S5–S7, §248) to establish SEMANTIC consensus, which lexical S6 dedup provably can't
// (see STATE decided-facts). The call runs on the judge role, sees IDs + statements with attribution
// WITHHELD, and returns ONLY groupings of existing IDs — validated by-reference, so it groups but
// never rewrites (anti-blending). On any failure it falls back to the lexical map: enrichment, not
// critical path, so S7 still "cannot fail" in the sense of always producing a valid map.

import type { Claim, Contradiction, DisagreementMap } from '../../schemas/index.js';
import { ClaimGroups } from '../../schemas/index.js';
import { isFatal, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { tokenize } from '../cluster.js';
import type { SeatOutput } from './s4-analyze.js';
import type { ClaimAttack, ClaimSet } from './s6-claims.js';

/** One idea-vetting coverage item (§12.1 rubric). `keywords` are matched deterministically against
 *  the analysts' text: an item is covered iff, for at least one keyword, every token of that keyword
 *  appears somewhere in the corpus. */
export interface RubricItem {
  id: string;
  label: string;
  keywords: string[];
}

/** Pure map-building core (no ctx, no I/O) — the fixture-testable heart of S7 (§24 T6). */
export function buildDisagreementMap(
  claimSet: ClaimSet,
  seats: SeatOutput[],
  rubric: RubricItem[],
): DisagreementMap {
  const consensus: Claim[] = [];
  const unique: Claim[] = [];
  for (const c of claimSet.claims) (c.providers.length >= 2 ? consensus : unique).push(c);

  // Contradictions: group the re-anchored attacks by contested claim; each becomes one dispute
  // (id "D1"...) carrying its attacks — exactly the {disputed item + evidence} S8 consumes (§9 S8).
  const byClaim = new Map<string, ClaimAttack[]>();
  for (const atk of claimSet.attacks) {
    const arr = byClaim.get(atk.claim_id);
    if (arr) arr.push(atk);
    else byClaim.set(atk.claim_id, [atk]);
  }
  const contradictions: Contradiction[] = [];
  let d = 0;
  for (const [claim_id, atks] of byClaim) {
    contradictions.push({
      id: `D${++d}`,
      claim_ids: [claim_id],
      attacks: atks.map((a) => ({ provider: a.provider, argument: a.argument, severity: a.severity })),
    });
  }

  // Blind spots: rubric items whose keywords appear nowhere in the analysts' output text.
  const corpus = new Set<string>();
  for (const seat of seats) {
    const texts = [
      seat.output.task_echo,
      seat.output.strongest_version,
      ...seat.output.assumptions.map((a) => a.statement),
      ...seat.output.attacks.map((a) => a.argument),
      ...seat.output.open_questions,
    ];
    for (const t of texts) for (const tok of tokenize(t)) corpus.add(tok);
  }
  const covered = (item: RubricItem) =>
    item.keywords.some((kw) => [...tokenize(kw)].every((tok) => corpus.has(tok)));
  const blind_spots = rubric.filter((item) => !covered(item)).map((item) => item.label);

  return { consensus, contradictions, unique, blind_spots };
}

// ── semantic grouping (the S7 model call) ───────────────────────────────────

const S7_GROUP_PROMPT = `You are grouping claims that state the SAME underlying idea, to detect consensus.
Below are claims, each with an ID and text. Group the IDs that make essentially the same claim (the
same assertion, even if worded differently). Do NOT group claims that are merely related or on the
same topic — only true restatements of the same point.

Output ONLY JSON: {"groups": [["<id>","<id>", ...], ...]}
- Each group = 2+ IDs that are the same claim. Omit any claim that stands alone.
- Use ONLY the IDs shown below. Do NOT include claim text. If nothing matches, output {"groups": []}.

CLAIMS:
{{CLAIMS_JSON}}`;

/** Numeric order of a claim id ("C2" < "C10"), for picking the canonical (lowest) member. */
const claimNum = (id: string): number => parseInt(id.replace(/^C/, ''), 10) || 0;

/** Pure: fold semantically-equal claims (per validated `groups` of ids) into their lowest-id member —
 *  canonical statement kept VERBATIM, providers unioned, attacks re-anchored. No input mutation. */
export function applyGroups(claimSet: ClaimSet, groups: string[][]): ClaimSet {
  const claims = claimSet.claims.map((c) => ({ ...c, providers: [...c.providers] }));
  const byId = new Map(claims.map((c) => [c.id, c]));
  const remap = new Map<string, string>(); // absorbed id → canonical id
  for (const group of groups) {
    const ids = group.filter((id) => byId.has(id) && !remap.has(id));
    if (ids.length < 2) continue;
    const canonical = ids.slice().sort((a, b) => claimNum(a) - claimNum(b))[0]!;
    const canon = byId.get(canonical)!;
    for (const id of ids) {
      if (id === canonical) continue;
      for (const p of byId.get(id)!.providers) if (!canon.providers.includes(p)) canon.providers.push(p);
      remap.set(id, canonical);
    }
  }
  return {
    claims: claims.filter((c) => !remap.has(c.id)),
    attacks: claimSet.attacks.map((a) => (remap.has(a.claim_id) ? { ...a, claim_id: remap.get(a.claim_id)! } : a)),
  };
}

/** The S7 model call: ask the judge role which claims are the same, validate the groups purely
 *  by-reference, and apply them. Any non-fatal failure → the lexical claimSet unchanged (fallback). */
async function s7SemanticGroup(ctx: RunCtx, claimSet: ClaimSet): Promise<ClaimSet> {
  if (claimSet.claims.length < 2) return claimSet; // nothing to group → skip the call
  const anon = claimSet.claims.map((c) => ({ id: c.id, statement: c.statement })); // attribution withheld
  const prompt = S7_GROUP_PROMPT.replace('{{CLAIMS_JSON}}', JSON.stringify(anon, null, 2));
  try {
    const { groups } = await jsonCall(ctx, ctx.handle(ctx.roles.judge), 'S7-group', prompt, ClaimGroups);
    // Validate by-reference: every id must exist and appear in at most one group.
    const ids = new Set(claimSet.claims.map((c) => c.id));
    const used = new Set<string>();
    const valid: string[][] = [];
    for (const g of groups) {
      if (g.length >= 2 && g.every((id) => ids.has(id) && !used.has(id))) {
        for (const id of g) used.add(id);
        valid.push(g);
      }
    }
    return applyGroups(claimSet, valid);
  } catch (e) {
    if (isFatal(e)) throw e; // budget/deadline/abort → abort the run
    return claimSet; // bad output / provider down → graceful fallback to the lexical map
  }
}

export async function s7Disagreement(
  ctx: RunCtx,
  claimSet: ClaimSet,
  seats: SeatOutput[],
  rubric: RubricItem[],
): Promise<DisagreementMap> {
  const grouped = await s7SemanticGroup(ctx, claimSet);
  const map = buildDisagreementMap(grouped, seats, rubric);
  await ctx.writer.writeJson('disagreement-map', map);
  if (map.contradictions.length === 0) ctx.addFlag('low_diversity'); // §9: empty → suspicious
  return map;
}
