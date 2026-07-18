import { describe, it, expect } from 'vitest';

import { sanitizeLocalPaths } from '../src/orchestration/sanitize-paths.js';

// T8 (plan/AIKI-v6-council-integrity-plan.md): f740's evidence table rendered
// /Users/<name>/... into the report. Rendered artifacts must never carry a local username.
// (Full-artifact assertions live in the T11 f740 acceptance test.)
describe('sanitizeLocalPaths', () => {
  it('rewrites macOS and Linux home prefixes to ~', () => {
    expect(sanitizeLocalPaths('| codex/E2 | /Users/gaurav/Documents/AiKi/inputs/idea-brief.md (USER) |'))
      .toBe('| codex/E2 | ~/Documents/AiKi/inputs/idea-brief.md (USER) |');
    expect(sanitizeLocalPaths('saved at /home/dev/project/run.md'))
      .toBe('saved at ~/project/run.md');
  });

  it('handles file:// URLs and quoted paths', () => {
    expect(sanitizeLocalPaths('see file:///Users/gaurav/x/y.html and "/Users/gaurav/z"'))
      .toBe('see ~/x/y.html and "~/z"');
  });

  it('is idempotent and leaves non-home paths alone', () => {
    const once = sanitizeLocalPaths('/Users/gaurav/a/b');
    expect(sanitizeLocalPaths(once)).toBe(once);
    expect(sanitizeLocalPaths('https://example.com/Users/page /var/log/x')).toBe('https://example.com/Users/page /var/log/x');
  });
});
