// S2 — misunderstanding prediction (§9, §13). ALL available providers, in parallel, each state how
// they read the task + plausible misreadings. A deterministic comparator (cluster.ts) groups the
// restatements; one cluster → proceed, multiple → headless picks the majority (logged). The
// clustering — not a model — decides what the task "is" (§19).
//
// Quorum (§9 S2): a provider that fails is dropped; <2 survivors → run-fatal QUORUM abort.
// A run-fatal error inside the fan-out (budget/deadline/abort) propagates unchanged.

import type { IntentContract, Interpretation } from '../../schemas/index.js';
import { Interpretation as InterpretationSchema } from '../../schemas/index.js';
import type { ProviderId } from '../../providers/types.js';
import { isFatal, StageError, type RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';
import { clusterInterpretations, majorityClusterIndex, type Cluster } from '../cluster.js';

const S2_PROMPT = `A task will be given to several AI models. Your job is ONLY to state how you read it
and how it could be misread. Output ONLY JSON:

{"my_interpretation": "<one sentence: what you believe the user wants>",
 "plausible_misreadings": ["<misreading 1>", "<misreading 2>"]}

TASK CONTRACT:
{{INTENT_CONTRACT_JSON}}
ORIGINAL TEXT:
{{RAW_INPUT}}`;

/** The S2 composite artifact (02-misunderstanding-guard.json, §15). No T4 core schema — written
 *  as-is; shaped here. Holds every interpretation, the clusters, the chosen one, and how chosen. */
export interface MisunderstandingGuard {
  interpretations: Array<{ provider: ProviderId } & Interpretation>;
  clusters: Cluster[];
  chosen: { my_interpretation: string; cluster_index: number; how: 'single-cluster' | 'majority-cluster' };
  dropped: Array<{ provider: ProviderId; error: string }>;
}

export async function s2Misread(ctx: RunCtx, contract: IntentContract, rawInput: string): Promise<MisunderstandingGuard> {
  const contractJson = JSON.stringify(contract);
  const prompt = S2_PROMPT.replace('{{INTENT_CONTRACT_JSON}}', contractJson).replace('{{RAW_INPUT}}', rawInput);
  const providers = ctx.available();

  const settled = await Promise.allSettled(
    providers.map(async (id) => ({ id, interp: await jsonCall(ctx, ctx.handle(id), `S2-${id}`, prompt, InterpretationSchema) })),
  );

  const interpretations: MisunderstandingGuard['interpretations'] = [];
  const dropped: MisunderstandingGuard['dropped'] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    const id = providers[i]!;
    if (r.status === 'fulfilled') interpretations.push({ provider: id, ...r.value.interp });
    else if (isFatal(r.reason)) throw r.reason; // budget/deadline/abort → abort the whole run
    else dropped.push({ provider: id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  }

  if (interpretations.length < 2) {
    throw new StageError('S2', 'QUORUM', `only ${interpretations.length} interpretation(s) survived; need ≥2`);
  }

  const clusters = clusterInterpretations(interpretations.map((x) => ({ key: x.provider, text: x.my_interpretation })));
  const idx = majorityClusterIndex(clusters);
  const chosen = {
    my_interpretation: clusters[idx]!.representative,
    cluster_index: idx,
    how: (clusters.length === 1 ? 'single-cluster' : 'majority-cluster') as 'single-cluster' | 'majority-cluster',
  };

  const guard: MisunderstandingGuard = { interpretations, clusters, chosen, dropped };
  await ctx.writer.writeJson('misunderstanding-guard', guard);
  return guard;
}
