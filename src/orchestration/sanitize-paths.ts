// v6 render-time path sanitization (plan/AIKI-v6-council-integrity-plan.md T8). Run f740's report
// leaked `/Users/<name>/...` locators into its own evidence table while one of its accepted claims
// said replays must sanitize local paths — the artifact violated the product's own rule. Every
// rendered artifact (canonical Markdown, HTML) passes through here; stored run JSON keeps raw
// locators for audit fidelity, and the terminal keeps the functional local report path.

/** Replace the user-identifying prefix of absolute home paths with `~`. Idempotent; the
 *  lookbehind keeps URL path segments like `example.com/Users/page` untouched. */
export function sanitizeLocalPaths(text: string): string {
  return text.replace(/(?<![\w.:-])(?:file:\/\/)?\/(?:Users|home)\/[^/\s)\]|"'`]+/g, '~');
}
