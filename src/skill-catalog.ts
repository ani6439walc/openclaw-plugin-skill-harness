import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import matter from "gray-matter";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { AvailableSkill, IntentCatalogEntry } from "./types.js";

const SKILL_REF_RE = /\bskill:\s*([A-Za-z0-9_-]+)/gi;
const SKILL_INDEX_CACHE_TTL_MS = 60_000;
const SKILL_INDEX_CACHE_MAX_ENTRIES = 128;
const SKILL_INDEX_MAX_DEPTH = 32;
const require = createRequire(import.meta.url);

interface CachedSkillIndex {
  expiresAtMs: number;
  index: Map<string, AvailableSkill>;
}

interface SkillIndexOptions {
  disabledSkillNames?: ReadonlySet<string>;
}

const skillIndexCache = new Map<string, CachedSkillIndex>();

function sweepExpiredSkillIndexes(nowMs: number): void {
  for (const [root, cached] of skillIndexCache) {
    if (cached.expiresAtMs <= nowMs) {
      skillIndexCache.delete(root);
    }
  }
}

function pruneOldestSkillIndexes(maxEntries: number): void {
  while (skillIndexCache.size >= maxEntries) {
    const oldestRoot = skillIndexCache.keys().next().value;
    if (!oldestRoot) return;
    skillIndexCache.delete(oldestRoot);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function extractReferencedSkillNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(SKILL_REF_RE)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

async function readSkillFile(
  filePath: string,
): Promise<AvailableSkill | undefined> {
  try {
    const parsed = matter(await fs.readFile(filePath, "utf-8"));
    const name =
      typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    if (!name) return;
    const description =
      typeof parsed.data.description === "string"
        ? parsed.data.description.trim()
        : "";
    return { name, location: filePath, description };
  } catch (err) {
    if (!isMissingPathError(err)) {
      logger.warn("failed to read referenced skill metadata", {
        error: err,
        path: filePath,
      });
    }
    return;
  }
}

async function readEntryStat(entryPath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(entryPath);
  } catch {
    return;
  }
}

async function isSkillFileEntry(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.name !== "SKILL.md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  return (await readEntryStat(path.join(dir, entry.name)))?.isFile() ?? false;
}

async function resolveChildDirectory(
  dir: string,
  entry: Dirent,
): Promise<string | undefined> {
  const entryPath = path.join(dir, entry.name);
  if (entry.isDirectory()) return entryPath;
  if (!entry.isSymbolicLink()) return;
  return (await readEntryStat(entryPath))?.isDirectory()
    ? entryPath
    : undefined;
}

async function readDisabledBundledSkillNames(
  stateDir: string,
): Promise<Set<string>> {
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    const parsed = JSON.parse(
      await fs.readFile(configPath, "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") return new Set();
    const skills = (parsed as { skills?: unknown }).skills;
    if (!skills || typeof skills !== "object") return new Set();
    const entries = (skills as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return new Set();
    }

    const disabled = new Set<string>();
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object") continue;
      if ((entry as { enabled?: unknown }).enabled === false) {
        disabled.add(name.toLowerCase());
      }
    }
    return disabled;
  } catch (err) {
    if (!isMissingPathError(err)) {
      logger.warn("failed to read OpenClaw skill entry configuration", {
        error: err,
        path: configPath,
      });
    }
    return new Set();
  }
}

async function buildSkillIndex(
  root: string,
  options: SkillIndexOptions = {},
): Promise<Map<string, AvailableSkill>> {
  const index = new Map<string, AvailableSkill>();
  const visitedDirs = new Set<string>();
  const disabledSkillNames = options.disabledSkillNames ?? new Set<string>();

  async function visit(dir: string, depth = 0): Promise<void> {
    if (depth > SKILL_INDEX_MAX_DEPTH) return;

    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const skillFileEntry = entries.find((entry) => entry.name === "SKILL.md");
    if (skillFileEntry && (await isSkillFileEntry(dir, skillFileEntry))) {
      const skill = await readSkillFile(path.join(dir, "SKILL.md"));
      const key = skill?.name.toLowerCase();
      if (skill && key && !disabledSkillNames.has(key)) {
        if (index.has(key)) {
          logger.warn("duplicate skill name ignored while indexing skills", {
            ignoredPath: skill.location,
            name: skill.name,
            root,
          });
        } else {
          index.set(key, skill);
        }
      }
    }

    const childDirs: string[] = [];
    for (const entry of entries) {
      if (disabledSkillNames.has(entry.name.toLowerCase())) continue;
      const childDir = await resolveChildDirectory(dir, entry);
      if (childDir) childDirs.push(childDir);
    }
    childDirs.sort((left, right) => left.localeCompare(right));

    for (const childDir of childDirs) {
      await visit(childDir, depth + 1);
    }
  }

  await visit(root);
  return index;
}

