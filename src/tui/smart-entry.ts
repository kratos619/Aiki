export type InputRoute = 'question' | 'code-review' | 'idea';
export type QuickAction = 'review-working-tree' | 'review-branch' | 'idea';

export const PRODUCT_LINE =
  'aiki stress-tests ideas and reviews code; for general questions use a single model — a council adds cost, not accuracy, when there is one right answer.';

const QUESTION_START = /^(what|why|how|who|when|where|is|are|can|could|should|would|do|does|did|will)\b/i;
const CODE_MARKER = /(diff --git|^@@|\+\+\+ b\/|--- a\/|```|[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|css|html|md)\b|\b(function|const|let|class|import|export)\b|[{};])/m;

// ── Scope redirect (V10.2) — catch "explore my whole codebase / brainstorm features for me" asks and
// point them at the right door, instead of silently stress-testing the request sentence as an "idea".
// aiki reviews a DIFF and vets a STATED idea; it does not roam a repo (§3/§22). Pure + deterministic. ──

// "go through / analyze / review MY|THIS|THE code|codebase|repo|project|files"
const CODEBASE_SCAN = /\b(go through|read|scan|analy[sz]e|explore|look (?:at|through|into)|review|audit|inspect|check)\b[^.?!]*\b(my|this|the|our|these)\s+(code|code ?base|repo|repository|project|files|source)\b/i;
// "what|which ... features|improvements|improve|add|build" (interrogative — genuine ideas don't lead with it)
const BRAINSTORM = /\b(what|which)\b[^.?!]{0,60}\b(features?|improvements?|improve|add|build)\b/i;

export const SCOPE_REDIRECT_MSG =
  'aiki reviews your *changes*, not a whole codebase, and vets a *specific* idea rather than brainstorming for you. Try /review for your current changes, or /idea "<one concrete idea>" to stress-test a specific one.';

/** A helpful scope message if the text is a codebase-exploration / feature-brainstorm ask, else null. */
export function scopeRedirect(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return CODEBASE_SCAN.test(t) || BRAINSTORM.test(t) ? SCOPE_REDIRECT_MSG : null;
}

export function routeInput(text: string): InputRoute {
  const trimmed = text.trim();
  if (!trimmed) return 'idea';
  const codeLike = CODE_MARKER.test(trimmed);
  if (codeLike) return 'code-review';
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words <= 18 && (trimmed.endsWith('?') || QUESTION_START.test(trimmed))) return 'question';
  return 'idea';
}

// ── Slash commands (V9) — the deterministic home-screen command set. NOT chat: a fixed parser. ──────

export interface ParsedCommand {
  cmd: string; // lowercased command name, no leading slash ('' for a bare "/")
  rest: string; // everything after the command name, trimmed (e.g. the idea text)
  args: string[]; // `rest` split on whitespace (for flag checks like --branch)
}

/** The home-screen command list (also drives `/help`). */
export const COMMANDS: Array<{ name: string; usage: string; help: string }> = [
  { name: 'idea', usage: '/idea <text>', help: 'stress-test an idea with the council' },
  { name: 'review', usage: '/review [--branch]', help: 'review your working-tree changes (or the branch)' },
  { name: 'resume', usage: '/resume <id>', help: 'continue a killed/timed-out run (replays finished work)' },
  { name: 'sessions', usage: '/sessions', help: 'list past runs (newest first)' },
  { name: 'models', usage: '/models', help: 'show/choose the model each provider uses' },
  { name: 'config', usage: '/config', help: 'show the effective config' },
  { name: 'help', usage: '/help', help: 'this list' },
];

/** Live palette filter (V10): while the user is typing the command word (input starts with "/",
 *  no space yet), return the commands it matches — prefix matches first, then substring matches
 *  (so "/mo" and "/dels" both find models). Bare "/" lists everything. Pure + deterministic. */
export function filterCommands(input: string): typeof COMMANDS {
  const t = input.trimStart();
  if (!t.startsWith('/') || /\s/.test(t)) return [];
  const q = t.slice(1).toLowerCase();
  const prefix = COMMANDS.filter((c) => c.name.startsWith(q));
  const substr = COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...substr];
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Near-miss recovery (V10): the closest command to an unknown one (≤2 edits, e.g. /model → /models),
 *  falling back to a substring match; null when nothing is plausibly meant. */
export function suggestCommand(cmd: string): string | null {
  const q = cmd.toLowerCase();
  let best: string | null = null;
  let bestD = 3; // accept distance ≤ 2
  for (const c of COMMANDS) {
    const d = editDistance(q, c.name);
    if (d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  if (best) return best;
  const sub = COMMANDS.find((c) => c.name.includes(q) || q.includes(c.name));
  return sub ? sub.name : null;
}

/** Parse a slash command like "/review --branch" or "/idea build X". Returns null for non-slash input
 *  (which then goes through `routeInput`). Pure + deterministic. */
export function parseCommand(input: string): ParsedCommand | null {
  const t = input.trim();
  if (!t.startsWith('/')) return null;
  const body = t.slice(1);
  const sp = body.search(/\s/);
  const cmd = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : body.slice(sp + 1).trim();
  return { cmd, rest, args: rest ? rest.split(/\s+/) : [] };
}

export function quickActionReducer(key: string, hasRepo: boolean): { action: QuickAction | null; message?: string } {
  const k = key.toLowerCase();
  if (k === 'i') return { action: 'idea' };
  if (k === 'r' || k === 'b') {
    if (!hasRepo) return { action: null, message: 'not inside a git repo' };
    return { action: k === 'r' ? 'review-working-tree' : 'review-branch' };
  }
  return { action: null };
}
