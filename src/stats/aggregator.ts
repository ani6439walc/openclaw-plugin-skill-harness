import { createHash } from "node:crypto";
import path from "node:path";
import { logger } from "../../api.js";
import { resolveTurnEventId } from "../session/index.js";
import type { SessionState } from "../session/index.js";
import type { TurnCurationResult } from "../curation/types.js";
import type { IntentCatalogEntry } from "../types.js";
import {
  packageRoot,
  statsPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
} from "../file-utils.js";
import { FALLBACK_INTENT_ID, isIntentComplexity } from "../constants.js";
import type { SkillInventoryItem, SkillSource } from "../skills/types.js";
import { SKILL_SOURCE_ORDER } from "../skills/types.js";
import { canonicalIdentity } from "../normalize.js";
import { isRecord } from "../guards.js";
import { getOrCache } from "../singleton.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RETENTION_MS = 90 * DAY_MS;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const REVIEW_MIN_RECOMMENDATIONS = 5;
const REVIEW_ADOPTION_THRESHOLD = 0.7;
const SKILL_PLACEMENT_MIN_OBSERVED_TURNS = 20;
const MAX_PROJECTION_REASON_KEYS = 32;
const MAX_PROJECTION_REASON_CODE_POINTS = 80;
const OTHER_PROJECTION_REASON = "other";
const MAX_DAILY_ATTRIBUTION_KEYS = 64;
const MAX_DAILY_ATTRIBUTION_KEY_CODE_POINTS = 128;
const OTHER_DAILY_ATTRIBUTION_KEY = "__other__";
const DAILY_ATTRIBUTION_VALUE_PREFIX = "value:";
const LATENCY_BUCKETS = [
  "unknown",
  "0-99",
  "100-499",
  "500-999",
  "1000-4999",
  "5000+",
] as const;
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
type DailyRoutingCounts = Omit<
  RoutingCounts,
  "turnAdoptionRate" | "skillAdoptionRate"
>;
type DailyIntentOutcomes = {
  turns: number;
  completedTurns: number;
  erroredTurns: number;
  skillAssistedTurns: number;
  toolAssistedTurns: number;
};
type DailySkillRouting = {
  recommendedTurns: number;
  adoptedTurns: number;
};
type LatencyBucket = (typeof LATENCY_BUCKETS)[number];
type LatencyHistogram = Record<LatencyBucket, number>;

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
  routing: DailyRoutingCounts;
};

type DailyBucketV3 = DailyBucketV1 & {
  projection: DailyProjectionCounts;
};

type DailyBucket = DailyBucketV3 & {
  intentOutcomes: Record<string, DailyIntentOutcomes>;
  intentRouting: Record<string, DailyRoutingCounts>;
  skillRouting: Record<string, DailySkillRouting>;
  toolErrors: CountMap;
  curation?: DailyCurationStats;
};

export interface DailyCurationStats {
  appliedRevisions: number;
  candidatesKept: number;
  candidatesAdded: number;
}

export interface CurationStats {
  appliedRevisions: number;
  candidatesKept: number;
  candidatesAdded: number;
  recommendedExperiencesSelected: number;
  lastAppliedAt?: string;
}

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

interface SkillInventoryObservation extends SkillInventoryItem {
  winnerFingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstSeenTurn: number;
  lastSeenTurn: number;
  observedTurns: number;
  usageTurns: number;
  recommendedTurns: number;
}

interface AgentSkillInventoryObservation {
  firstObservedAt: string;
  lastObservedAt: string;
  observedTurns: number;
  skills: Record<string, SkillInventoryObservation>;
}

interface SkillInventoryStats {
  startedAt: string;
  agents: Record<string, AgentSkillInventoryObservation>;
}

export type SkillPlacementReason = "low-adoption" | "zero-recommendation-usage";

export interface SkillPlacementCandidate {
  epochKey: string;
  agentId: string;
  name: string;
  source: SkillSource;
  winnerFingerprint: string;
  fingerprint: string;
  reason: SkillPlacementReason;
  observedTurns: number;
  usageTurns: number;
  recommendedTurns: number;
  adoptionRate?: number;
}

type Stats = {
  schemaVersion: 4;
  createdAt: string;
  updatedAt: string;
  attribution: { startedAt: string };
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
    curationAppliedCount?: number;
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
      latencyHistogram: LatencyHistogram;
      lastUsedAt: string;
      last7DaysCalls: number;
    }
  >;
  projection: ProjectionStats;
  skillInventory: SkillInventoryStats;
  curation?: CurationStats;
  daily: Record<string, DailyBucket>;
  processedEvents: Record<string, string>;
};

