import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { coerceToSchema } from '../src/orchestration/jsonStage.js';

// T1 (plan/AIKI-v6-council-integrity-plan.md): run f740's complete planner output was discarded
// because `headline` was 173 chars vs max(160) with repair disallowed. Lossy coercion must clip
// over-max strings and drop empty optional min-1 strings — never invent content.
describe('lossy string coercion', () => {
  it('clips an over-max string at a word boundary with ellipsis', () => {
    const schema = z.object({ headline: z.string().min(1).max(20) }).strict();
    const out = coerceToSchema(schema, { headline: 'twelve chars plus more words here' }, true) as { headline: string };
    expect(out.headline.length).toBeLessThanOrEqual(20);
    expect(out.headline.endsWith('…')).toBe(true);
    expect(schema.safeParse(out).success).toBe(true);
  });

  it('does NOT clip in lossless mode', () => {
    const schema = z.object({ headline: z.string().max(20) }).strict();
    const out = coerceToSchema(schema, { headline: 'twelve chars plus more words here' }, false) as { headline: string };
    expect(out.headline.length).toBeGreaterThan(20);
  });

  it('drops an empty optional min-1 string instead of failing — losslessly (empty = no information)', () => {
    const schema = z.object({ rationale: z.string().min(1).optional() }).strict();
    for (const lossy of [false, true]) {
      const out = coerceToSchema(schema, { rationale: '' }, lossy) as Record<string, unknown>;
      expect(schema.safeParse(out).success).toBe(true);
      expect(out.rationale).toBeUndefined();
    }
  });

  it('never invents: empty REQUIRED min-1 string still fails', () => {
    const schema = z.object({ action: z.string().min(1) }).strict();
    expect(schema.safeParse(coerceToSchema(schema, { action: '' }, true)).success).toBe(false);
  });

  it('REPLAY: the exact f740 S9b headline survives lossy coercion', () => {
    const raw = readFileSync('test/fixtures/f740-s9b-first.out.txt', 'utf8');
    const json = JSON.parse(raw.match(/```json\s*([\s\S]*?)```/)![1]) as { reader_brief: { headline: string } };
    expect(json.reader_brief.headline.length).toBeGreaterThan(160); // the live defect
    const brief = z.object({ headline: z.string().min(1).max(160) });
    const clipped = coerceToSchema(brief, { headline: json.reader_brief.headline }, true) as { headline: string };
    expect(brief.safeParse(clipped).success).toBe(true);
  });
});
