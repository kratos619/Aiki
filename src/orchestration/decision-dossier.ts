import type { DecisionReportJson } from './stages/s10-render.js';
import { DISPLAY_NAME, type ProviderId } from '../providers/types.js';

function cell(value: string): string {
  return value.replaceAll('\n', ' ').replaceAll('|', '\\|');
}

function refs(ids: string[]): string {
  return ids.length ? ids.map((id) => `\`${id}\``).join(', ') : 'none recorded';
}

function clipClaim(text: string, max = 96): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > max * 0.65 ? boundary : max - 1).trimEnd()}…`;
}

/** Human-readable labels for reader-facing evidence links. Raw ids stay in the technical audit/JSON. */
export function readerClaimLabel(report: DecisionReportJson, id: string): string {
  const claim = report.claims.find((item) => item.id === id);
  if (claim) return clipClaim(claim.text);
  return /^G\d+$/.test(id) ? 'Supporting claim' : clipClaim(stripReaderClaimIds(id));
}

export function readerClaimRefs(report: DecisionReportJson, ids: string[]): string {
  return ids.length ? ids.map((id) => readerClaimLabel(report, id)).join('; ') : 'none recorded';
}

/** Remove internal graph notation from prose without expanding a short id into a paragraph. */
export function stripReaderClaimIds(text: string): string {
  return text
    .replace(/\s*\((?:\s*`?G\d+`?\s*,?)+\s*\)/g, '')
    .replace(/\bG\d+\s+assumes\b/g, 'This assumes')
    .replace(/\bG\d+\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function providerName(id: string): string {
  return id in DISPLAY_NAME ? DISPLAY_NAME[id as ProviderId] : id;
}

function degradation(report: DecisionReportJson, flags: string[]): string[] {
  const active = flags.filter((flag) => report.flags.includes(flag));
  return active.length ? [`> ⚠ DEGRADED: ${active.join(', ')}`, ''] : [];
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function coverageLabel(value: number): 'High' | 'Medium' | 'Low' {
  return value >= 0.75 ? 'High' : value >= 0.5 ? 'Medium' : 'Low';
}

function councilRead(report: DecisionReportJson): string {
  if (report.mode === 'quick') return 'One structured analyst produced this result; no council, consensus, or independent-verification claim is being made.';
  const scouts = report.models.filter((model) => model.roles.includes('scout')).length;
  if (report.disagreements.length === 0) {
    return `${scouts || 'The'} independent scout ${scouts === 1 ? 'analysis produced' : 'analyses produced'} no genuine opposing claim; the chair had less contested material to resolve.`;
  }
  const resolved = report.disagreements.filter((item) => item.status === 'RESOLVED').length;
  return `${report.disagreements.length} genuine disagreement${report.disagreements.length === 1 ? '' : 's'} reached the chair; ${resolved} ${resolved === 1 ? 'was' : 'were'} resolved.`;
}

/** Canonical R7 Markdown. HTML and Copy-Markdown consume the same persisted dossier object. */
export function renderDecisionDossierMarkdown(report: DecisionReportJson): string {
  const { dossier } = report;
  const keyFindings = report.keyFindings?.length ? report.keyFindings : [dossier.recommendation.reason];
  const criticalUnknowns = report.criticalUnknowns?.length ? report.criticalUnknowns : report.openQuestions.slice(0, 3);
  const coverage = report.confidenceBreakdown.verificationCoverage;
  const L: string[] = [report.mode === 'quick' ? '# Single-Model Decision Report' : '# Multi-Model Decision Report', ''];

  L.push('## 1. Decision', '', ...degradation(report, ['synthesis_suspect']));
  if (report.decisionSnapshot) {
    L.push('### Decisive numbers', '', '| Metric | Value | What it means | Evidence |', '|---|---:|---|---|');
    for (const item of report.decisionSnapshot.decisiveNumbers) {
      L.push(`| ${cell(item.label)} | ${cell(item.value)} | ${cell(item.meaning)} | ${cell(readerClaimRefs(report, item.claimIds))} |`);
    }
    if (report.decisionSnapshot.payback) {
      const payback = report.decisionSnapshot.payback;
      L.push('', `**Payback — ${payback.status.replaceAll('_', ' ')}:** ${payback.result}`);
      L.push(`Basis: ${payback.basis}`, '');
    } else L.push('');
  }
  L.push(`**Recommendation:** ${dossier.recommendation.summary}`, '');
  L.push(`**Evidence coverage:** ${coverageLabel(coverage)} — ${pct(coverage)} of load-bearing claims independently verified.`);
  L.push(coverage < 0.5
    ? '> Low coverage means important inputs remain unchecked; it is not a probability that the recommendation is correct.'
    : '> Evidence coverage measures independent checking; it is not a probability that the recommendation is correct.', '');
  if (!report.decisionSnapshot) {
    L.push('### Decisive findings', '');
    for (const finding of keyFindings.slice(0, 3)) L.push(`- ${finding}`);
  }
  L.push('', '### Do this first', '', dossier.experiments.actions[0]?.action ?? 'No executable next step was produced.', '');
  if (report.decisionSnapshot) {
    L.push('### Options at a glance', '', '| Path | Commitment | Basis | Trade-off | Evidence |', '|---|---:|---|---|---|');
    for (const option of report.decisionSnapshot.options) {
      L.push(`| ${cell(option.label)} | ${cell(option.commitment)} | ${option.commitmentKind.replace('_', ' ')} | ${cell(option.tradeoff)} | ${cell(readerClaimRefs(report, option.claimIds))} |`);
    }
    if (report.decisionSnapshot.tripwire) {
      const tripwire = report.decisionSnapshot.tripwire;
      L.push('', '### Go/no-go tripwire', '', `**${tripwire.metric}: ${tripwire.threshold}** — ${tripwire.decisionRule}`, '');
    }
  }
  L.push('### What could overturn this', '', dossier.counterCase.available ? dossier.counterCase.reasoning : dossier.counterCase.reasoning, '');
  L.push('### Critical unknowns', '');
  if (criticalUnknowns.length) for (const unknown of criticalUnknowns) L.push(`- ${unknown}`);
  else L.push('- None recorded.');
  L.push('', `**Critical warning:** ${report.verdict.criticalWarning ?? 'None recorded.'}`);
  L.push(`**Council read:** ${councilRead(report)}`);
  L.push(`Evidence behind the recommendation: ${readerClaimRefs(report, dossier.recommendation.claimIds)}`, '');
  if (!dossier.recommendation.claimIds.length) L.push('> ⚠ DEGRADED: recommendation has no stored graph anchor.', '');
  L.push('<details>', '<summary>Decision conditions and technical confidence</summary>', '');
  L.push(`- Decision state: ${dossier.recommendation.status}`);
  L.push(`- Structural score: ${report.confidenceBreakdown.score}/100 (${report.confidenceBreakdown.label}); heuristic, not benchmark-calibrated.`);
  L.push(`- Basis: verification ${pct(coverage)} · independent convergence ${pct(report.confidenceBreakdown.independentConvergence)} · evidence quality ${pct(report.confidenceBreakdown.evidenceQuality)} · stability ${pct(report.confidenceBreakdown.stability)} · critical-risk penalty −${report.confidenceBreakdown.criticalRiskPenalty}`);
  if (dossier.recommendation.conditions.length) {
    L.push('', 'Conditions:');
    for (const condition of dossier.recommendation.conditions) {
      L.push(`- ${condition.text}`);
    }
  }
  L.push('', '</details>', '');

  L.push('## 2. Action plan', '', ...degradation(report, ['plan_fallback', 'plan_skipped']));
  if ((dossier.missingRequestedOutputs ?? []).length) {
    L.push(`> ⚠ DEGRADED: requested output missing: ${dossier.missingRequestedOutputs.join(', ')}`, '');
  }
  if (dossier.featureBacklog) {
    L.push('### Feature priorities', '', '| Priority | Feature | User value | Why now | Effort |', '|---|---|---|---|---|');
    for (const [priority, items] of [
      ['MUST', dossier.featureBacklog.must],
      ['SHOULD', dossier.featureBacklog.should],
      ['LATER', dossier.featureBacklog.later],
    ] as const) {
      for (const item of items) L.push(`| ${priority} | ${cell(item.feature)} | ${cell(item.user_value)} | ${cell(item.rationale)} | ${item.effort} |`);
    }
    if (dossier.featureBacklog.wont.length) {
      L.push('', '**Not in this scope**', '', '| Feature | Reason |', '|---|---|');
      for (const item of dossier.featureBacklog.wont) L.push(`| ${cell(item.feature)} | ${cell(item.reason)} |`);
    }
    L.push('');
  }
  if (dossier.implementationPlan) {
    L.push('### Implementation plan', '', '| # | Timebox | Outcome | Work | Acceptance test |', '|---|---|---|---|---|');
    for (const milestone of dossier.implementationPlan.milestones) {
      L.push(`| ${milestone.order} | ${cell(milestone.timebox)} | ${cell(milestone.outcome)} | ${cell(milestone.tasks.join('; '))} | ${cell(milestone.acceptance_test)} |`);
    }
    L.push('');
  }
  L.push('### Validation plan', '');
  if (dossier.experiments.status === 'DEGRADED') L.push(`> ⚠ DEGRADED: ${dossier.experiments.note}`, '');
  if (dossier.experiments.actions.length) {
    L.push('| # | Experiment | Why | Validates | Effort | Kill signal |', '|---|---|---|---|---|---|');
    for (const action of dossier.experiments.actions) {
      L.push(`| ${action.order} | ${cell(action.action)} | ${cell(action.why)} | ${cell(readerClaimLabel(report, action.validates))} | ${action.effort} | ${cell(action.killSignal)} |`);
    }
    L.push('', dossier.experiments.note);
  } else L.push('No executable experiment was produced.');
  L.push('');

  L.push('## 3. Why this decision', '');
  if (dossier.claimChain.length) {
    L.push('| Claim | Ruling | Evidence status | Depends on |', '|---|---|---|---|');
    for (const claim of dossier.claimChain) {
      L.push(`| ${cell(claim.text)} | ${claim.ruling} | ${claim.evidenceStatus} | ${cell(readerClaimRefs(report, claim.dependsOn))} |`);
    }
  } else L.push('No graph-anchored decision chain was recorded.');
  L.push('');

  L.push('## 4. What could change the decision', '', '### Decision-sensitive facts', '');
  if (dossier.sensitivity.length) {
    L.push('| Fact | Sensitivity | If false | What would change it | Linked claims |', '|---|---|---|---|---|');
    for (const item of dossier.sensitivity) {
      L.push(`| ${cell(item.fact)} | ${item.sensitivity} | ${item.impactIfFalse} | ${cell(item.whatWouldChangeIt)} | ${cell(readerClaimRefs(report, item.linkedClaimIds))} |`);
    }
  } else L.push('No verdict-sensitive graph node was recorded.');
  L.push('', '### Strongest counter-case', '');
  if (dossier.counterCase.available) {
    L.push(dossier.counterCase.reasoning, '', `Evidence behind this counter-case: ${readerClaimRefs(report, dossier.counterCase.claimIds)}`);
  } else L.push(`> ⚠ DEGRADED: ${dossier.counterCase.reasoning}`);
  L.push('');

  L.push('## 5. Evidence and verification', '', ...degradation(report, ['verification_skipped', 'research_ungrounded']));
  if (dossier.evidence.length) {
    L.push('| Evidence ID | Source | Date | Freshness | Verification | Linked claims |', '|---|---|---|---|---|---|');
    for (const evidence of dossier.evidence) {
      L.push(`| ${evidence.id} | ${cell(evidence.source)} (${evidence.sourceKind}) | ${evidence.date} | ${evidence.freshness} | ${evidence.verificationStatus} | ${cell(readerClaimRefs(report, evidence.claimIds))} |`);
    }
  } else L.push('No evidence cards were stored.');
  L.push('');

  L.push('## 6. Risks, gaps, and open questions', '', '### Risks', '');
  if (report.risks.length) {
    L.push('| Risk | Severity |', '|---|---|');
    for (const risk of report.risks) L.push(`| ${cell(risk.risk)} | ${risk.severity} |`);
  } else L.push('No material risk was recorded.');
  L.push('', '### Coverage', '');
  if (dossier.coverage.length) {
    L.push('| Dimension | Status | Related claims |', '|---|---|---|');
    for (const item of dossier.coverage) L.push(`| ${cell(item.label)} | ${item.status} | ${cell(readerClaimRefs(report, item.claimIds))} |`);
  } else L.push('No rubric coverage ledger was recorded.');
  L.push('', '### Open questions', '');
  if (report.openQuestions.length) {
    for (const question of report.openQuestions) L.push(`- ${question}`);
  } else L.push('No verdict-flipping open question was recorded.');
  L.push('');

  L.push('## 7. Disagreement and dissent', '', ...degradation(report, ['single_model', 'low_diversity']));
  if (report.disagreements.length) {
    for (const disagreement of report.disagreements) {
      L.push(`- **${disagreement.topic}** — ${disagreement.status}; ${disagreement.ruling}.`);
      for (const side of disagreement.sides) L.push(`  - ${side.stance} (${side.providers.map(providerName).join(', ')}): ${side.reasoning.join(' ')}`);
      if (disagreement.reasoning) L.push(`  - Why: ${disagreement.reasoning}`);
    }
  } else L.push(report.mode === 'quick' ? 'No cross-model disagreement analysis runs in quick mode.' : 'No genuine disagreements were stored.');
  L.push('', '### Position changes', '');
  if (dossier.positionChanges.length) {
    L.push('| Event | Claim | Responder | Change | Evidence | Detail |', '|---|---|---|---|---|---|');
    for (const event of dossier.positionChanges) {
      L.push(`| ${event.eventId} | ${cell(readerClaimLabel(report, event.claimId))} | ${providerName(event.responder)} | ${event.response} | ${refs(event.evidenceIds)} | ${cell(event.narrowedProposition ?? event.reasoning)} |`);
    }
  } else L.push('No `CONCEDE`, `COUNTER`, or `NARROW` event was recorded.');
  L.push('', '### Minority report', '');
  if (report.minority.dissent.length) {
    for (const item of report.minority.dissent) L.push(`- ${item}`);
  } else L.push('No minority dissent was recorded.');
  for (const item of report.minority.uniqueOppositions) L.push(`- ${providerName(item.provider)} uniquely opposed: ${item.proposition}`);
  L.push(`- Decision-blocking status: ${report.minority.blocksDecision}`, '');

  L.push('## 8. What the council added', '');
  if (dossier.sharedConcerns.length) {
    L.push('Shared concerns:');
    for (const item of dossier.sharedConcerns) L.push(`- ${item.text} — ${item.evidenceStatus}; ${item.providerIds.map(providerName).join(', ')}.`);
  } else L.push('Shared concerns: none recorded.');
  L.push('');
  if (dossier.uniqueSupportedInsights.length) {
    L.push('Unique supported insights:');
    for (const item of dossier.uniqueSupportedInsights) L.push(`- ${item.text} — ${providerName(item.providerId)}; ${item.verificationStatus}.`);
  } else L.push('Unique supported insights: none recorded.');
  L.push('', '### Verified unique contributions', '', ...degradation(report, ['verification_skipped', 'single_model', 'low_diversity']));
  L.push('Only unique claims that survived independent verification receive credit.', '');
  L.push('| Provider | Verified unique contributions | Count |', '|---|---|---|');
  for (const contribution of dossier.contributions) {
    L.push(`| ${contribution.name} | ${cell(readerClaimRefs(report, contribution.verifiedUniqueClaimIds))} | ${contribution.verifiedUniqueClaimIds.length} |`);
  }
  L.push('');

  L.push('## 9. Run details', '');
  L.push(`- Report ID: \`${report.reportId}\``);
  L.push(`- Generated: ${report.generatedAt}`);
  L.push(`- Original task: ${report.task.original}`);
  L.push(`- Normalized question: ${report.task.normalized}`);
  if (report.task.confirmation) L.push(`- User confirmation: ${report.task.confirmation}`);
  L.push(`- Constraints: ${report.task.constraints.join('; ') || 'none recorded'}`);
  L.push(`- Success criteria: ${report.task.successCriteria.join('; ') || 'none recorded'}`);
  L.push(`- Models and roles: ${report.models.map((model) => `${model.name} (${model.roles.join(', ')})`).join(' · ') || 'none recorded'}`);
  L.push(`- Mode: ${report.mode}`);
  L.push(`- Provider calls: ${report.receipt.calls}/${report.receipt.budget}`);
  L.push(`- Categories: discovery ${report.receipt.categories.discovery} · verification ${report.receipt.categories.verification} · repair ${report.receipt.categories.repair} · planning ${report.receipt.categories.planning}`);
  L.push(`- By provider: ${Object.entries(report.receipt.byProvider).map(([provider, count]) => `${providerName(provider)} ${count}`).join(', ') || 'none'}`);
  L.push(`- Recorded model time: ${(report.receipt.modelTimeMs / 1000).toFixed(1)}s`);
  L.push(`- Degradation flags: ${report.flags.join(', ') || 'none'}`, '');

  for (let index = 0; index < L.length; index++) L[index] = stripReaderClaimIds(L[index]!);

  L.push('## 10. Technical audit', '');
  L.push('<details>', '<summary>Original submissions and graph events</summary>', '');
  for (const submission of dossier.technical.submissions) {
    L.push(`- **${submission.name}:** ${submission.strongestVersion} (${refs(submission.positionIds)})`);
  }
  L.push('', 'Original positions:');
  for (const position of dossier.technical.positions) {
    L.push(`- ${position.id} [${providerName(position.provider)} ${position.stance}] ${position.proposition}; evidence ${refs(position.evidenceIds)}`);
  }
  if (!dossier.technical.positions.length) L.push('- none');
  L.push('', 'Graph edges:');
  for (const edge of dossier.technical.edges) L.push(`- ${edge.from} —${edge.type}→ ${edge.to}`);
  if (!dossier.technical.edges.length) L.push('- none');
  L.push('', 'Position-change events:');
  for (const event of dossier.technical.events) L.push(`- ${event.eventId}: ${providerName(event.responder)} ${event.response} ${event.claimId} — ${event.reasoning}`);
  if (!dossier.technical.events.length) L.push('- none');
  L.push('', '</details>', '');

  return L.join('\n');
}
