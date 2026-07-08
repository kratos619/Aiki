// Skills — per-role playbooks that sharpen a stage prompt without changing code. A "skill" is a
// markdown file under src/skills/<workflow>/<role>.md (copied to dist/skills/ at build; the path
// resolves the same in src and dist because the tree mirrors). A missing playbook returns '' so
// callers stay backward-compatible: the stage prompt is byte-for-byte unchanged when no skill exists.
//
// §19 skill-injection boundary: playbooks load ONLY from the repo skills dir (never remote / user
// paths), AND their text is scanned for exfiltration patterns. A playbook that trips the lint is
// rejected (treated as absent) — fail-closed to the safe no-skill baseline; a bad skill file never
// crashes the run, it just doesn't apply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Exfiltration patterns a skill playbook must not contain (§19). Repo files are author-controlled;
 *  this is defense-in-depth against a compromised playbook smuggling a "leak this" instruction. */
const EXFIL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'url', re: /\b(?:https?|ftp):\/\//i },
  { name: 'upload', re: /\bupload\b/i },
  { name: 'send-to', re: /\bsend\b[^\n]{0,30}\bto\b/i },
  { name: 'base64-blob', re: /[A-Za-z0-9+/=]{50,}/ },
];

/** The name of the first exfiltration pattern `text` trips, or null if it is clean. */
export function lintSkill(text: string): string | null {
  for (const { name, re } of EXFIL_PATTERNS) if (re.test(text)) return name;
  return null;
}

/** Load the playbook for a role in a workflow, or '' if none exists OR it fails the §19 lint.
 *  Role-keyed, provider-agnostic. */
export function loadSkill(workflow: string, role: string): string {
  const url = new URL(`../skills/${workflow}/${role}.md`, import.meta.url);
  let text: string;
  try {
    text = readFileSync(fileURLToPath(url), 'utf8').trim();
  } catch {
    return ''; // no playbook for this role → prompt unchanged
  }
  return lintSkill(text) ? '' : text; // §19: reject a playbook that trips the exfil lint
}
