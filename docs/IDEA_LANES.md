# Idea lane assignment

Status: **provisional — build rotation not yet run**.

The runtime assigns the first configured S4 seat to `market-adoption` and the second to
`economics-delivery`. With current default roles that means Gemini is first and Codex second, but the
mapping is based on seat order, not an assumed provider strength; role overrides can swap the seats.

Before freezing the v3 default, run both assignments on every sanitized idea build case:

- `agy-market`: Gemini market/adoption, Codex economics/delivery;
- `codex-market`: Codex market/adoption, Gemini economics/delivery.

Dry-run the matrix with `aiki bench idea-refinement --set build`. It reports the maximum provider-call
cost and makes no model calls. Only `--yes` executes the four council runs.

`planIdeaLaneBench` produces the complete build matrix without model calls. `runIdeaLaneBench` records
run IDs, JSON repair rate, latency, and per-provider unique supported contributions. After blind claim
adjudication, `scoreLaneObservation` fills recall and evidence-aware precision through the frozen R0 scorer.
`chooseLaneDefault` ranks recall first, then evidence
precision, unique contribution, repair rate, and latency. It returns no winner for incomplete data or an
exact tie.

No valid rotation results exist yet, so this document does not claim that either provider is better in a
lane. The default must be updated and frozen here only after the user-authorized metered build run and blind
scoring are complete.
