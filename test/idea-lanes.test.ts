import { describe, expect, it } from 'vitest';

import { buildLanePrompts } from '../src/orchestration/idea-lanes.js';

describe('idea research lanes', () => {
  it('gives each lane a distinct structural remit without provider-specific instructions', () => {
    const prompts = buildLanePrompts('BASE ANALYST PROMPT', [
      { id: 'R1', label: 'target user / audience' },
      { id: 'R4', label: 'feasibility / technical viability' },
      { id: 'R13', label: 'team / execution capability' },
      { id: 'D1', label: 'provider interoperability' },
      { id: 'D2', label: 'workflow adoption' },
    ]);

    expect(prompts['market-adoption']).toContain('BASE ANALYST PROMPT');
    expect(prompts['market-adoption']).toContain('R1: target user / audience');
    expect(prompts['market-adoption']).toContain('R13: team / execution capability');
    expect(prompts['market-adoption']).toContain('D1: provider interoperability');
    expect(prompts['economics-delivery']).toContain('R4: feasibility / technical viability');
    expect(prompts['economics-delivery']).toContain('D2: workflow adoption');
    expect(`${prompts['market-adoption']}\n${prompts['economics-delivery']}`).not.toMatch(/agy|codex|claude/i);
  });
});
