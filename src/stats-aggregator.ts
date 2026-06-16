import * as path from "node:path";
import { logger } from "../api.js";
import type { SessionState } from "./session-tracker.js";
import type { IntentDefinition } from "./types.js";
import {
  pluginRoot,
  fileExists,
  readJsonFile,
  safeWriteJson,
} from "./file-utils.js";

const STATS_FILENAME = "stats.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RETENTION_MS = 90 * DAY_MS;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const REVIEW_MIN_RECOMMENDATIONS = 5;
const REVIEW_ADOPTION_THRESHOLD = 0.7;

type CountMap = Record<string, number>;
type ComplexityCounts = { low: number; medium: number; high: number };
type RoutingCounts = {
  recommendationTurns: number;
  adoptedTurns: number;
  turnAdoptionRate: number;
  recommendedSkillOpportunities: number;
  adoptedSkillOpportunities: number;
  skillAdoptionRate: number;
};

type DailyBucket = {
  turns: number;
  erroredTurns: number;
  intents: CountMap;
  skills: CountMap;
  tools: CountMap;
  routing: Omit<RoutingCounts, "turnAdoptionRate" | "skillAdoptionRate">;
};

type Stats = {
  schemaVersion: 1;
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
      lifecycle: "active" | "stale" | "archive" | "never_used";
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
  daily: Record<string, DailyBucket>;
  processedEvents: Record<string, string>;
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

function createStats(nowIso: string): Stats {
  return {
    schemaVersion: 1,
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
  definition: IntentDefinition | undefined,
): string {
  if (definition) return definition.id;
  return resultIntent.match(/^([A-Za-z0-9_-]+)/)?.[1] ?? resultIntent;
}

function extractRecommendedSkills(
  definition: IntentDefinition | undefined,
): string[] {
  if (!definition) return [];
  return [
    ...new Set(
      definition.prompt
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*skill:\s*(\S+)\s*$/i)?.[1])
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
      skill.lifecycle = "never_used";
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

export class StatsAggregator {
  private constructor(private readonly pluginRoot: string) {}

  static create(pluginRoot: string): StatsAggregator {
    return new StatsAggregator(pluginRoot);
  }

  record(
    sessionId: string | undefined,
    state: SessionState,
    intentDefinition?: IntentDefinition,
    options: { nowMs?: number } = {},
  ): boolean {
    const result = state.intent?.result;
    const start = state.timestamps?.start;
    if (!sessionId || !result || !start) return false;

    const statsPath = path.join(this.pluginRoot, "sessions", STATS_FILENAME);
    try {
      const nowMs = options.nowMs ?? Date.now();
      const eventTime = new Date(state.timestamps?.end ?? nowMs).toISOString();
      const eventId = `${sessionId}:${start}`;

      let stats: Stats;
      if (fileExists(statsPath)) {
        stats = readJsonFile<Stats>(statsPath);
        if (
          stats.schemaVersion !== 1 ||
          !stats.summary ||
          !stats.intents ||
          !stats.skills ||
          !stats.routing ||
          !stats.tools ||
          !stats.daily ||
          !stats.processedEvents
        ) {
          throw new Error("unsupported or invalid stats schema");
        }
      } else {
        stats = createStats(eventTime);
      }
      if (stats.processedEvents[eventId]) return false;

      const intentId = resolveIntentId(result.intent, intentDefinition);
      const skillsUsed = [
        ...new Set((state.skillsUsed ?? []).map((skill) => skill.name)),
      ];
      const recommendedSkills = extractRecommendedSkills(intentDefinition);
      const adoptedSkills = recommendedSkills.filter((skill) =>
        skillsUsed.includes(skill),
      );
      const toolCalls = state.toolCalls ?? [];
      const toolNames = [...new Set(toolCalls.map((tool) => tool.name))];
      const errored = state.error !== undefined;
      const date = eventTime.slice(0, 10);

      stats.updatedAt = eventTime;
      stats.processedEvents[eventId] = eventTime;
      stats.summary.averageConfidence = rate(
        stats.summary.averageConfidence * stats.summary.turns +
          result.confidence,
        stats.summary.turns + 1,
      );
      stats.summary.turns += 1;
      stats.summary.completedTurns += errored ? 0 : 1;
      stats.summary.erroredTurns += errored ? 1 : 0;
      stats.summary.skillAssistedTurns += skillsUsed.length > 0 ? 1 : 0;
      stats.summary.toolAssistedTurns += toolCalls.length > 0 ? 1 : 0;
      stats.summary.skillUsageCount += skillsUsed.length;
      stats.summary.toolCallCount += toolCalls.length;
      stats.summary.otherTurns += intentId.toUpperCase() === "OTHER" ? 1 : 0;

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
      intent.complexity[result.complexity] += 1;
      intent.skillAssistedTurns += skillsUsed.length > 0 ? 1 : 0;
      intent.toolAssistedTurns += toolCalls.length > 0 ? 1 : 0;
      intent.erroredTurns += errored ? 1 : 0;

      for (const skillName of new Set([...skillsUsed, ...recommendedSkills])) {
        const skill = (stats.skills[skillName] ??= {
          usageTurns: 0,
          recommendedTurns: 0,
          adoptedTurns: 0,
          adoptionRate: 0,
          last7DaysUsage: 0,
          lifecycle: "never_used",
          needsReview: false,
        });
        if (skillsUsed.includes(skillName)) {
          skill.usageTurns += 1;
          skill.lastUsedAt = eventTime;
        }
        skill.recommendedTurns += recommendedSkills.includes(skillName) ? 1 : 0;
        skill.adoptedTurns += adoptedSkills.includes(skillName) ? 1 : 0;
      }

      if (recommendedSkills.length > 0) {
        stats.routing.recommendationTurns += 1;
        stats.routing.adoptedTurns += adoptedSkills.length > 0 ? 1 : 0;
        stats.routing.recommendedSkillOpportunities += recommendedSkills.length;
        stats.routing.adoptedSkillOpportunities += adoptedSkills.length;
        const intentRouting = (stats.routing.byIntent[intentId] ??=
          emptyRoutingCounts());
        intentRouting.recommendationTurns += 1;
        intentRouting.adoptedTurns += adoptedSkills.length > 0 ? 1 : 0;
        intentRouting.recommendedSkillOpportunities += recommendedSkills.length;
        intentRouting.adoptedSkillOpportunities += adoptedSkills.length;
      }

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
        tool.errorCalls += calls.filter(
          (call) => call.error !== undefined,
        ).length;
        tool.lastUsedAt = eventTime;
      }

      const daily = (stats.daily[date] ??= createDailyBucket());
      daily.turns += 1;
      daily.erroredTurns += errored ? 1 : 0;
      increment(daily.intents, intentId);
      for (const skillName of skillsUsed) increment(daily.skills, skillName);
      for (const call of toolCalls) increment(daily.tools, call.name);
      if (recommendedSkills.length > 0) {
        daily.routing.recommendationTurns += 1;
        daily.routing.adoptedTurns += adoptedSkills.length > 0 ? 1 : 0;
        daily.routing.recommendedSkillOpportunities += recommendedSkills.length;
        daily.routing.adoptedSkillOpportunities += adoptedSkills.length;
      }

      pruneRollingData(stats, nowMs);
      recomputeDerivedStats(stats, nowMs);
      return safeWriteJson(statsPath, stats, "failed to write stats file");
    } catch (err) {
      logger.warn("failed to update stats file", {
        error: err,
        path: statsPath,
      });
      return false;
    }
  }
}

export const defaultStatsAggregator = StatsAggregator.create(pluginRoot);