async function getCachedSkillIndex(
  root: string,
  options: { cacheTtlMs?: number; nowMs?: number } & SkillIndexOptions = {},
): Promise<Map<string, AvailableSkill>> {
  const nowMs = options.nowMs ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? SKILL_INDEX_CACHE_TTL_MS;
  const disabledCacheKey = options.disabledSkillNames
    ? [...options.disabledSkillNames].sort().join(",")
    : "";
  const cacheKey = `${root}\0${disabledCacheKey}`;
  sweepExpiredSkillIndexes(nowMs);

  const cached = skillIndexCache.get(cacheKey);
  if (cached) {
    skillIndexCache.delete(cacheKey);
    skillIndexCache.set(cacheKey, cached);
    return cached.index;
  }

  const index = await buildSkillIndex(root, {
    disabledSkillNames: options.disabledSkillNames,
  });
  if (cacheTtlMs > 0) {
    pruneOldestSkillIndexes(SKILL_INDEX_CACHE_MAX_ENTRIES);
    skillIndexCache.set(cacheKey, {
      expiresAtMs: nowMs + cacheTtlMs,
      index,
    });
  } else {
    skillIndexCache.delete(cacheKey);
  }
  return index;
}

export async function resolveAvailableSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  intentBody: string;
  bundledSkillsDir?: string;
  cacheTtlMs?: number;
  nowMs?: number;
}): Promise<AvailableSkill[]> {
  const names = extractReferencedSkillNames(params.intentBody);
  if (names.length === 0) return [];

  const stateDir = params.api.runtime.state.resolveStateDir(process.env);
  const workspaceDir = params.api.runtime.agent.resolveAgentWorkspaceDir(
    params.api.config,
    params.agentId,
    process.env,
  );
  const bundledSkillsDir =
    params.bundledSkillsDir ??
    path.join(path.dirname(require.resolve("openclaw")), "..", "skills");

  const roots = [
    path.join(workspaceDir, "skills"),
    path.join(stateDir, "skills"),
    path.join(stateDir, "plugin-skills"),
    bundledSkillsDir,
  ].filter((root): root is string => Boolean(root));
  let disabledBundledSkillNames: Set<string> | undefined;
  const getDisabledBundledSkillNames = async () => {
    disabledBundledSkillNames ??= await readDisabledBundledSkillNames(stateDir);
    return disabledBundledSkillNames;
  };

  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;

    for (const root of roots) {
      const skill = (
        await getCachedSkillIndex(root, {
          cacheTtlMs: params.cacheTtlMs,
          disabledSkillNames:
            root === bundledSkillsDir
              ? await getDisabledBundledSkillNames()
              : undefined,
          nowMs: params.nowMs,
        })
      ).get(normalizedName);
      if (!skill) continue;
      skills.push(skill);
      seen.add(skill.name.toLowerCase());
      break;
    }
  }
  return skills;
}

export async function resolveDomainSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  domain: string | null | undefined;
  intents: readonly IntentCatalogEntry[];
  bundledSkillsDir?: string;
  cacheTtlMs?: number;
  nowMs?: number;
}): Promise<AvailableSkill[]> {
  const domain = (params.domain ?? "").trim().toLowerCase();
  if (!domain) return [];

  const intentBody = params.intents
    .filter(
      (intent) => intent.definition.domain.trim().toLowerCase() === domain,
    )
    .map((intent) => intent.definition.prompt)
    .join("\n");

  if (!intentBody.trim()) return [];

  return await resolveAvailableSkills({
    api: params.api,
    agentId: params.agentId,
    intentBody,
    bundledSkillsDir: params.bundledSkillsDir,
    cacheTtlMs: params.cacheTtlMs,
    nowMs: params.nowMs,
  });
}
