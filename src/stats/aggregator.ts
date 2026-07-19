import path from "node:path";
import { logger } from "../../api.js";
import type { SessionState } from "../session/index.js";
import type { IntentCatalogEntry } from "../types.js";
import {
  pluginRoot,
  statsPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
} from "../file-utils.js";
import { FALLBACK_INTENT_ID, isIntentComplexity } from "../constants.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RETENTION_MS = 90 * DAY_MS;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const REVIEW_MIN_RECOMMENDATIONS = 5;
const REVIEW_ADOPTION_THRESHOLD = 0.7;
const MAX_PROJECTION_REASON_KEYS = 32;
const MAX_PROJECTION_REASON_CODE_POINTS = 80;
const OTHER_PROJECTION_REASON = "other";
const statsAggregatorCache = new Map<string, StatsAggregator>();

type CountMap = Record<string, number>;
type ComplexityCounts = { low: number; medium: number; high: number };
type RecordedIntentResult = NonNullable<
  NonNullable<SessionState["intent"]>["result"]
>;
type RoutingCounts = {
  recommendationTurns: number;
  adoptedTurns: number;
  turnAdoptionRate: number;
  recommendedSkillOpportunities: number;
  adoptedSkillOpportunities: number;
  skillAdoptionRate: number;
};

type DailyProjectionCounts = {
  eligibleTurns: number;
  projectedTurns: number;
  fullFallbackTurns: number;
  fallbackReasons: CountMap;
};

type DailyBucketV1 = {
  turns: number;
  erroredTurns: number;
  intents: CountMap;
  skills: CountMap;
  tools: CountMap;
  routing: Omit<RoutingCounts, "turnAdoptionRate" | "skillAdoptionRate">;
};

type DailyBucket = DailyBucketV1 & {
  projection: DailyProjectionCounts;
};

type ProjectionStats = DailyProjectionCounts & {
  projectedRate: number;
  fullFallbackRate: number;
  averageOriginalIntentCount: number;
  averageCandidateIntentCount: number;
  catalogMeasurementTurns: number;
  averageOriginalCatalogCodePoints: number;
  averageCandidateCatalogCodePoints: number;
  averageDurationMs: number;
  supportReasons: CountMap;
  selectionReasons: CountMap;
};

type Stats = {
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  summary: {
    turns: number;
    completedTurns: number;
    erroredTurns: number;
    skillAssistedTurns: number;
    toolAssistedTurns: number;
    skillUsageCount: number;
    toolCallCount: number;
    averageConfidence: number;
    otherTurns: number;
    otherRate: number;
  };
  intents: Record<
    string,
    {
      turns: number;
      share: number;
      lastSeenAt: string;
      last7Days: number;
      averageConfidence: number;
      lowConfidenceTurns: number;
      complexity: ComplexityCounts;
      skillAssistedTurns: number;
      toolAssistedTurns: number;
      erroredTurns: number;
    }
  >;
  skills: Record<
    string,
    {
      usageTurns: number;
      recommendedTurns: number;
      adoptedTurns: number;
      adoptionRate: number;
      lastUsedAt?: string;
      last7DaysUsage: number;
      lifecycle: "active" | "stale" | "archive" | "never-used";
      needsReview: boolean;
    }
  >;
  routing: RoutingCounts & { byIntent: Record<string, RoutingCounts> };
  tools: Record<
    string,
    {
      calls: number;
      turns: number;
      errorCalls: number;
      averageDurationMs: number;
      lastUsedAt: string;
      last7DaysCalls: number;
    }
  >;
  projection: ProjectionStats;
  daily: Record<string, DailyBucket>;
  processedEvents: Record<string, string>;
};

type StatsV1 = Omit<Stats, "schemaVersion" | "projection" | "daily"> & {
  schemaVersion: 1;
  daily: Record<string, DailyBucketV1>;
};

function emptyRoutingCounts(): RoutingCounts {
  return {
    recommendationTurns: 0,
    adoptedTurns: 0,
    turnAdoptionRate: 0,
    recommendedSkillOpportunities: 0,
    adoptedSkillOpportunities: 0,
    skillAdoptionRate: 0,
  };
}

function emptyDailyProjectionCounts(): DailyProjectionCounts {
  return {
    eligibleTurns: 0,
    projectedTurns: 0,
    fullFallbackTurns: 0,
    fallbackReasons: {},
  };
}

