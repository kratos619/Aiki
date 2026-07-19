# Aiki hackathon demo — 2:45 target

Prepare before recording: three provider chips green, `README.md` ready to attach, and one completed council
thread available for the follow-up. Never show provider credentials or local paths.

| Time | Show | Say |
|---|---|---|
| 0:00–0:18 | Open the [hosted replay](https://kratos619.github.io/Aiki/); start replay. | "Aiki is a local model council, not another hosted model. This is a recorded real run, so judges can inspect it without installing anything and no models are running in this page." |
| 0:18–0:32 | Terminal: `npm i -g aiki-cli && aiki serve`; browser opens. | "For the live product, one npm command opens a loopback-only workspace. Aiki uses the Claude, Codex, and Gemini CLIs already installed on this machine—no API keys." |
| 0:32–0:42 | Point to the three green provider chips and role roster. | "The provider preflight is visible before spend. Roles are explicit: independent scouts, verifier, and chair." |
| 0:42–1:02 | New decision; enter: **Should Aiki ship this local council workspace as the hackathon product? Give the smallest credible scope, top risks, and a two-day build plan.** Attach `README.md`; choose Full Council; Convene. | "Every assistant decision turn goes through Aiki's existing structured council. Local material is attached deliberately." |
| 1:02–1:22 | On the file card, choose **Allow once**. On the spend card, choose **Allow once**. | "Aiki—not a provider shell—enforces file and model-spend approval on the server. Denying spend means zero model calls." |
| 1:22–1:48 | Watch the Council Deck: stages, seats, calls, replay/repair counters, and budget. | "Claude, Codex, and Gemini work through read-only adapters. The deck shows who is running, what stage is active, and how much of the bounded call budget is used." |
| 1:48–2:12 | Open the verdict card and one disclosure; point to warnings, next step, and receipt. | "The answer leads with the decision, caveats, and next action. The full audit remains available without dumping raw prompts, chain-of-thought, or local paths into the browser." |
| 2:12–2:29 | Ask: **What single failure would make you reverse this recommendation?** | "A follow-up is one read-only responder call and is honestly labeled 'no council.' Re-convene is available when the question deserves the full council again." |
| 2:29–2:45 | Open Settings; show model fields and Judge, Verifier, Analyst, two council seats, and Follow-up responder. | "Models and role-to-provider mapping are configurable per project. Aiki stores no API keys and exposes no arbitrary command surface." |

If a live provider fails, do not hide it: show the amber/red chip, then use the hosted replay and say it is the
explicit fallback. Keep the final video under three minutes; trim model waiting time, not permission or honesty
labels.
