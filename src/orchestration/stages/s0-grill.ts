// S0 - contextual grill / intent preflight. One cheap front-loaded model call generates
// 3-4 context-specific questions; interactive surfaces answer them before the full council runs.

import { RunBrief, RunBriefDraft, type GrillAnswer, type RunBrief as RunBriefT, type RunBriefDraft as RunBriefDraftT } from '../../schemas/index.js';
import type { RunCtx } from '../context.js';
import { jsonCall } from '../jsonStage.js';

const S0_PROMPT = `You are the intent preflight analyst for aiki, a professional multi-model council.
Read the user's idea below. Do not evaluate the idea yet. Instead, produce a concise run brief and
exactly 3 or 4 context-specific questions that would materially improve the later council's verdict.

Output ONLY JSON matching this shape:
{
  "subject": "<short subject>",
  "decision_frame": "<what decision the user seems to need, or null>",
  "evaluation_lens": "<lens the council should use, or null>",
  "target_user": "<target user stated or implied, or null>",
  "constraints": ["<explicit constraints>"],
  "claims_to_test": ["<load-bearing claims worth testing>"],
  "evidence_supplied": ["<evidence or proof already supplied>"],
  "missing_axes": ["<important missing context>"],
  "questions": [
    {
      "id": "Q1",
      "axis": "decision_frame|evaluation_lens|target_user|success_bar|non_negotiables|risk_context|evidence|alternatives|scope",
      "question": "<one direct question>",
      "why_it_matters": "<one sentence>",
      "suggested_answers": ["<2-5 short options>"]
    }
  ]
}

Rules:
- Ask only questions whose answers could change the analysis or verdict.
- Make the questions specific to this idea, not generic startup intake.
- Prefer decision frame, target user, success bar, constraints, evidence, and risk context.
- Do not ask more than 4 questions.

USER IDEA:
{{RAW_INPUT}}`;

export function defaultGrillAnswers(brief: RunBriefDraftT): GrillAnswer[] {
  return brief.questions.map((q) => ({
    question_id: q.id,
    answer: 'Use best judgment from the supplied prompt.',
    source: 'default',
  }));
}

function normalizeAnswers(brief: RunBriefDraftT, answers: GrillAnswer[] | undefined): GrillAnswer[] {
  const byQuestion = new Map((answers ?? []).map((a) => [a.question_id, a]));
  return brief.questions.map((q) => {
    const found = byQuestion.get(q.id);
    const answer = found?.answer.trim();
    if (found && answer) return { question_id: q.id, answer, source: found.source };
    return { question_id: q.id, answer: 'Use best judgment from the supplied prompt.', source: 'default' };
  });
}

export async function s0Grill(ctx: RunCtx, rawInput: string): Promise<RunBriefT> {
  const analyst = ctx.handle(ctx.roles.analyst);
  const draft = await jsonCall(ctx, analyst, 'S0', S0_PROMPT.replace('{{RAW_INPUT}}', rawInput), RunBriefDraft);
  const answers = normalizeAnswers(draft, ctx.events?.grill ? await ctx.events.grill(draft) : defaultGrillAnswers(draft));
  const brief = RunBrief.parse({ ...draft, answers });
  await ctx.writer.writeJson('run-brief', brief);
  return brief;
}

export function renderGrilledInput(rawInput: string, brief: RunBriefT): string {
  const sections = [
    `Subject: ${brief.subject}`,
    brief.decision_frame ? `Decision frame: ${brief.decision_frame}` : null,
    brief.evaluation_lens ? `Evaluation lens: ${brief.evaluation_lens}` : null,
    brief.target_user ? `Target user: ${brief.target_user}` : null,
    brief.constraints.length ? `Constraints: ${brief.constraints.join('; ')}` : null,
    brief.claims_to_test.length ? `Claims to test: ${brief.claims_to_test.join('; ')}` : null,
    brief.evidence_supplied.length ? `Evidence supplied: ${brief.evidence_supplied.join('; ')}` : null,
    brief.missing_axes.length ? `Missing context: ${brief.missing_axes.join('; ')}` : null,
  ].filter((line): line is string => line !== null);

  const answers = brief.questions.map((q) => {
    const answer = brief.answers.find((a) => a.question_id === q.id);
    return `- ${q.question}\n  Answer: ${answer?.answer ?? 'Use best judgment from the supplied prompt.'}`;
  });

  return `${rawInput.trim()}\n\n---\nAiki intent preflight\n${sections.join('\n')}\n\nAnswers:\n${answers.join('\n')}\n`;
}
