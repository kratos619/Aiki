import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

export const EvidencePack = z.object({
  root: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
}).strict();

export type EvidencePack = z.infer<typeof EvidencePack>;

const CREDENTIAL_DIRS = ['.Codex', '.codex', '.gemini', '.antigravity'].map((name) => join(homedir(), name));

function assertSafePath(path: string): void {
  if (CREDENTIAL_DIRS.some((dir) => path === dir || path.startsWith(`${dir}${sep}`))) {
    throw new Error(`refusing evidence path inside credential directory: ${path}`);
  }
}

async function collectFiles(path: string): Promise<string[]> {
  assertSafePath(path);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`evidence packs do not follow symbolic links: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => collectFiles(join(path, entry.name))));
  return nested.flat();
}

/** Resolve a user-scoped file/directory into a paths+hashes manifest; file contents are never copied. */
export async function buildEvidencePack(inputPath: string): Promise<EvidencePack> {
  const requested = resolve(inputPath);
  assertSafePath(requested); // reject credential paths before even resolving/reading them
  const root = await realpath(requested);
  assertSafePath(root);
  const paths = await collectFiles(root);
  if (paths.length === 0) throw new Error(`evidence pack contains no regular files: ${root}`);
  const files = await Promise.all(paths.map(async (path) => ({
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  })));
  return EvidencePack.parse({ root, files });
}
