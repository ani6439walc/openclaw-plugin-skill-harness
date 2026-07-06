import fs from "node:fs";
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

export function extractReferencedSkillNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(SKILL_REF_RE)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function readSkillFile(filePath: string): AvailableSkill | undefined {
  if (!fs.existsSync(filePath)) return;
  try {
    const parsed = matter(fs.readFileSync(filePath, "utf-8"));
    const name =
      typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    if (!name) return;
    const description =
      typeof parsed.data.description === "string"
        ? parsed.data.description.trim()
        : "";
    return { name, location: filePath, description };
  } catch (err) {
    logger.warn("failed to read referenced skill metadata", {
      error: err,
      path: filePath,
    });
    return;
  }
}

function readEntryStat(entryPath: string): fs.Stats | undefined {
  try {
    return fs.statSync(entryPath);
  } catch {
    return;
  }
}

function isSkillFileEntry(dir: string, entry: fs.Dirent): boolean {
  if (entry.name !== "SKILL.md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  return readEntryStat(path.join(dir, entry.name))?.isFile() ?? false;
}

function resolveChildDirectory(
  dir: string,
  entry: fs.Dirent,
): string | undefined {
  const entryPath = path.join(dir, entry.name);
  if (entry.isDirectory()) return entryPath;
  if (!entry.isSymbolicLink()) return;
  return readEntryStat(entryPath)?.isDirectory() ? entryPath : undefined;
}

function readDisabledBundledSkillNames(stateDir: string): Set<string> {
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
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
    if (fs.existsSync(configPath)) {
      logger.warn("failed to read OpenClaw skill entry configuration", {
        error: err,
        path: configPath,
      });
    }
    return new Set();
  }
}

function buildSkillIndex(
  root: string,
  options: SkillIndexOptions = {},
): Map<string, AvailableSkill> {
  const index = new Map<string, AvailableSkill>();
  const visitedDirs = new Set<string>();
  const disabledSkillNames = options.disabledSkillNames ?? new Set<string>();

  function visit(dir: string, depth = 0): void {
    if (depth > SKILL_INDEX_MAX_DEPTH) return;

    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => isSkillFileEntry(dir, entry))) {
      const skill = readSkillFile(path.join(dir, "SKILL.md"));
      const key = skill?.name.toLowerCase();
      if (key && disabledSkillNames.has(key)) return;
      if (skill && key) {
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

    const childDirs = entries
      .filter((entry) => !disabledSkillNames.has(entry.name.toLowerCase()))
      .map((entry) => resolveChildDirectory(dir, entry))
      .filter((childDir): childDir is string => Boolean(childDir))
      .sort((left, right) => left.localeCompare(right));

    for (const childDir of childDirs) {
      visit(childDir, depth + 1);
    }
  }

  visit(root);
  return index;
}

function getCachedSkillIndex(
  root: string,
  options: { cacheTtlMs?: number; nowMs?: number } & SkillIndexOptions = {},
): Map<string, AvailableSkill> {
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

  const index = buildSkillIndex(root, {
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

export function resolveAvailableSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  intentBody: string;
  bundledSkillsDir?: string;
  cacheTtlMs?: number;
  nowMs?: number;
}): AvailableSkill[] {
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
  const getDisabledBundledSkillNames = () => {
    disabledBundledSkillNames ??= readDisabledBundledSkillNames(stateDir);
    return disabledBundledSkillNames;
  };

  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;

    for (const root of roots) {
      const skill = getCachedSkillIndex(root, {
        cacheTtlMs: params.cacheTtlMs,
        disabledSkillNames:
          root === bundledSkillsDir
            ? getDisabledBundledSkillNames()
            : undefined,
        nowMs: params.nowMs,
      }).get(normalizedName);
      if (!skill) continue;
      skills.push(skill);
      seen.add(skill.name.toLowerCase());
      break;
    }
  }
  return skills;
}

export function resolveDomainSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  domain: string | null | undefined;
  intents: readonly IntentCatalogEntry[];
  bundledSkillsDir?: string;
  cacheTtlMs?: number;
  nowMs?: number;
}): AvailableSkill[] {
  const domain = (params.domain ?? "").trim().toLowerCase();
  if (!domain) return [];

  const intentBody = params.intents
    .filter(
      (intent) => intent.definition.domain.trim().toLowerCase() === domain,
    )
    .map((intent) => intent.definition.prompt)
    .join("\n");

  if (!intentBody.trim()) return [];

  return resolveAvailableSkills({
    api: params.api,
    agentId: params.agentId,
    intentBody,
    bundledSkillsDir: params.bundledSkillsDir,
    cacheTtlMs: params.cacheTtlMs,
    nowMs: params.nowMs,
  });
}
