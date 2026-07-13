# Idea v3 protocol benchmark (R8)

Status: **engineering harness ready; no R8 paid comparison has run**.

This is separate from `aiki bench idea-refinement`, which remains the R3 build-only lane-rotation
experiment. R8 uses `aiki bench idea-v3` for the frozen B/C/D2/R protocol comparison.

## Safety and protocol boundaries

- Without `--yes`, the command only validates the set and prints the exact matrix/call ceiling.
- Every completed **or failed** case×arm observation is checkpointed. `--resume` keeps both; it cannot rerun
  away a bad result.
- D2 is build-only and must come from the archived R0 runner at commit `680fba3`; current R code is never
  mislabeled as the old diagnostic arm.
- Holdout is rejected until `bench/idea-v3-protocol.json` pins the selected B/C provider, all three model
  ids, roles, lane order, research mode, and SHA-256 hashes of the benchmark, scorer, harness, rating contract,
  and prompts.
  Any later drift makes the holdout command fail.
- An R run requires all three providers. B and C use the same selected provider and the exact same candidate
  prompt; C adds three independent samples and one same-provider synthesis.

## Build-tuning sequence

First dry-run B once for each provider candidate. Campaign names include the candidate, so paid results do
not overwrite one another:

```sh
aiki bench idea-v3 --set build --arms B --baseline-provider claude
aiki bench idea-v3 --set build --arms B --baseline-provider codex
aiki bench idea-v3 --set build --arms B --baseline-provider agy
```

Only add `--yes` after the user explicitly authorizes the displayed paid calls. Blind-score those three B
campaigns, select the best provider on build only, then resume that provider's campaign for C/D2/R:

```sh
aiki bench idea-v3 --set build --arms C,D2,R --baseline-provider <winner-id> \
  --resume --d2-import <r0-observations.json>
```

The dry-run for all eight cases and all four arms is 32 case×arm observations and at most 184 nominal calls.
Repairs are recorded as attempted calls and do not disappear from cost reporting.

`--d2-import` accepts an array of strict D2 observations. Each contains `case_id`, `arm: "D2"`, `status`,
`run_id`, `report_markdown` (for success), `calls`, `calls_by_provider`, `repair_calls`, `latency_ms`, `flags`,
and `error` (for failure). These values must be produced by the archived R0 execution, including its actual
wall-clock and call receipt.

## Blinded rating packets

After a campaign contains every requested case×arm pair:

```sh
aiki bench idea-v3 --export-blind <output-dir> --campaign <campaign.json>
```

This is offline. It writes three independently ordered `rater-*` directories with the decision input,
pre-written expert claims, false-claim traps, required dimensions, redacted reports, and raw rating JSON
templates. Give a rater only their own directory. Keep `mapping.json` private until all three independent
ratings are locked.

The export refuses incomplete campaigns and fewer than three raters. Provider/model names, run ids, generated
timestamps, and model-role lines are redacted. Raw ratings and their eventual majority resolution remain part
of the benchmark record; the frozen scorer still owns decision-critical insight F1.

After all three rater files are independently locked, create a human-resolved `resolution.json` containing
the private mapping path, the three raw-rating paths, and one `{case_id, arm, adjudication, secondary}` entry
per campaign report. `adjudication` is the frozen `DecisionInsightAdjudication`; `secondary` retains resolved
counts for factual honesty/support, exact citation support, coverage, genuine disagreements, complete/actionable
experiments, and honesty violations. Then import it exactly once:

```sh
aiki bench idea-v3 --import-ratings <resolution.json> --campaign <campaign.json>
```

The importer requires three distinct locked raw files, verifies every blind report id against the private
mapping, refuses changed expert claims or an incomplete/duplicate matrix, computes pairwise preference from
the locked ranks, hashes the raw records, runs the frozen scorer, and refuses re-scoring.

## Holdout

Do not create or inspect a holdout run during build tuning. After build ratings select the baseline and the
protocol file is committed, `aiki bench idea-v3 --set holdout` validates the 12-case sealed set and its frozen
tag coverage before showing the one-pass B/C/R call ceiling. D2 is always refused on holdout.

Create a draft JSON only after the complete 8×B/C/D2/R build campaign is scored:

```json
{
  "build_scores": "bench/results/<build>.scores.json",
  "baseline_provider": "claude",
  "models": { "claude": "<exact>", "codex": "<exact>", "agy": "<exact>" },
  "roles": { "analyst": "agy", "judge": "claude", "verifier": "codex", "s4": ["agy", "codex"] },
  "lane_assignment": "agy-market"
}
```

Then freeze once:

```sh
aiki bench idea-v3 --freeze-protocol <draft.json>
```

The command refuses any missing/unscored pair, provider mismatch, lane/seat mismatch, non-build input, or
existing freeze file. It computes the hashes and writes `bench/idea-v3-protocol.json`; commit that file before
the holdout run.

After the one holdout campaign is scored, publish the deterministic full gate report:

```sh
aiki bench idea-v3 --publish-results <holdout-campaign.scores.json>
```

This writes `RESULTS-IDEA-V3.md` with both primary F1 comparisons, every secondary/operational gate, all cases,
all failures, per-provider calls, repairs, latency, and raw-rating hashes. A secondary win cannot rescue either
primary loss; the negative-result language is selected from the frozen policy.
