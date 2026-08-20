import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import { logger, type OpenClawPluginApi } from "../../api.js";
import { resolveStateDirFromApi } from "../file-utils.js";
import { canonicalIdentity } from "../normalize.js";
import type { IntentCatalogEntry } from "../types.js";
import { buildSkillDomainMap } from "./domains.js";
import {
  DEFAULT_SKILL_INDEX_CACHE_TTL_MS,
  resolveSkillIndexCacheTtlMs,
  resolveSkillRoots,
} from "./roots.js";
import { skillSourcePriority } from "./types.js";
import type {
  AvailableSkill,
  DeclaredRelatedSkill,
  SkillInventoryItem,
  SkillResolutionParams,
  SkillUsageStats,
} from "./types.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";

const SKILL_INDEX_MAX_DEPTH = 32;

interface CachedSkillIndex {
  expiresAtMs: number;
  index: Map<string, IndexedSkill>;
}

interface IndexedSkill extends AvailableSkill {
  winnerFingerprint: string;
  fingerprint: string;
}

interface SkillIndexOptions {
  disabledSkillNames?: ReadonlySet<string>;
  requireComplete?: boolean;
  source?: AvailableSkill["source"];
}

const skillIndexCache = new Map<string, CachedSkillIndex>();

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
  requireComplete = false,
): Promise<IndexedSkill | undefined> {
  try {
    const raw = await fs.readFile(filePath);
    const resolvedFilePath = await fs.realpath(filePath);
    const parsed = matter(raw.toString("utf-8"));
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
      winnerFingerprint: createHash("sha256")
        .update(resolvedFilePath)
        .digest("hex"),
      fingerprint: createHash("sha256").update(raw).digest("hex"),
      source,
      ...(relatedSkills.length ? { relatedSkills } : {}),
    };
  } catch (err) {
    if (requireComplete) throw err;
    if (!isMissingPathError(err)) {
      logger.warn("failed to read referenced skill metadata", {
        error: err,
        path: filePath,
      });
    }
    return;
  }
}

async function readEntryStat(
  entryPath: string,
  requireComplete = false,
): Promise<Stats | undefined> {
  try {
    return await fs.stat(entryPath);
  } catch (error) {
    if (requireComplete) throw error;
    return;
  }
}

async function isSkillFileEntry(
  dir: string,
  entry: Dirent,
  requireComplete = false,
): Promise<boolean> {
  if (entry.name !== "SKILL.md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  return (
    (
      await readEntryStat(path.join(dir, entry.name), requireComplete)
    )?.isFile() ?? false
  );
}

async function resolveChildDirectory(
  dir: string,
  entry: Dirent,
  requireComplete = false,
): Promise<string | undefined> {
  const entryPath = path.join(dir, entry.name);
  if (entry.isDirectory()) return entryPath;
  if (!entry.isSymbolicLink()) return;
  return (await readEntryStat(entryPath, requireComplete))?.isDirectory()
    ? entryPath
    : undefined;
}

type DisabledBundledSkillPolicy =
  { resolved: true; names: Set<string> } | { resolved: false };

async function resolveDisabledBundledSkillPolicy(
  stateDir: string,
): Promise<DisabledBundledSkillPolicy> {
  const configPath = path.join(stateDir, "openclaw.json");
  try {
    const parsed = JSON.parse(
      await fs.readFile(configPath, "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { resolved: false };
    }
    const skills = (parsed as { skills?: unknown }).skills;
    if (skills === undefined) return { resolved: true, names: new Set() };
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
      return { resolved: false };
    }
    const entries = (skills as { entries?: unknown }).entries;
    if (entries === undefined) return { resolved: true, names: new Set() };
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return { resolved: false };
    }

    const disabled = new Set<string>();
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { resolved: false };
      }
      const enabled = (entry as { enabled?: unknown }).enabled;
      if (enabled !== undefined && typeof enabled !== "boolean") {
        return { resolved: false };
      }
      if (enabled === false) {
        disabled.add(name.toLowerCase());
      }
    }
    return { resolved: true, names: disabled };
  } catch (err) {
    if (isMissingPathError(err)) {
      return { resolved: true, names: new Set() };
    }
    logger.warn("failed to read OpenClaw skill entry configuration", {
      error: err,
      path: configPath,
    });
    return { resolved: false };
  }
}

export async function readDisabledBundledSkillNames(
  stateDir: string,
): Promise<Set<string>> {
  const policy = await resolveDisabledBundledSkillPolicy(stateDir);
  return policy.resolved ? policy.names : new Set();
}

