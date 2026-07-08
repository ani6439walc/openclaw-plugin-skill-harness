import { logger } from "../../api.js";
import {
  fileExists,
  readJsonFile,
  resolvePluginDataRoot,
  statsPath,
} from "../file-utils.js";
import type { SkillResolutionParams, SkillUsageStats } from "./types.js";

const PLUGIN_ID = "skill-harness";

interface RawSkillStats {
  usageTurns?: unknown;
  recommendedTurns?: unknown;
  adoptedTurns?: unknown;
  adoptionRate?: unknown;
  lastUsedAt?: unknown;
  last7DaysUsage?: unknown;
  lifecycle?: unknown;
  needsReview?: unknown;
}

interface RawStatsFile {
  skills?: unknown;
}

const DEFAULT_USAGE_STATS: SkillUsageStats = {
  usage_turns: 0,
  recommended_turns: 0,
  adopted_turns: 0,
  adoption_rate: 0,
  last_7_days_usage: 0,
  lifecycle: "never-used",
  needs_review: false,
};

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lifecycleValue(value: unknown): SkillUsageStats["lifecycle"] {
  return value === "active" ||
    value === "stale" ||
    value === "archive" ||
    value === "never-used"
    ? value
    : "never-used";
}

function normalizeStats(raw: RawSkillStats | undefined): SkillUsageStats {
  if (!raw) return { ...DEFAULT_USAGE_STATS };
  const stats: SkillUsageStats = {
    usage_turns: numberValue(raw.usageTurns),
    recommended_turns: numberValue(raw.recommendedTurns),
    adopted_turns: numberValue(raw.adoptedTurns),
    adoption_rate: numberValue(raw.adoptionRate),
    last_7_days_usage: numberValue(raw.last7DaysUsage),
    lifecycle: lifecycleValue(raw.lifecycle),
    needs_review: raw.needsReview === true,
  };
  if (typeof raw.lastUsedAt === "string" && raw.lastUsedAt.trim()) {
    stats.last_used_at = raw.lastUsedAt;
  }
  return stats;
}

function statsFilePath(params: SkillResolutionParams): string {
  const stateDir = params.api.runtime.state.resolveStateDir(process.env);
  return statsPath(resolvePluginDataRoot(stateDir, PLUGIN_ID));
}

export async function readSkillUsageStats(
  params: SkillResolutionParams,
): Promise<Record<string, SkillUsageStats>> {
  const filePath = statsFilePath(params);
  let parsed: RawStatsFile;
  try {
    if (!fileExists(filePath)) return {};
    parsed = readJsonFile<RawStatsFile>(filePath);
  } catch (err) {
    logger.warn("failed to read skill usage stats", {
      error: err,
      path: filePath,
    });
    return {};
  }

  if (
    !parsed.skills ||
    typeof parsed.skills !== "object" ||
    Array.isArray(parsed.skills)
  ) {
    return {};
  }

  const stats: Record<string, SkillUsageStats> = {};
  for (const [skillName, rawSkillStats] of Object.entries(parsed.skills)) {
    if (
      !rawSkillStats ||
      typeof rawSkillStats !== "object" ||
      Array.isArray(rawSkillStats)
    ) {
      continue;
    }
    stats[skillName.toLowerCase()] = normalizeStats(
      rawSkillStats as RawSkillStats,
    );
  }
  return stats;
}

export function skillUsageStatsForName(
  stats: Record<string, SkillUsageStats>,
  skillName: string,
): SkillUsageStats {
  return stats[skillName.toLowerCase()] ?? { ...DEFAULT_USAGE_STATS };
}
