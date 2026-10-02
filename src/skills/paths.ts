import { promises as fs } from "node:fs";
import path from "node:path";

/** Resolve links relative to the real skill root, including linked skill roots. */
export async function resolveConfinedPath(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    return await resolveFromRoot(await fs.realpath(root), candidate);
  } catch {
    return;
  }
}

async function resolveFromRoot(
  rootReal: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    const candidateReal = await fs.realpath(candidate);
    const relative = path.relative(rootReal, candidateReal);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return;
    return candidateReal;
  } catch {
    return;
  }
}

export async function resolveConfinedFile(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  return regularFile(await resolveConfinedPath(root, candidate));
}

async function regularFile(
  resolved: string | undefined,
): Promise<string | undefined> {
  if (!resolved) return;
  try {
    if ((await fs.stat(resolved)).isFile()) return resolved;
  } catch {
    return;
  }
}

/** Keep alias paths in results while preventing directory-link recursion. */
export async function listConfinedFiles(
  root: string,
  directory: string,
): Promise<string[]> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return [];
  }
  async function walk(dir: string, ancestors: Set<string>): Promise<string[]> {
    const resolved = await resolveFromRoot(rootReal, dir);
    if (!resolved || ancestors.has(resolved)) return [];
    const nextAncestors = new Set(ancestors).add(resolved);
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const entryPath = path.join(dir, entry.name);
        if (await regularFile(await resolveFromRoot(rootReal, entryPath)))
          files.push(entryPath);
        else if (entry.isDirectory() || entry.isSymbolicLink())
          files.push(...(await walk(entryPath, nextAncestors)));
      }
      return files;
    } catch {
      return [];
    }
  }
  return walk(directory, new Set());
}