async function buildSkillIndex(
  root: string,
  options: SkillIndexOptions = {},
): Promise<Map<string, IndexedSkill>> {
  const index = new Map<string, IndexedSkill>();
  const visitedDirs = new Set<string>();
  const disabledSkillNames = options.disabledSkillNames ?? new Set<string>();

  async function visit(dir: string, depth = 0): Promise<void> {
    if (depth > SKILL_INDEX_MAX_DEPTH) return;

    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch (error) {
      if (
        options.requireComplete &&
        !(depth === 0 && isMissingPathError(error))
      ) {
        throw error;
      }
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (options.requireComplete) throw error;
      return;
    }

    const skillFileEntry = entries.find((entry) => entry.name === "SKILL.md");
    if (
      skillFileEntry &&
      (await isSkillFileEntry(dir, skillFileEntry, options.requireComplete))
    ) {
      const skill = await readSkillFile(
        path.join(dir, "SKILL.md"),
        options.source,
        options.requireComplete,
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
      const childDir = await resolveChildDirectory(
        dir,
        entry,
        options.requireComplete,
      );
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
): Promise<Map<string, IndexedSkill>> {
  const nowMs = options.nowMs ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_SKILL_INDEX_CACHE_TTL_MS;
  const disabledCacheKey = options.disabledSkillNames
    ? [...options.disabledSkillNames].sort().join(",")
    : "";
  const cacheKey = `${root}\0${options.source ?? ""}\0${disabledCacheKey}\0${cacheTtlMs}\0${options.requireComplete === true}`;
  sweepExpiredSkillIndexes(nowMs);

  const cached = skillIndexCache.get(cacheKey);
  if (cached) {
    skillIndexCache.delete(cacheKey);
    skillIndexCache.set(cacheKey, cached);
    return cached.index;
  }

  const index = await buildSkillIndex(root, {
    disabledSkillNames: options.disabledSkillNames,
    requireComplete: options.requireComplete,
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
  resolvedDisabledBundledSkillNames?: ReadonlySet<string>,
  requireComplete = false,
): Promise<Array<Map<string, IndexedSkill>>> {
  const stateDir = resolveStateDirFromApi(params.api, process.env);
  const cacheTtlMs =
    params.cacheTtlMs ?? resolveSkillIndexCacheTtlMs(params.api.config);
  let disabledBundledSkillNames = resolvedDisabledBundledSkillNames;
  const getDisabledBundledSkillNames = async () => {
    disabledBundledSkillNames ??= await readDisabledBundledSkillNames(stateDir);
    return disabledBundledSkillNames;
  };

  const indexes: Array<Map<string, IndexedSkill>> = [];
  for (const root of resolveSkillRoots(params)) {
    indexes.push(
      await getCachedSkillIndex(root.path, {
        cacheTtlMs,
        disabledSkillNames:
          root.source === "bundled"
            ? await getDisabledBundledSkillNames()
            : undefined,
        nowMs: params.nowMs,
        requireComplete,
        source: root.source,
      }),
    );
  }
  return indexes;
}

export async function resolveSkillInventory(
  params: SkillResolutionParams,
): Promise<SkillInventoryItem[] | undefined> {
  const policy = await resolveDisabledBundledSkillPolicy(
    resolveStateDirFromApi(params.api, process.env),
  );
  if (!policy.resolved) return;
  const inventory: SkillInventoryItem[] = [];
  const seen = new Set<string>();
  let indexes: Array<Map<string, IndexedSkill>>;
  try {
    indexes = await listSkillIndexes(params, policy.names, true);
  } catch (error) {
    logger.warn("failed to resolve complete skill inventory", { error });
    return;
  }
  for (const index of indexes) {
    for (const skill of index.values()) {
      const key = skill.name.toLowerCase();
      if (seen.has(key) || !skill.source) continue;
      seen.add(key);
      inventory.push({
        name: skill.name,
        source: skill.source,
        winnerFingerprint: skill.winnerFingerprint,
        fingerprint: skill.fingerprint,
      });
    }
  }
  return inventory;
}

function stripIndexOnlyFields(skill: IndexedSkill): AvailableSkill {
  const {
    fingerprint: _fingerprint,
    winnerFingerprint: _winnerFingerprint,
    ...available
  } = skill;
  return available;
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

export async function listAvailableSkills(
  params: SkillResolutionParams & {
    source?: AvailableSkill["source"];
    usageStats?: Record<string, SkillUsageStats>;
  },
): Promise<AvailableSkill[]> {
  const source = params.source?.trim().toLowerCase();
  const usageStats = params.usageStats ?? (await readSkillUsageStats(params));
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
        ...stripIndexOnlyFields(skill),
        ...(domainsBySkill
          ? {
              domains: [
                ...(domainsBySkill.get(canonicalIdentity(skill.name)) ?? []),
              ],
            }
          : {}),
      });
    }
  }
  return skills.sort((left, right) => {
    const sourceComparison =
      skillSourcePriority(left.source) - skillSourcePriority(right.source);
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
        ...stripIndexOnlyFields(skill),
        ...(domainsBySkill
          ? {
              domains: [
                ...(domainsBySkill.get(canonicalIdentity(skill.name)) ?? []),
              ],
            }
          : {}),
      };
    }
  }
}

export async function resolveAvailableSkills(
  params: SkillResolutionParams & {
    skillNames?: readonly string[];
  },
): Promise<AvailableSkill[]> {
  const names = uniqueSkillNames(normalizeSkillNames(params.skillNames));
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