type ToolStatsV3 = Omit<Stats["tools"][string], "latencyHistogram">;

type StatsV3 = Omit<
  Stats,
  "schemaVersion" | "attribution" | "daily" | "tools"
> & {
  schemaVersion: 3;
  tools: Record<string, ToolStatsV3>;
  daily: Record<string, DailyBucketV3>;
};

type StatsV2 = Omit<StatsV3, "schemaVersion" | "skillInventory"> & {
  schemaVersion: 2;
};

type StatsV1 = Omit<StatsV2, "schemaVersion" | "projection" | "daily"> & {
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

function emptyDailyIntentOutcomes(): DailyIntentOutcomes {
  return {
    turns: 0,
    completedTurns: 0,
    erroredTurns: 0,
    skillAssistedTurns: 0,
    toolAssistedTurns: 0,
  };
}

function emptyDailySkillRouting(): DailySkillRouting {
  return { recommendedTurns: 0, adoptedTurns: 0 };
}

function emptyLatencyHistogram(): LatencyHistogram {
  return {
    unknown: 0,
    "0-99": 0,
    "100-499": 0,
    "500-999": 0,
    "1000-4999": 0,
    "5000+": 0,
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

function emptyCurationStats(): CurationStats {
  return {
    appliedRevisions: 0,
    candidatesKept: 0,
    candidatesAdded: 0,
    recommendedExperiencesSelected: 0,
  };
}

function createStats(nowIso: string): Stats {
  return {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    attribution: { startedAt: nowIso },
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
      curationAppliedCount: 0,
    },
    intents: {},
    skills: {},
    routing: { ...emptyRoutingCounts(), byIntent: {} },
    tools: {},
    projection: emptyProjectionStats(),
    skillInventory: { startedAt: nowIso, agents: {} },
    curation: emptyCurationStats(),
    daily: {},
    processedEvents: {},
  };
}

function increment(counts: CountMap, key: string, amount = 1): void {
  setOwnRecordValue(counts, key, (ownRecordValue(counts, key) ?? 0) + amount);
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
    intentOutcomes: {},
    intentRouting: {},
    skillRouting: {},
    toolErrors: {},
    curation: {
      appliedRevisions: 0,
      candidatesKept: 0,
      candidatesAdded: 0,
    },
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
      (total, [, bucket]) =>
        total + (ownRecordValue(bucket.intents, intentId) ?? 0),
      0,
    );
  }

  for (const [skillName, skill] of Object.entries(stats.skills)) {
    skill.adoptionRate = rate(skill.adoptedTurns, skill.recommendedTurns);
    skill.last7DaysUsage = recentBuckets.reduce(
      (total, [, bucket]) =>
        total + (ownRecordValue(bucket.skills, skillName) ?? 0),
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
      (total, [, bucket]) =>
        total + (ownRecordValue(bucket.tools, toolName) ?? 0),
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function hasNonNegativeIntegers(
  value: unknown,
  keys: readonly string[],
): value is Record<string, number> {
  return (
    isRecord(value) && keys.every((key) => isNonNegativeInteger(value[key]))
  );
}

function isSkillSource(value: unknown): value is SkillSource {
  return (
    typeof value === "string" &&
    (SKILL_SOURCE_ORDER as readonly string[]).includes(value)
  );
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSkillInventoryStats(value: unknown): value is SkillInventoryStats {
  if (
    !isRecord(value) ||
    !isIsoTimestamp(value.startedAt) ||
    !isRecord(value.agents)
  ) {
    return false;
  }
  return Object.entries(value.agents).every(([agentId, agent]) => {
    if (
      !agentId ||
      agentId.trim() !== agentId ||
      !isRecord(agent) ||
      !isIsoTimestamp(agent.firstObservedAt) ||
      !isIsoTimestamp(agent.lastObservedAt) ||
      !isNonNegativeInteger(agent.observedTurns) ||
      agent.observedTurns === 0 ||
      !isRecord(agent.skills)
    ) {
      return false;
    }
    const observedTurns = agent.observedTurns;
    return Object.entries(agent.skills).every(
      ([skillKey, skill]) =>
        isRecord(skill) &&
        typeof skill.name === "string" &&
        skill.name.trim().length > 0 &&
        skill.name === skill.name.trim() &&
        skillKey === skill.name.toLowerCase() &&
        isSkillSource(skill.source) &&
        isSha256Fingerprint(skill.winnerFingerprint) &&
        isSha256Fingerprint(skill.fingerprint) &&
        isIsoTimestamp(skill.firstSeenAt) &&
        isIsoTimestamp(skill.lastSeenAt) &&
        isNonNegativeInteger(skill.firstSeenTurn) &&
        isNonNegativeInteger(skill.lastSeenTurn) &&
        isNonNegativeInteger(skill.observedTurns) &&
        isNonNegativeInteger(skill.usageTurns) &&
        isNonNegativeInteger(skill.recommendedTurns) &&
        skill.firstSeenTurn > 0 &&
        skill.firstSeenTurn <= skill.lastSeenTurn &&
        skill.lastSeenTurn <= observedTurns &&
        skill.observedTurns === skill.lastSeenTurn - skill.firstSeenTurn + 1 &&
        skill.usageTurns <= skill.observedTurns &&
        skill.recommendedTurns <= skill.observedTurns,
    );
  });
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
const DAILY_INTENT_OUTCOME_FIELDS = [
  "turns",
  "completedTurns",
  "erroredTurns",
  "skillAssistedTurns",
  "toolAssistedTurns",
] as const;
const DAILY_SKILL_ROUTING_FIELDS = [
  "recommendedTurns",
  "adoptedTurns",
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

function isDailyBucketV3(value: unknown): value is DailyBucketV3 {
  return (
    isDailyBucketV1(value) &&
    isRecord(value) &&
    isDailyProjectionCounts((value as Record<string, unknown>).projection)
  );
}

function isBoundedDailyAttributionMap<T>(
  value: unknown,
  isEntry: (entry: unknown) => entry is T,
): value is Record<string, T> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_DAILY_ATTRIBUTION_KEYS &&
    (entries.length < MAX_DAILY_ATTRIBUTION_KEYS ||
      Object.hasOwn(value, OTHER_DAILY_ATTRIBUTION_KEY)) &&
    entries.every(([key, entry]) => {
      if (key === OTHER_DAILY_ATTRIBUTION_KEY) return isEntry(entry);
      if (!key.startsWith(DAILY_ATTRIBUTION_VALUE_PREFIX)) return false;
      const rawKey = key.slice(DAILY_ATTRIBUTION_VALUE_PREFIX.length);
      const length = Array.from(rawKey).length;
      return (
        length > 0 &&
        length <= MAX_DAILY_ATTRIBUTION_KEY_CODE_POINTS &&
        isEntry(entry)
      );
    })
  );
}

function isDailyIntentOutcomes(value: unknown): value is DailyIntentOutcomes {
  return hasNonNegativeIntegers(value, DAILY_INTENT_OUTCOME_FIELDS);
}

function isDailySkillRouting(value: unknown): value is DailySkillRouting {
  return hasNonNegativeIntegers(value, DAILY_SKILL_ROUTING_FIELDS);
}

function isLatencyHistogram(value: unknown): value is LatencyHistogram {
  return (
    isRecord(value) &&
    Object.keys(value).length === LATENCY_BUCKETS.length &&
    LATENCY_BUCKETS.every(
      (bucket) =>
        Object.hasOwn(value, bucket) && isNonNegativeInteger(value[bucket]),
    )
  );
}

function isDailyCurationStats(value: unknown): value is DailyCurationStats {
  return (
    isRecord(value) &&
    hasNonNegativeIntegers(value, [
      "appliedRevisions",
      "candidatesKept",
      "candidatesAdded",
    ])
  );
}

function isDailyBucket(value: unknown): value is DailyBucket {
  if (!isDailyBucketV3(value) || !isRecord(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedDailyAttributionMap(
      record.intentOutcomes,
      isDailyIntentOutcomes,
    ) &&
    isBoundedDailyAttributionMap(record.intentRouting, (entry) =>
      hasNonNegativeIntegers(entry, DAILY_ROUTING_FIELDS),
    ) &&
    isBoundedDailyAttributionMap(record.skillRouting, isDailySkillRouting) &&
    isBoundedDailyAttributionMap(record.toolErrors, isNonNegativeInteger) &&
    (record.curation === undefined || isDailyCurationStats(record.curation))
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

function assertStatsBase(
  stats: unknown,
): asserts stats is Stats | StatsV3 | StatsV2 | StatsV1 {
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

function migrateStatsV1(stats: StatsV1): StatsV2 {
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

function migrateStatsV2(stats: StatsV2, eventTime: string): StatsV3 {
  return {
    ...stats,
    schemaVersion: 3,
    skillInventory: { startedAt: eventTime, agents: {} },
  };
}

function assertStatsV2(stats: StatsV2): void {
  if (!isProjectionStats(stats.projection)) {
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
}

function assertStatsV3(
  stats: Pick<Stats, "projection" | "skillInventory"> & {
    daily: Record<string, DailyBucketV3>;
  },
): void {
  if (
    !isProjectionStats(stats.projection) ||
    !isSkillInventoryStats(stats.skillInventory)
  ) {
    throw new Error("unsupported or invalid stats schema");
  }
  for (const bucket of Object.values(stats.daily)) {
    if (!isDailyBucketV3(bucket)) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
}

function migrateStatsV3(stats: StatsV3, eventTime: string): Stats {
  return {
    ...stats,
    schemaVersion: 4,
    attribution: { startedAt: eventTime },
    tools: Object.fromEntries(
      Object.entries(stats.tools).map(([name, tool]) => [
        name,
        { ...tool, latencyHistogram: emptyLatencyHistogram() },
      ]),
    ),
    daily: Object.fromEntries(
      Object.entries(stats.daily).map(([date, bucket]) => [
        date,
        {
          ...bucket,
          intentOutcomes: {},
          intentRouting: {},
          skillRouting: {},
          toolErrors: {},
        },
      ]),
    ),
  };
}

function assertStatsV4(stats: Stats): void {
  if (!isIsoTimestamp(stats.attribution.startedAt)) {
    throw new Error("unsupported or invalid stats schema");
  }
  for (const tool of Object.values(stats.tools)) {
    if (!isLatencyHistogram(tool.latencyHistogram)) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
  for (const bucket of Object.values(stats.daily)) {
    if (!isDailyBucket(bucket)) {
      throw new Error("unsupported or invalid stats schema");
    }
  }
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
    const migrated = migrateStatsV1(stats);
    assertStatsV2(migrated);
    return canonicalizeSkillStats(
      migrateStatsV3(migrateStatsV2(migrated, eventTime), eventTime),
      eventTime,
    );
  }
  if (stats.schemaVersion === 2) {
    assertStatsV2(stats);
    return canonicalizeSkillStats(
      migrateStatsV3(migrateStatsV2(stats, eventTime), eventTime),
      eventTime,
    );
  }
  if (stats.schemaVersion === 3) {
    assertStatsV3(stats);
    return canonicalizeSkillStats(migrateStatsV3(stats, eventTime), eventTime);
  }
  if (stats.schemaVersion !== 4) {
    throw new Error("unsupported or invalid stats schema");
  }
  assertStatsV3(stats);
  assertStatsV4(stats);
  return canonicalizeSkillStats(stats, eventTime);
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

  const intent = getOrCreateOwnRecordValue(stats.intents, intentId, () => ({
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
  }));
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

function canonicalizeCountMap(counts: CountMap): CountMap {
  const canonical: CountMap = {};
  for (const [name, count] of Object.entries(counts)) {
    const key = canonicalIdentity(name);
    setOwnRecordValue(
      canonical,
      key,
      (ownRecordValue(canonical, key) ?? 0) + count,
    );
  }
  return canonical;
}

function canonicalizeSkillStats(stats: Stats, eventTime: string): Stats {
  const canonical: Stats["skills"] = {};
  for (const [name, skill] of Object.entries(stats.skills)) {
    const key = canonicalIdentity(name);
    const existing = ownRecordValue(canonical, key);
    const lastUsedAt =
      !existing?.lastUsedAt ||
      (skill.lastUsedAt !== undefined &&
        Date.parse(skill.lastUsedAt) > Date.parse(existing.lastUsedAt))
        ? skill.lastUsedAt
        : existing.lastUsedAt;
    setOwnRecordValue(canonical, key, {
      ...skill,
      usageTurns: (existing?.usageTurns ?? 0) + skill.usageTurns,
      recommendedTurns:
        (existing?.recommendedTurns ?? 0) + skill.recommendedTurns,
      adoptedTurns: (existing?.adoptedTurns ?? 0) + skill.adoptedTurns,
      ...(lastUsedAt ? { lastUsedAt } : {}),
    });
  }
  stats.skills = canonical;
  for (const bucket of Object.values(stats.daily)) {
    bucket.skills = canonicalizeCountMap(bucket.skills);
  }
  recomputeDerivedStats(stats, Date.parse(eventTime));
  return stats;
}

function compareCanonicalSkillNames(left: string, right: string): number {
  const leftKey = canonicalIdentity(left);
  const rightKey = canonicalIdentity(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
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
    const skill = getOrCreateOwnRecordValue<Stats["skills"][string]>(
      stats.skills,
      skillName,
      () => ({
        usageTurns: 0,
        recommendedTurns: 0,
        adoptedTurns: 0,
        adoptionRate: 0,
        last7DaysUsage: 0,
        lifecycle: "never-used",
        needsReview: false,
      }),
    );
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

function latencyBucket(durationMs: unknown): LatencyBucket {
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "unknown";
  }
  if (durationMs < 100) return "0-99";
  if (durationMs < 500) return "100-499";
  if (durationMs < 1000) return "500-999";
  if (durationMs < 5000) return "1000-4999";
  return "5000+";
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
    const tool = getOrCreateOwnRecordValue(stats.tools, toolName, () => ({
      calls: 0,
      turns: 0,
      errorCalls: 0,
      averageDurationMs: 0,
      latencyHistogram: emptyLatencyHistogram(),
      lastUsedAt: eventTime,
      last7DaysCalls: 0,
    }));
    tool.averageDurationMs = rate(
      tool.averageDurationMs * tool.calls +
        calls.reduce((total, call) => total + (call.durationMs ?? 0), 0),
      tool.calls + calls.length,
    );
    tool.calls += calls.length;
    tool.turns += 1;
    tool.errorCalls += calls.filter((call) => call.error !== undefined).length;
    for (const call of calls) {
      increment(tool.latencyHistogram, latencyBucket(call.durationMs));
    }
    tool.lastUsedAt = eventTime;
  }
}

function incrementBoundedReason(counts: CountMap, reason: string): void {
  const normalized = Array.from(reason.trim())
    .slice(0, MAX_PROJECTION_REASON_CODE_POINTS)
    .join("");
  if (!normalized) return;
  if (ownRecordValue(counts, normalized) === undefined) {
    const keyCount = Object.keys(counts).length;
    if (keyCount >= MAX_PROJECTION_REASON_KEYS) {
      if (ownRecordValue(counts, OTHER_PROJECTION_REASON) !== undefined) {
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

function boundedDailyAttributionKey<T>(
  entries: Record<string, T>,
  rawKey: string,
): string {
  const normalized = rawKey.trim();
  if (
    !normalized ||
    Array.from(normalized).length > MAX_DAILY_ATTRIBUTION_KEY_CODE_POINTS
  ) {
    return OTHER_DAILY_ATTRIBUTION_KEY;
  }
  const key = `${DAILY_ATTRIBUTION_VALUE_PREFIX}${normalized}`;
  if (ownRecordValue(entries, key) !== undefined) return key;
  const keyCount = Object.keys(entries).length;
  if (keyCount >= MAX_DAILY_ATTRIBUTION_KEYS) {
    return OTHER_DAILY_ATTRIBUTION_KEY;
  }
  return keyCount === MAX_DAILY_ATTRIBUTION_KEYS - 1
    ? OTHER_DAILY_ATTRIBUTION_KEY
    : key;
}

function getOrCreateBoundedDailyAttributionEntry<T>(
  entries: Record<string, T>,
  rawKey: string,
  create: () => T,
): T {
  return getOrCreateOwnRecordValue(
    entries,
    boundedDailyAttributionKey(entries, rawKey),
    create,
  );
}

function incrementBoundedDailyAttribution(
  counts: CountMap,
  rawKey: string,
): void {
  increment(counts, boundedDailyAttributionKey(counts, rawKey));
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
  const daily = getOrCreateOwnRecordValue(stats.daily, date, createDailyBucket);
  daily.turns += 1;
  daily.erroredTurns += errored ? 1 : 0;
  increment(daily.intents, intentId);
  for (const skillName of skillsUsed) increment(daily.skills, skillName);
  for (const call of toolCalls) increment(daily.tools, call.name);
  const outcomes = getOrCreateBoundedDailyAttributionEntry(
    daily.intentOutcomes,
    intentId,
    emptyDailyIntentOutcomes,
  );
  outcomes.turns += 1;
  outcomes.completedTurns += errored ? 0 : 1;
  outcomes.erroredTurns += errored ? 1 : 0;
  outcomes.skillAssistedTurns += skillsUsed.length > 0 ? 1 : 0;
  outcomes.toolAssistedTurns += toolCalls.length > 0 ? 1 : 0;
  incrementRoutingAdoption(
    daily.routing,
    recommendedSkills.length,
    adoptedSkills.length,
  );
  if (recommendedSkills.length > 0) {
    incrementRoutingAdoption(
      getOrCreateBoundedDailyAttributionEntry(
        daily.intentRouting,
        intentId,
        () => ({
          recommendationTurns: 0,
          adoptedTurns: 0,
          recommendedSkillOpportunities: 0,
          adoptedSkillOpportunities: 0,
        }),
      ),
      recommendedSkills.length,
      adoptedSkills.length,
    );
  }
  for (const skillName of recommendedSkills) {
    const skillRouting = getOrCreateBoundedDailyAttributionEntry(
      daily.skillRouting,
      skillName,
      emptyDailySkillRouting,
    );
    skillRouting.recommendedTurns += 1;
    skillRouting.adoptedTurns += adoptedSkills.includes(skillName) ? 1 : 0;
  }
  for (const call of toolCalls) {
    if (call.error !== undefined) {
      incrementBoundedDailyAttribution(daily.toolErrors, call.name);
    }
  }
  if (projection) recordDailyProjectionStats(daily, projection);
}

function createSkillInventoryObservation(params: {
  skill: SkillInventoryItem & { winnerFingerprint: string };
  eventTime: string;
  agentTurn: number;
  used: boolean;
  recommended: boolean;
}): SkillInventoryObservation {
  const { skill, eventTime, agentTurn, used, recommended } = params;
  return {
    ...skill,
    firstSeenAt: eventTime,
    lastSeenAt: eventTime,
    firstSeenTurn: agentTurn,
    lastSeenTurn: agentTurn,
    observedTurns: 1,
    usageTurns: used ? 1 : 0,
    recommendedTurns: recommended ? 1 : 0,
  };
}

function ownRecordValue<T>(
  record: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwnRecordValue<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function getOrCreateOwnRecordValue<T>(
  record: Record<string, T>,
  key: string,
  create: () => T,
): T {
  const existing = ownRecordValue(record, key);
  if (existing !== undefined) return existing;
  const value = create();
  setOwnRecordValue(record, key, value);
  return value;
}

function skillPlacementEpochKey(params: {
  inventoryStartedAt: string;
  agentId: string;
  skill: SkillInventoryObservation;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.inventoryStartedAt,
        params.agentId,
        canonicalIdentity(params.skill.name),
        params.skill.source,
        params.skill.winnerFingerprint,
        params.skill.fingerprint,
        params.skill.firstSeenTurn,
      ]),
    )
    .digest("hex");
}

function recordSkillInventoryObservation(params: {
  stats: Stats;
  agentId: string;
  skills: readonly (SkillInventoryItem & { winnerFingerprint: string })[];
  skillsUsed: readonly string[];
  recommendedSkills: readonly string[];
  eventTime: string;
}): void {
  const agentId = params.agentId.trim();
  if (!agentId) return;
  let agent = ownRecordValue(params.stats.skillInventory.agents, agentId);
  if (!agent) {
    agent = {
      firstObservedAt: params.eventTime,
      lastObservedAt: params.eventTime,
      observedTurns: 0,
      skills: {},
    };
    setOwnRecordValue(params.stats.skillInventory.agents, agentId, agent);
  }
  const agentTurn = agent.observedTurns + 1;
  const used = new Set(params.skillsUsed.map((name) => name.toLowerCase()));
  const recommended = new Set(
    params.recommendedSkills.map((name) => name.toLowerCase()),
  );
  const seen = new Set<string>();

  for (const rawSkill of params.skills) {
    const name = rawSkill.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const skill = { ...rawSkill, name };
    const previous = ownRecordValue(agent.skills, key);
    const reset =
      !previous ||
      previous.source !== skill.source ||
      previous.winnerFingerprint !== skill.winnerFingerprint ||
      previous.fingerprint !== skill.fingerprint ||
      previous.lastSeenTurn !== agentTurn - 1;
    if (reset) {
      setOwnRecordValue(
        agent.skills,
        key,
        createSkillInventoryObservation({
          skill,
          eventTime: params.eventTime,
          agentTurn,
          used: used.has(key),
          recommended: recommended.has(key),
        }),
      );
      continue;
    }
    previous.lastSeenAt = params.eventTime;
    previous.lastSeenTurn = agentTurn;
    previous.observedTurns += 1;
    previous.usageTurns += used.has(key) ? 1 : 0;
    previous.recommendedTurns += recommended.has(key) ? 1 : 0;
  }

  agent.lastObservedAt = params.eventTime;
  agent.observedTurns = agentTurn;
}

export interface StatsRecordOptions {
  nowMs?: number;
  skillInventory?: {
    agentId: string;
    skills: readonly (SkillInventoryItem & { winnerFingerprint: string })[];
  };
}

export class StatsAggregator {
  private acceptedTurnCount: number | undefined;

  private constructor(private readonly pluginRoot: string) {}

  static create(pluginRoot: string): StatsAggregator {
    return getOrCache(
      statsAggregatorCache,
      pluginRoot,
      (normalizedRoot) => new StatsAggregator(normalizedRoot),
    );
  }

  listProcessedEventIds(): Set<string> {
    const statsFilePath = statsPath(this.pluginRoot);
    if (!fileExists(statsFilePath)) return new Set();
    try {
      const stats = readJsonFile<unknown>(statsFilePath);
      assertStatsBase(stats);
      if (stats.schemaVersion !== 4) {
        throw new Error("unsupported or invalid stats schema");
      }
      assertStatsV3(stats);
      assertStatsV4(stats);
      return new Set(Object.keys(stats.processedEvents));
    } catch (error) {
      logger.warn("failed to read processed stats events", {
        error,
        path: statsFilePath,
      });
      return new Set();
    }
  }

  selectSkillPlacementCandidate(
    agentId: string,
    excludedEpochKeys: ReadonlySet<string> = new Set(),
  ): SkillPlacementCandidate | undefined {
    const statsFilePath = statsPath(this.pluginRoot);
    try {
      const stats = loadStats(statsFilePath, new Date().toISOString());
      const agent = ownRecordValue(stats.skillInventory.agents, agentId);
      if (!agent) return undefined;

      const candidates = Object.values(agent.skills)
        .filter((skill) => skill.lastSeenTurn === agent.observedTurns)
        .flatMap((skill): SkillPlacementCandidate[] => {
          const globalSkill = ownRecordValue(
            stats.skills,
            canonicalIdentity(skill.name),
          );
          const reason: SkillPlacementReason | undefined =
            globalSkill?.needsReview
              ? "low-adoption"
              : skill.observedTurns >= SKILL_PLACEMENT_MIN_OBSERVED_TURNS &&
                  skill.recommendedTurns === 0 &&
                  skill.usageTurns === 0
                ? "zero-recommendation-usage"
                : undefined;
          if (!reason) return [];

          return [
            {
              epochKey: skillPlacementEpochKey({
                inventoryStartedAt: stats.skillInventory.startedAt,
                agentId,
                skill,
              }),
              agentId,
              name: skill.name,
              source: skill.source,
              winnerFingerprint: skill.winnerFingerprint,
              fingerprint: skill.fingerprint,
              reason,
              observedTurns: skill.observedTurns,
              usageTurns: skill.usageTurns,
              recommendedTurns: skill.recommendedTurns,
              ...(reason === "low-adoption"
                ? { adoptionRate: globalSkill?.adoptionRate }
                : {}),
            },
          ];
        })
        .filter((candidate) => !excludedEpochKeys.has(candidate.epochKey))
        .sort(
          (left, right) =>
            Number(right.reason === "low-adoption") -
              Number(left.reason === "low-adoption") ||
            compareCanonicalSkillNames(left.name, right.name),
        );

      return candidates[0];
    } catch (error) {
      logger.warn("failed to select skill placement candidate", {
        error,
        path: statsFilePath,
      });
      return undefined;
    }
  }

  isRecordable(
    sessionId: string | undefined,
    state: SessionState,
    options: { nowMs?: number } = {},
  ): boolean {
    const result = state.intent?.result;
    const projection = state.intent?.intentProjection;
    const start = state.timestamps?.start;
    if (!sessionId || (!result && !projection) || !start) return false;

    const statsFilePath = statsPath(this.pluginRoot);
    try {
      const eventTime = new Date(
        state.timestamps?.end ?? options.nowMs ?? Date.now(),
      ).toISOString();
      const stats = loadStats(statsFilePath, eventTime);
      const eventId = resolveTurnEventId(sessionId, state);
      return eventId ? !stats.processedEvents[eventId] : false;
    } catch (error) {
      logger.warn("failed to preflight stats event", {
        error,
        path: statsFilePath,
      });
      return false;
    }
  }

  record(
    sessionId: string | undefined,
    state: SessionState,
    intentDefinition?: IntentCatalogEntry,
    options: StatsRecordOptions = {},
  ): boolean {
    const result = state.intent?.result;
    const projection = state.intent?.intentProjection;
    const start = state.timestamps?.start;
    if (!sessionId || (!result && !projection) || !start) return false;

    const statsFilePath = statsPath(this.pluginRoot);
    try {
      const nowMs = options.nowMs ?? Date.now();
      const eventTime = new Date(state.timestamps?.end ?? nowMs).toISOString();
      const eventId = resolveTurnEventId(sessionId, state);
      if (!eventId) return false;

      const stats = loadStats(statsFilePath, eventTime);
      if (stats.processedEvents[eventId]) return false;

      const date = eventTime.slice(0, 10);
      stats.updatedAt = eventTime;
      stats.processedEvents[eventId] = eventTime;
      const skillsUsed = result
        ? [
            ...new Set(
              (state.skillsUsed ?? []).map((skill) =>
                canonicalIdentity(skill.name),
              ),
            ),
          ]
        : [];
      const recommendedSkills = result
        ? [
            ...new Set(
              (state.intent?.recommendedSkills ?? []).map(canonicalIdentity),
            ),
          ]
        : [];

      if (result) {
        const intentId = resolveIntentId(result.intent, intentDefinition);
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
            getOrCreateOwnRecordValue(
              stats.routing.byIntent,
              intentId,
              emptyRoutingCounts,
            ),
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
        const daily = getOrCreateOwnRecordValue(
          stats.daily,
          date,
          createDailyBucket,
        );
        recordDailyProjectionStats(daily, projection);
      }

      if (options.skillInventory) {
        recordSkillInventoryObservation({
          stats,
          agentId: options.skillInventory.agentId,
          skills: options.skillInventory.skills,
          skillsUsed,
          recommendedSkills,
          eventTime,
        });
      }

      pruneRollingData(stats, nowMs);
      recomputeDerivedStats(stats, nowMs);
      const written = safeWriteJson(
        statsFilePath,
        stats,
        "failed to write stats file",
      );
      if (written) this.acceptedTurnCount = stats.summary.turns;
      return written;
    } catch (err) {
      logger.warn("failed to update stats file", {
        error: err,
        path: statsFilePath,
      });
      return false;
    }
  }

  recordCuration(
    sessionId: string | undefined,
    curationResult: TurnCurationResult,
    turnKey: string,
    options: StatsRecordOptions = {},
  ): boolean {
    const finishedAt = curationResult.finishedAt;
    if (!sessionId || !finishedAt || curationResult.status !== "applied") {
      return false;
    }

    const statsFilePath = statsPath(this.pluginRoot);
    try {
      const nowMs = options.nowMs ?? Date.now();
      const eventTime =
        curationResult.finishedAt || new Date(nowMs).toISOString();
      const eventId = `curation:${sessionId}:${turnKey}:${curationResult.topicEpoch}:${curationResult.revision}`;
      const stats = loadStats(statsFilePath, eventTime);
      if (stats.processedEvents[eventId]) return false;

      const date = eventTime.slice(0, 10);
      stats.updatedAt = eventTime;
      stats.processedEvents[eventId] = eventTime;

      if (stats.summary.curationAppliedCount === undefined) {
        stats.summary.curationAppliedCount = 0;
      }
      stats.summary.curationAppliedCount += 1;

      if (!stats.curation) {
        stats.curation = emptyCurationStats();
      }
      stats.curation.appliedRevisions += 1;
      stats.curation.lastAppliedAt = eventTime;
      const kept = curationResult.candidates.filter(
        (c) => c.provenance === "curator-kept",
      ).length;
      const added = curationResult.candidates.filter(
        (c) => c.provenance === "curator-added",
      ).length;
      stats.curation.candidatesKept += kept;
      stats.curation.candidatesAdded += added;
      stats.curation.recommendedExperiencesSelected +=
        curationResult.recommendedExperienceRefs.length;

      const bucket = getOrCreateOwnRecordValue(
        stats.daily,
        date,
        createDailyBucket,
      );
      if (!bucket.curation) {
        bucket.curation = {
          appliedRevisions: 0,
          candidatesKept: 0,
          candidatesAdded: 0,
        };
      }
      bucket.curation.appliedRevisions += 1;
      bucket.curation.candidatesKept += kept;
      bucket.curation.candidatesAdded += added;

      pruneRollingData(stats, nowMs);
      recomputeDerivedStats(stats, nowMs);
      return safeWriteJson(statsFilePath, stats, "failed to write stats file");
    } catch (err) {
      logger.warn("failed to update stats file for curation", {
        error: err,
        path: statsFilePath,
      });
      return false;
    }
  }

  getAcceptedTurnCount(): number | undefined {
    if (this.acceptedTurnCount !== undefined) return this.acceptedTurnCount;

    const statsFilePath = statsPath(this.pluginRoot);
    try {
      if (!fileExists(statsFilePath)) return undefined;
      const stats = loadStats(statsFilePath, new Date().toISOString());
      this.acceptedTurnCount = stats.summary.turns;
      return this.acceptedTurnCount;
    } catch (err) {
      logger.warn("failed to read accepted turn count", { error: err });
      return undefined;
    }
  }
}

export const defaultStatsAggregator = StatsAggregator.create(packageRoot);
