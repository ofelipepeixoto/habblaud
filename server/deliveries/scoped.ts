// Operator-owned grants, never inferred from transcript links or known account folders.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, sep } from 'node:path';
import { DELIVERY_FILE_MAX_BYTES, pathProblem } from './files';
import type { FetchResult } from './fetcher';

export interface ArtifactScope { account: string; sessionId: string; project: string }
interface Grant extends ArtifactScope { root: string }
const denied = (): FetchResult => ({ status: 403, error: 'Artifact scope is missing, invalid or no longer authorized.' });
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const clean = (path: string) => isAbsolute(path) && normalize(path) === path && !path.includes('\0');

/** Reject aliases (including parent directory symlinks), not merely a text prefix. */
async function noAliases(path: string): Promise<void> {
  if (!clean(path) || await realpath(path) !== path) throw new Error('alias');
  for (let p = path;; p = dirname(p)) {
    if ((await lstat(p)).isSymbolicLink()) throw new Error('alias');
    if (dirname(p) === p) break;
  }
}

async function grants(file: string | undefined): Promise<Grant[]> {
  if (!file) return [];
  await noAliases(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    // Policy must be outside agent-writable projects and protected by OS ownership/ACLs.
    if (!st.isFile() || st.size > 1024 * 1024 || st.nlink !== 1 || (st.mode & 0o022)) return [];
    const bytes = Buffer.alloc(st.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== st.size) return [];
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length > 1000) return [];
    const out: Grant[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return [];
      const g = item as Record<string, unknown>;
      if (![g.account, g.sessionId, g.project, g.root].every(v => typeof v === 'string' && v.length > 0 && !v.includes('\0'))) return [];
      const grant = g as unknown as Grant;
      if (!clean(grant.root) || !clean(grant.project) || grant.root === sep || grant.root !== grant.project) return [];
      if (inside(grant.root, file)) return []; // never accept a policy within an authorized project
      const key = JSON.stringify([grant.account, grant.sessionId]);
      if (seen.has(key)) return [];
      seen.add(key); out.push(grant);
    }
    // Overlapping project roots would authorize one project's files from another.
    const roots = new Set(out.map(g => g.root));
    for (const root of roots) {
      for (let parent = dirname(root);; parent = dirname(parent)) {
        if (roots.has(parent)) return [];
        if (parent === dirname(parent)) break;
      }
    }
    return out;
  } finally { await handle.close(); }
}

/** Bounded async reads; no path/content cache and no fallback to an unscoped bridge. */
export class ScopedArtifacts {
  private active = 0;
  constructor(private readonly policyFile?: string) {}

  async get(path: string, scope?: ArtifactScope): Promise<FetchResult> {
    if (!scope || !clean(path) || pathProblem(path)) return denied();
    if (this.active >= 4) return { status: 429, error: 'Too many artifact reads.' };
    this.active++;
    try {
      const list = await grants(this.policyFile);
      const grant = list.find(g => g.account === scope.account && g.sessionId === scope.sessionId && g.project === scope.project);
      if (!grant || !inside(grant.root, path)) return denied();
      await noAliases(grant.root);
      if (!(await lstat(grant.root)).isDirectory()) return denied();
      await noAliases(path);
      const before = await lstat(path);
      if (!before.isFile() || before.nlink !== 1 || before.size > DELIVERY_FILE_MAX_BYTES) return denied();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1 || opened.size > DELIVERY_FILE_MAX_BYTES) return denied();
        // One extra byte catches growth without allocating an unbounded readFile buffer.
        const data = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < data.length) {
          const { bytesRead } = await handle.read(data, length, data.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        await noAliases(path);
        const current = await lstat(path);
        if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) return denied();
        // Revocation or policy replacement during a read must not return the bytes.
        const currentGrants = await grants(this.policyFile);
        if (!currentGrants.some(g => g.account === grant.account && g.sessionId === grant.sessionId && g.project === grant.project && g.root === grant.root)) return denied();
        return { data: data.subarray(0, length) };
      } finally { await handle.close(); }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { status: 404, error: 'Artifact or scope not found.' } : denied();
    } finally { this.active--; }
  }
}