function emptyProjectionStats(): ProjectionStats {
  return {
    ...emptyDailyProjectionCounts(),
    projectedRate: 0,
    fullFallbackRate: 0,
    averageOriginalIntentCount: 0,
    averageCandidateIntentCount: 0,
    catalogMeasurementTurns: 0,
    averageOriginalCatalogCodePoints: 0,
    averageCandidateCatalogCodePoints: 0,
    averageDurationMs: 0,
    supportReasons: {},
    selectionReasons: {},
  };
}

function createStats(nowIso: string): Stats {
  return {
    schemaVersion: 2,
    createdAt: nowIso,
    updatedAt: nowIso,
    summary: {
      turns: 0,
      completedTurns: 0,
      erroredTurns: 0,
      skillAssistedTurns: 0,
      toolAssistedTurns: 0,
      skillUsageCount: 0,
      toolCallCount: 0,
      averageConfidence: 0,
      otherTurns: 0,
      otherRate: 0,
    },
    intents: {},
    skills: {},
    routing: { ...emptyRoutingCounts(), byIntent: {} },
    tools: {},
    projection: emptyProjectionStats(),
    daily: {},
    processedEvents: {},
  };
}

function increment(counts: CountMap, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function resolveIntentId(
  resultIntent: string,
  definition: IntentCatalogEntry | undefined,
): string {
  if (definition) return definition.id;
  return resultIntent.match(/^([A-Za-z0-9_-]+)/)?.[1] ?? resultIntent;
}

const SKILL_RECOMMENDATION_PATTERN =
  /^\s*(?:(?:[-*]|\d+\.)\s*)?(?:(?:MUST|REQUIRED)\s+(?:(?:read|view)\s+)?skill|強烈建議\s+(?:(?:read|view)\s+)?skill)\s*:\s*([^\s,;]+)/iu;

function normalizeRecommendedSkillName(skill: string): string | undefined {
  const normalized = skill.replace(/^[`"']+|[`"'.!?]+$/g, "");
  return normalized || undefined;
}

export function extractRecommendedSkillsFromInstruction(
  instructionText: string | undefined,
): string[] {
  if (!instructionText) return [];
  return [
    ...new Set(
      instructionText
        .split(/\r?\n/)
        .map((line) => line.match(SKILL_RECOMMENDATION_PATTERN)?.[1])
        .filter((skill): skill is string => !!skill)
        .map(normalizeRecommendedSkillName)
        .filter((skill): skill is string => !!skill),
    ),
  ];
}

function createDailyBucket(): DailyBucket {
  return {
    turns: 0,
    erroredTurns: 0,
    intents: {},
    skills: {},
    tools: {},
    routing: {
      recommendationTurns: 0,
      adoptedTurns: 0,
      recommendedSkillOpportunities: 0,
      adoptedSkillOpportunities: 0,
    },
    projection: emptyDailyProjectionCounts(),
  };
}

function updateRoutingRates(routing: RoutingCounts): void {
  routing.turnAdoptionRate = rate(
    routing.adoptedTurns,
    routing.recommendationTurns,
  );
  routing.skillAdoptionRate = rate(
    routing.adoptedSkillOpportunities,
    routing.recommendedSkillOpportunities,
  );
}

function recomputeDerivedStats(stats: Stats, nowMs: number): void {
  stats.summary.otherRate = rate(stats.summary.otherTurns, stats.summary.turns);
  stats.projection.projectedRate = rate(
    stats.projection.projectedTurns,
    stats.projection.eligibleTurns,
  );
  stats.projection.fullFallbackRate = rate(
    stats.projection.fullFallbackTurns,
    stats.projection.eligibleTurns,
  );
  updateRoutingRates(stats.routing);

  const recentCutoffMs = nowMs - RECENT_WINDOW_MS;
  const recentBuckets = Object.entries(stats.daily).filter(
    ([date]) => Date.parse(`${date}T00:00:00.000Z`) >= recentCutoffMs,
  );

  for (const [intentId, intent] of Object.entries(stats.intents)) {
    intent.share = rate(intent.turns, stats.summary.turns);
    intent.last7Days = recentBuckets.reduce(
      (total, [, bucket]) => total + (bucket.intents[intentId] ?? 0),
      0,
    );
  }

  for (const [skillName, skill] of Object.entries(stats.skills)) {
    skill.adoptionRate = rate(skill.adoptedTurns, skill.recommendedTurns);
    skill.last7DaysUsage = recentBuckets.reduce(
      (total, [, bucket]) => total + (bucket.skills[skillName] ?? 0),
      0,
    );
    if (!skill.lastUsedAt) {
      skill.lifecycle = "never-used";
    } else {
      const ageMs = nowMs - Date.parse(skill.lastUsedAt);
      skill.lifecycle =
        ageMs >= 90 * DAY_MS
          ? "archive"
          : ageMs >= 30 * DAY_MS
            ? "stale"
            : "active";
    }
    skill.needsReview =
      skill.recommendedTurns >= REVIEW_MIN_RECOMMENDATIONS &&
      skill.adoptionRate < REVIEW_ADOPTION_THRESHOLD;
  }

  for (const [toolName, tool] of Object.entries(stats.tools)) {
    tool.last7DaysCalls = recentBuckets.reduce(
      (total, [, bucket]) => total + (bucket.tools[toolName] ?? 0),
      0,
    );
  }

  for (const routing of Object.values(stats.routing.byIntent)) {
    updateRoutingRates(routing);
  }
}

function pruneRollingData(stats: Stats, nowMs: number): void {
  const cutoffMs = nowMs - DAILY_RETENTION_MS;
  for (const date of Object.keys(stats.daily)) {
    if (Date.parse(`${date}T00:00:00.000Z`) < cutoffMs) {
      delete stats.daily[date];
    }
  }
  for (const [eventId, timestamp] of Object.entries(stats.processedEvents)) {
    if (Date.parse(timestamp) < cutoffMs) {
      delete stats.processedEvents[eventId];
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNumbers(
  value: unknown,
  keys: readonly string[],
): value is Record<string, number> {
  return (
    isRecord(value) &&
    keys.every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    )
  );
}

function isCountMap(value: unknown): value is CountMap {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (count) => typeof count === "number" && Number.isFinite(count),
    )
  );
}

function isBoundedProjectionReasonMap(value: unknown): value is CountMap {
  if (!isCountMap(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= MAX_PROJECTION_REASON_KEYS &&
    keys.every((key) => {
      const length = Array.from(key).length;
      return length > 0 && length <= MAX_PROJECTION_REASON_CODE_POINTS;
    })
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isUtcDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

const ROUTING_FIELDS = [
  "recommendationTurns",
  "adoptedTurns",
  "turnAdoptionRate",
  "recommendedSkillOpportunities",
  "adoptedSkillOpportunities",
  "skillAdoptionRate",
] as const;
const DAILY_ROUTING_FIELDS = [
  "recommendationTurns",
  "adoptedTurns",
  "recommendedSkillOpportunities",
  "adoptedSkillOpportunities",
] as const;
const DAILY_PROJECTION_FIELDS = [
  "eligibleTurns",
  "projectedTurns",
  "fullFallbackTurns",
] as const;

function isDailyProjectionCounts(
  value: unknown,
): value is DailyProjectionCounts {
  return (
    hasNumbers(value, DAILY_PROJECTION_FIELDS) &&
    isBoundedProjectionReasonMap(value.fallbackReasons)
  );
}

function isDailyBucketV1(value: unknown): value is DailyBucketV1 {
  return (
    hasNumbers(value, ["turns", "erroredTurns"]) &&
    isCountMap(value.intents) &&
    isCountMap(value.skills) &&
    isCountMap(value.tools) &&
    hasNumbers(value.routing, DAILY_ROUTING_FIELDS)
  );
}

function isProjectionStats(value: unknown): value is ProjectionStats {
  return (
    isDailyProjectionCounts(value) &&
    hasNumbers(value, [
      "projectedRate",
      "fullFallbackRate",
      "averageOriginalIntentCount",
      "averageCandidateIntentCount",
      "catalogMeasurementTurns",
      "averageOriginalCatalogCodePoints",
      "averageCandidateCatalogCodePoints",
      "averageDurationMs",
    ]) &&
    isBoundedProjectionReasonMap(value.supportReasons) &&
    isBoundedProjectionReasonMap(value.selectionReasons)
  );
}

function assertStatsBase(stats: unknown): asserts stats is Stats | StatsV1 {
  if (!isRecord(stats)) throw new Error("unsupported or invalid stats schema");
  if (
    !isIsoTimestamp(stats.createdAt) ||
    !isIsoTimestamp(stats.updatedAt) ||
    !hasNumbers(stats.summary, [
      "turns",
      "completedTurns",
      "erroredTurns",
      "skillAssistedTurns",
      "toolAssistedTurns",
      "skillUsageCount",
      "toolCallCount",
      "averageConfidence",
      "otherTurns",
      "otherRate",
    ]) ||
    !isRecord(stats.intents) ||
    !isRecord(stats.skills) ||
    !isRecord(stats.routing) ||
    !isRecord(stats.tools) ||
    !isRecord(stats.daily) ||
    !isRecord(stats.processedEvents)
  ) {
    throw new Error("unsupported or invalid stats schema");
  }

  if (!Object.keys(stats.daily).every(isUtcDateKey)) {
    throw new Error("unsupported or invalid stats schema");
  }

  for (const intent of Object.values(stats.intents)) {
    if (
      !hasNumbers(intent, [
        "turns",
        "share",
        "last7Days",
        "averageConfidence",
        "lowConfidenceTurns",
        "skillAssistedTurns",
        "toolAssistedTurns",
        "erroredTurns",
      ]) ||
      !isIsoTimestamp(intent.lastSeenAt) ||
      !hasNumbers(intent.complexity, ["low", "medium", "high"])
    ) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  for (const skill of Object.values(stats.skills)) {
    if (
      !hasNumbers(skill, [
        "usageTurns",
        "recommendedTurns",
        "adoptedTurns",
        "adoptionRate",
        "last7DaysUsage",
      ]) ||
      typeof skill.lifecycle !== "string" ||
      typeof skill.needsReview !== "boolean" ||
      (skill.lastUsedAt !== undefined && !isIsoTimestamp(skill.lastUsedAt))
    ) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  if (
    !hasNumbers(stats.routing, ROUTING_FIELDS) ||
    !isRecord(stats.routing.byIntent)
  ) {
    throw new Error("unsupported or invalid stats schema");
  }
  for (const routing of Object.values(stats.routing.byIntent)) {
    if (!hasNumbers(routing, ROUTING_FIELDS)) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  for (const tool of Object.values(stats.tools)) {
    if (
      !hasNumbers(tool, [
        "calls",
        "turns",
        "errorCalls",
        "averageDurationMs",
        "last7DaysCalls",
      ]) ||
      !isIsoTimestamp(tool.lastUsedAt)
    ) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  if (!Object.values(stats.processedEvents).every(isIsoTimestamp)) {
    throw new Error("unsupported or invalid stats schema");
  }
}

function migrateStatsV1(stats: StatsV1): Stats {
  return {
    ...stats,
    schemaVersion: 2,
    projection: emptyProjectionStats(),
    daily: Object.fromEntries(
      Object.entries(stats.daily).map(([date, bucket]) => [
        date,
        { ...bucket, projection: emptyDailyProjectionCounts() },
      ]),
    ),
  };
}

function loadStats(statsFilePath: string, eventTime: string): Stats {
  if (!fileExists(statsFilePath)) return createStats(eventTime);

  const stats = readJsonFile<unknown>(statsFilePath);
  assertStatsBase(stats);
  if (stats.schemaVersion === 1) {
    for (const bucket of Object.values(stats.daily)) {
      if (!isDailyBucketV1(bucket)) {
        throw new Error("unsupported or invalid stats schema");
      }
    }
    return migrateStatsV1(stats);
  }
  if (stats.schemaVersion !== 2 || !isProjectionStats(stats.projection)) {
    throw new Error("unsupported or invalid stats schema");
  }
  for (const bucket of Object.values(stats.daily)) {
    if (
      !isDailyBucketV1(bucket) ||
      !isDailyProjectionCounts(bucket.projection)
    ) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  return stats;
}

function recordSummaryStats(params: {
  stats: Stats;
  result: RecordedIntentResult;
  intentId: string;
  skillsUsed: string[];
  toolCallCount: number;
  errored: boolean;
}): void {
  const { stats, result, intentId, skillsUsed, toolCallCount, errored } =
    params;

  stats.summary.averageConfidence = rate(
    stats.summary.averageConfidence * stats.summary.turns + result.confidence,
    stats.summary.turns + 1,
  );
  stats.summary.turns += 1;
  stats.summary.completedTurns += errored ? 0 : 1;
  stats.summary.erroredTurns += errored ? 1 : 0;
  stats.summary.skillAssistedTurns += skillsUsed.length > 0 ? 1 : 0;
  stats.summary.toolAssistedTurns += toolCallCount > 0 ? 1 : 0;
  stats.summary.skillUsageCount += skillsUsed.length;
  stats.summary.toolCallCount += toolCallCount;
  stats.summary.otherTurns +=
    intentId.toLowerCase() === FALLBACK_INTENT_ID ? 1 : 0;
}

function recordIntentStats(params: {
  stats: Stats;
  intentId: string;
  result: RecordedIntentResult;
  eventTime: string;
  skillsUsed: string[];
  toolCallCount: number;
  errored: boolean;
}): void {
  const {
    stats,
    intentId,
    result,
    eventTime,
    skillsUsed,
    toolCallCount,
    errored,
  } = params;

  const intent = (stats.intents[intentId] ??= {
    turns: 0,
    share: 0,
    lastSeenAt: eventTime,
    last7Days: 0,
    averageConfidence: 0,
    lowConfidenceTurns: 0,
    complexity: { low: 0, medium: 0, high: 0 },
    skillAssistedTurns: 0,
    toolAssistedTurns: 0,
    erroredTurns: 0,
  });
  intent.averageConfidence = rate(
    intent.averageConfidence * intent.turns + result.confidence,
    intent.turns + 1,
  );
  intent.turns += 1;
  intent.lastSeenAt = eventTime;
  intent.lowConfidenceTurns += result.confidence < 0.8 ? 1 : 0;
  if (isIntentComplexity(result.complexity)) {
    intent.complexity[result.complexity] += 1;
  }
  intent.skillAssistedTurns += skillsUsed.length > 0 ? 1 : 0;
  intent.toolAssistedTurns += toolCallCount > 0 ? 1 : 0;
  intent.erroredTurns += errored ? 1 : 0;
}

function recordSkillStats(params: {
  stats: Stats;
  skillsUsed: string[];
  recommendedSkills: string[];
  adoptedSkills: string[];
  eventTime: string;
}): void {
  const { stats, skillsUsed, recommendedSkills, adoptedSkills, eventTime } =
    params;
  for (const skillName of new Set([...skillsUsed, ...recommendedSkills])) {
    const skill = (stats.skills[skillName] ??= {
      usageTurns: 0,
      recommendedTurns: 0,
      adoptedTurns: 0,
      adoptionRate: 0,
      last7DaysUsage: 0,
      lifecycle: "never-used",
      needsReview: false,
    });
    if (skillsUsed.includes(skillName)) {
      skill.usageTurns += 1;
      skill.lastUsedAt = eventTime;
    }
    skill.recommendedTurns += recommendedSkills.includes(skillName) ? 1 : 0;
    skill.adoptedTurns += adoptedSkills.includes(skillName) ? 1 : 0;
  }
}

function incrementRoutingAdoption(
  routing: Pick<
    RoutingCounts,
    | "recommendationTurns"
    | "adoptedTurns"
    | "recommendedSkillOpportunities"
    | "adoptedSkillOpportunities"
  >,
  recommendedSkills: number,
  adoptedSkills: number,
): void {
  if (recommendedSkills === 0) return;

  routing.recommendationTurns += 1;
  routing.adoptedTurns += adoptedSkills > 0 ? 1 : 0;
  routing.recommendedSkillOpportunities += recommendedSkills;
  routing.adoptedSkillOpportunities += adoptedSkills;
}

function recordToolStats(params: {
  stats: Stats;
  toolCalls: NonNullable<SessionState["toolCalls"]>;
  toolNames: string[];
  eventTime: string;
}): void {
  const { stats, toolCalls, toolNames, eventTime } = params;
  for (const toolName of toolNames) {
    const calls = toolCalls.filter((tool) => tool.name === toolName);
    const tool = (stats.tools[toolName] ??= {
      calls: 0,
      turns: 0,
      errorCalls: 0,
      averageDurationMs: 0,
      lastUsedAt: eventTime,
      last7DaysCalls: 0,
    });
    tool.averageDurationMs = rate(
      tool.averageDurationMs * tool.calls +
        calls.reduce((total, call) => total + (call.durationMs ?? 0), 0),
      tool.calls + calls.length,
    );
    tool.calls += calls.length;
    tool.turns += 1;
    tool.errorCalls += calls.filter((call) => call.error !== undefined).length;
    tool.lastUsedAt = eventTime;
  }
}

function incrementBoundedReason(counts: CountMap, reason: string): void {
  const normalized = Array.from(reason.trim())
    .slice(0, MAX_PROJECTION_REASON_CODE_POINTS)
    .join("");
  if (!normalized) return;
  if (counts[normalized] === undefined) {
    const keyCount = Object.keys(counts).length;
    if (keyCount >= MAX_PROJECTION_REASON_KEYS) {
      if (counts[OTHER_PROJECTION_REASON] !== undefined) {
        increment(counts, OTHER_PROJECTION_REASON);
      }
      return;
    }
    if (
      keyCount === MAX_PROJECTION_REASON_KEYS - 1 &&
      normalized !== OTHER_PROJECTION_REASON
    ) {
      increment(counts, OTHER_PROJECTION_REASON);
      return;
    }
  }
  increment(counts, normalized);
}

function recordProjectionStats(
  stats: Stats,
  projection: NonNullable<
    NonNullable<SessionState["intent"]>["intentProjection"]
  >,
): void {
  const currentTurns = stats.projection.eligibleTurns;
  stats.projection.averageOriginalIntentCount = rate(
    stats.projection.averageOriginalIntentCount * currentTurns +
      projection.originalIntentCount,
    currentTurns + 1,
  );
  stats.projection.averageCandidateIntentCount = rate(
    stats.projection.averageCandidateIntentCount * currentTurns +
      projection.candidateIntentCount,
    currentTurns + 1,
  );
  stats.projection.averageDurationMs = rate(
    stats.projection.averageDurationMs * currentTurns + projection.durationMs,
    currentTurns + 1,
  );
  stats.projection.eligibleTurns += 1;
  stats.projection.projectedTurns +=
    projection.decision === "projected" ? 1 : 0;
  stats.projection.fullFallbackTurns +=
    projection.decision === "full-fallback" ? 1 : 0;

  if (
    projection.originalCatalogCodePoints !== undefined &&
    projection.candidateCatalogCodePoints !== undefined
  ) {
    const measurements = stats.projection.catalogMeasurementTurns;
    stats.projection.averageOriginalCatalogCodePoints = rate(
      stats.projection.averageOriginalCatalogCodePoints * measurements +
        projection.originalCatalogCodePoints,
      measurements + 1,
    );
    stats.projection.averageCandidateCatalogCodePoints = rate(
      stats.projection.averageCandidateCatalogCodePoints * measurements +
        projection.candidateCatalogCodePoints,
      measurements + 1,
    );
    stats.projection.catalogMeasurementTurns += 1;
  }

  if (projection.fallbackReason) {
    incrementBoundedReason(
      stats.projection.fallbackReasons,
      projection.fallbackReason,
    );
  }
  for (const reason of new Set(projection.supportReasons)) {
    incrementBoundedReason(stats.projection.supportReasons, reason);
  }
  for (const reason of new Set(projection.selectionReasons)) {
    incrementBoundedReason(stats.projection.selectionReasons, reason);
  }
}

function recordDailyProjectionStats(
  daily: DailyBucket,
  projection: NonNullable<
    NonNullable<SessionState["intent"]>["intentProjection"]
  >,
): void {
  daily.projection.eligibleTurns += 1;
  daily.projection.projectedTurns +=
    projection.decision === "projected" ? 1 : 0;
  daily.projection.fullFallbackTurns +=
    projection.decision === "full-fallback" ? 1 : 0;
  if (projection.fallbackReason) {
    incrementBoundedReason(
      daily.projection.fallbackReasons,
      projection.fallbackReason,
    );
  }
}

function recordDailyStats(params: {
  stats: Stats;
  date: string;
  intentId: string;
  skillsUsed: string[];
  toolCalls: NonNullable<SessionState["toolCalls"]>;
  recommendedSkills: string[];
  adoptedSkills: string[];
  errored: boolean;
  projection?: NonNullable<
    NonNullable<SessionState["intent"]>["intentProjection"]
  >;
}): void {
  const {
    stats,
    date,
    intentId,
    skillsUsed,
    toolCalls,
    recommendedSkills,
    adoptedSkills,
    errored,
    projection,
  } = params;
  const daily = (stats.daily[date] ??= createDailyBucket());
  daily.turns += 1;
  daily.erroredTurns += errored ? 1 : 0;
  increment(daily.intents, intentId);
  for (const skillName of skillsUsed) increment(daily.skills, skillName);
  for (const call of toolCalls) increment(daily.tools, call.name);
  incrementRoutingAdoption(
    daily.routing,
    recommendedSkills.length,
    adoptedSkills.length,
  );
  if (projection) recordDailyProjectionStats(daily, projection);
}

export class StatsAggregator {
  private constructor(private readonly pluginRoot: string) {}

  static create(pluginRoot: string): StatsAggregator {
    const normalizedPluginRoot = path.resolve(pluginRoot);
    const existing = statsAggregatorCache.get(normalizedPluginRoot);
    if (existing) return existing;

    const aggregator = new StatsAggregator(normalizedPluginRoot);
    statsAggregatorCache.set(normalizedPluginRoot, aggregator);
    return aggregator;
  }

  record(
    sessionId: string | undefined,
    state: SessionState,
    intentDefinition?: IntentCatalogEntry,
    options: { nowMs?: number } = {},
  ): boolean {
    const result = state.intent?.result;
    const projection = state.intent?.intentProjection;
    const start = state.timestamps?.start;
    if (!sessionId || (!result && !projection) || !start) return false;

    const statsFilePath = statsPath(this.pluginRoot);
    try {
      const nowMs = options.nowMs ?? Date.now();
      const eventTime = new Date(state.timestamps?.end ?? nowMs).toISOString();
      const eventId = `${sessionId}:${start}`;

      const stats = loadStats(statsFilePath, eventTime);
      if (stats.processedEvents[eventId]) return false;

      const date = eventTime.slice(0, 10);
      stats.updatedAt = eventTime;
      stats.processedEvents[eventId] = eventTime;

      if (result) {
        const intentId = resolveIntentId(result.intent, intentDefinition);
        const skillsUsed = [
          ...new Set((state.skillsUsed ?? []).map((skill) => skill.name)),
        ];
        const recommendedSkills = extractRecommendedSkillsFromInstruction(
          state.intent?.instructionText,
        );
        const adoptedSkills = recommendedSkills.filter((skill) =>
          skillsUsed.includes(skill),
        );
        const toolCalls = state.toolCalls ?? [];
        const toolNames = [...new Set(toolCalls.map((tool) => tool.name))];
        const errored = state.error !== undefined;

        recordSummaryStats({
          stats,
          result,
          intentId,
          skillsUsed,
          toolCallCount: toolCalls.length,
          errored,
        });
        recordIntentStats({
          stats,
          intentId,
          result,
          eventTime,
          skillsUsed,
          toolCallCount: toolCalls.length,
          errored,
        });
        recordSkillStats({
          stats,
          skillsUsed,
          recommendedSkills,
          adoptedSkills,
          eventTime,
        });
        if (recommendedSkills.length > 0) {
          incrementRoutingAdoption(
            stats.routing,
            recommendedSkills.length,
            adoptedSkills.length,
          );
          incrementRoutingAdoption(
            (stats.routing.byIntent[intentId] ??= emptyRoutingCounts()),
            recommendedSkills.length,
            adoptedSkills.length,
          );
        }
        recordToolStats({ stats, toolCalls, toolNames, eventTime });
        if (projection) recordProjectionStats(stats, projection);
        recordDailyStats({
          stats,
          date,
          intentId,
          skillsUsed,
          toolCalls,
          recommendedSkills,
          adoptedSkills,
          errored,
          projection,
        });
      } else if (projection) {
        recordProjectionStats(stats, projection);
        const daily = (stats.daily[date] ??= createDailyBucket());
        recordDailyProjectionStats(daily, projection);
      }

      pruneRollingData(stats, nowMs);
      recomputeDerivedStats(stats, nowMs);
      return safeWriteJson(statsFilePath, stats, "failed to write stats file");
    } catch (err) {
      logger.warn("failed to update stats file", {
        error: err,
        path: statsFilePath,
      });
      return false;
    }
  }
}

export const defaultStatsAggregator = StatsAggregator.create(pluginRoot);
