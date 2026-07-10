import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { logger, type OpenClawPluginApi } from "../../api.js";
import type { IntentCatalogEntry } from "../types.js";
import {
  buildSkillDomainMap,
  domainsForSkill,
  extractReferencedSkillNames,
} from "./domains.js";
import {
  DEFAULT_SKILL_INDEX_CACHE_TTL_MS,
  resolveSkillIndexCacheTtlMs,
  resolveSkillRoots,
} from "./roots.js";
import { SKILL_SOURCE_ORDER } from "./types.js";
import type {
  AvailableSkill,
  DeclaredRelatedSkill,
  SkillResolutionParams,
} from "./types.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";

export { extractReferencedSkillNames } from "./domains.js";

const SKILL_INDEX_MAX_DEPTH = 32;

interface CachedSkillIndex {
  expiresAtMs: number;
  index: Map<string, AvailableSkill>;
}

interface SkillIndexOptions {
  disabledSkillNames?: ReadonlySet<string>;
  source?: AvailableSkill["source"];
}

const skillIndexCache = new Map<string, CachedSkillIndex>();
const SOURCE_PRIORITY = new Map(
  SKILL_SOURCE_ORDER.map((source, index) => [source, index]),
);

export function clearSkillIndexCache(): void {
  skillIndexCache.clear();
}

function sweepExpiredSkillIndexes(nowMs: number): void {
  for (const [root, cached] of skillIndexCache) {
    if (cached.expiresAtMs <= nowMs) {
      skillIndexCache.delete(root);
    }
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

function fallbackDescription(content: string): string {
  const paragraph = content
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").trim())
    .find(Boolean);
  return paragraph ?? "";
}

function parseDeclaredRelatedSkills(data: unknown): DeclaredRelatedSkill[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const metadata = (data as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const relatedSkills = (metadata as Record<string, unknown>)["related-skills"];
  if (
    !relatedSkills ||
    typeof relatedSkills !== "object" ||
    Array.isArray(relatedSkills)
  ) {
    return [];
  }

  const seen = new Set<string>();
  const parsed: DeclaredRelatedSkill[] = [];
  for (const [name, reason] of Object.entries(relatedSkills)) {
    const normalizedName = name.trim();
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    const key = normalizedName.toLowerCase();
    if (!normalizedName || !normalizedReason || seen.has(key)) continue;
    seen.add(key);
    parsed.push({ name: normalizedName, reason: normalizedReason });
  }
  return parsed;
}

async function readSkillFile(
  filePath: string,
  source?: AvailableSkill["source"],
): Promise<AvailableSkill | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = matter(raw);
    const name =
      typeof parsed.data.name === "string"
        ? parsed.data.name.trim()
        : path.basename(path.dirname(filePath));
    if (!name) return;
    const description =
      typeof parsed.data.description === "string"
        ? parsed.data.description.trim()
        : fallbackDescription(parsed.content);
    const relatedSkills = parseDeclaredRelatedSkills(parsed.data);
    return {
      name,
      location: filePath,
      description,
      source,
      ...(relatedSkills.length ? { relatedSkills } : {}),
    };
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

export async function readDisabledBundledSkillNames(
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
      const skill = await readSkillFile(
        path.join(dir, "SKILL.md"),
        options.source,
      );
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
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_SKILL_INDEX_CACHE_TTL_MS;
  const disabledCacheKey = options.disabledSkillNames
    ? [...options.disabledSkillNames].sort().join(",")
    : "";
  const cacheKey = `${root}\0${options.source ?? ""}\0${disabledCacheKey}\0${cacheTtlMs}`;
  sweepExpiredSkillIndexes(nowMs);

  const cached = skillIndexCache.get(cacheKey);
  if (cached) {
    skillIndexCache.delete(cacheKey);
    skillIndexCache.set(cacheKey, cached);
    return cached.index;
  }

  const index = await buildSkillIndex(root, {
    disabledSkillNames: options.disabledSkillNames,
    source: options.source,
  });
  if (cacheTtlMs > 0) {
    skillIndexCache.set(cacheKey, {
      expiresAtMs: nowMs + cacheTtlMs,
      index,
    });
  } else {
    skillIndexCache.delete(cacheKey);
  }
  return index;
}

async function listSkillIndexes(
  params: SkillResolutionParams,
): Promise<Array<Map<string, AvailableSkill>>> {
  const stateDir = params.api.runtime.state.resolveStateDir(process.env);
  const cacheTtlMs =
    params.cacheTtlMs ?? resolveSkillIndexCacheTtlMs(params.api.config);
  let disabledBundledSkillNames: Set<string> | undefined;
  const getDisabledBundledSkillNames = async () => {
    disabledBundledSkillNames ??= await readDisabledBundledSkillNames(stateDir);
    return disabledBundledSkillNames;
  };

  const indexes: Array<Map<string, AvailableSkill>> = [];
  for (const root of resolveSkillRoots(params)) {
    indexes.push(
      await getCachedSkillIndex(root.path, {
        cacheTtlMs,
        disabledSkillNames:
          root.source === "bundled"
            ? await getDisabledBundledSkillNames()
            : undefined,
        nowMs: params.nowMs,
        source: root.source,
      }),
    );
  }
  return indexes;
}

function stripToolOnlyFields(skill: AvailableSkill): AvailableSkill {
  const { source: _source, ...visible } = skill;
  return visible;
}

function normalizeSkillNames(names: readonly unknown[] | undefined): string[] {
  if (!names) return [];
  return names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueSkillNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

function sourcePriority(skill: AvailableSkill): number {
  return skill.source
    ? (SOURCE_PRIORITY.get(skill.source) ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
}

export async function listAvailableSkills(
  params: SkillResolutionParams & { source?: AvailableSkill["source"] },
): Promise<AvailableSkill[]> {
  const source = params.source?.trim().toLowerCase();
  const usageStats = await readSkillUsageStats(params);
  const domainsBySkill = params.intents
    ? buildSkillDomainMap(params.intents)
    : undefined;
  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();

  for (const index of await listSkillIndexes(params)) {
    for (const skill of index.values()) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      if (source && skill.source?.toLowerCase() !== source) {
        continue;
      }
      seen.add(key);
      skills.push({
        ...skill,
        ...(domainsBySkill
          ? { domains: domainsForSkill(domainsBySkill, skill.name) }
          : {}),
      });
    }
  }
  return skills.sort((left, right) => {
    const sourceComparison = sourcePriority(left) - sourcePriority(right);
    if (sourceComparison !== 0) return sourceComparison;
    const usageComparison =
      skillUsageStatsForName(usageStats, right.name).usage_turns -
      skillUsageStatsForName(usageStats, left.name).usage_turns;
    if (usageComparison !== 0) return usageComparison;
    return left.name.localeCompare(right.name);
  });
}

export async function findAvailableSkill(
  params: SkillResolutionParams & { name: string },
): Promise<AvailableSkill | undefined> {
  const normalizedName = params.name.trim().toLowerCase();
  if (!normalizedName) return;
  const domainsBySkill = params.intents
    ? buildSkillDomainMap(params.intents)
    : undefined;
  for (const index of await listSkillIndexes(params)) {
    const skill = index.get(normalizedName);
    if (skill) {
      return {
        ...skill,
        ...(domainsBySkill
          ? { domains: domainsForSkill(domainsBySkill, skill.name) }
          : {}),
      };
    }
  }
}

export async function resolveAvailableSkills(
  params: SkillResolutionParams & {
    intentBody: string;
    skillNames?: readonly string[];
  },
): Promise<AvailableSkill[]> {
  const names = uniqueSkillNames([
    ...normalizeSkillNames(params.skillNames),
    ...extractReferencedSkillNames(params.intentBody),
  ]);
  if (names.length === 0) return [];

  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;
    const skill = await findAvailableSkill({ ...params, name });
    if (!skill) continue;
    skills.push(stripToolOnlyFields(skill));
    seen.add(skill.name.toLowerCase());
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

  const domainIntents = params.intents.filter(
    (intent) => intent.definition.domain.trim().toLowerCase() === domain,
  );
  const intentBody = domainIntents
    .map((intent) => intent.definition.prompt)
    .join("\n");
  const skillNames = domainIntents.flatMap(
    (intent) => intent.definition.skills ?? [],
  );

  if (!intentBody.trim() && skillNames.length === 0) return [];

  return await resolveAvailableSkills({
    api: params.api,
    agentId: params.agentId,
    intentBody,
    skillNames,
    bundledSkillsDir: params.bundledSkillsDir,
    cacheTtlMs: params.cacheTtlMs,
    nowMs: params.nowMs,
  });
}
