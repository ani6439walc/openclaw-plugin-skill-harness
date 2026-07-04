import { z } from "zod";
import { fileExists, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import type { EvolutionSource } from "./evolution-types.js";
import {
  EVOLUTION_TRIGGER_TYPES,
  type EvolutionTrigger,
} from "./trigger-checker.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "./constants.js";
import {
  normalizeEvolutionTriggerKeywords,
  normalizeKeywordList,
  type EvolutionTriggerKeywords,
  type TriggerKeywordTarget,
} from "./evolution-trigger-keywords.js";

export const EVOLUTION_OPERATIONS = [
  "create",
  "refine",
  "split",
  "merge",
] as const;
export const BACKLOG_OPERATIONS = [
  "unknown",
  ...EVOLUTION_OPERATIONS,
  "adjust-trigger-keywords",
] as const;

export type EvolutionOperation = (typeof EVOLUTION_OPERATIONS)[number];
export type BacklogOperation = (typeof BACKLOG_OPERATIONS)[number];

export type BacklogItem = {
  id: string;
  type: EvolutionTrigger;
  targetKind: "intent-markdown" | "trigger-keywords";
  operation: BacklogOperation;
  targetIntentIds: string[];
  targetTrigger?: TriggerKeywordTarget;
  keywordChange?: { add: string[]; remove: string[] };
  dedupeKey: string;
  summary: string;
  correctionGoal: string;
  details: {
    evidence: string[];
    suggestedChange: string;
  };
  frequency: number;
  sources: EvolutionSource[];
  createdAt: string;
  updatedAt: string;
  status: "pending" | "processed" | "dismissed";
};

export const PROCESSED_EVENT_OUTCOMES = [
  "wrote-items",
  "nofinding",
  "schema-rejected",
  "parse-failed",
  "subagent-error",
  "unknown",
] as const;

export type ProcessedEventOutcome = (typeof PROCESSED_EVENT_OUTCOMES)[number];

export const NO_FINDING_REASON_CODES = [
  "routine-tool-use",
  "outside-intent-scope",
  "insufficient-evidence",
  "wrong-trigger",
  "already-covered",
  "privacy-sensitive",
] as const;

export type NoFindingReasonCode = (typeof NO_FINDING_REASON_CODES)[number];
export type NoFindingReasonCounts = Partial<
  Record<NoFindingReasonCode, number>
>;

export const SCHEMA_REJECTION_REASON_CODES = [
  "missing-required-field",
  "missing-target",
  "invalid-operation",
  "invalid-trigger-keyword-target",
  "invalid-field-type",
  "too-long-field",
  "invalid-shape",
  "unknown",
] as const;

export type SchemaRejectionReasonCode =
  (typeof SCHEMA_REJECTION_REASON_CODES)[number];
export type SchemaRejectionReasonCounts = Partial<
  Record<SchemaRejectionReasonCode, number>
>;

export type ProcessedEventRecord = {
  processedAt: string;
  triggers: EvolutionTrigger[];
  findingCount: number;
  outcome: ProcessedEventOutcome;
  noFindingReasonCounts?: NoFindingReasonCounts;
  schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
};

export type EvolutionBacklog = {
  schemaVersion: 3;
  createdAt: string;
  updatedAt: string;
  triggerKeywords: EvolutionTriggerKeywords;
  processedEvents: Record<string, ProcessedEventRecord>;
  items: BacklogItem[];
};

const LEGACY_TRIGGER_TYPE_MAP: Record<string, EvolutionTrigger> = {
  skill_candidate: "skill-candidate",
  process_gap: "process-gap",
  successful_pattern: "successful-pattern",
  satisfaction_check: "satisfaction-check",
  missing_intent: "missing-intent",
  weak_intent: "weak-intent",
  behavior_fix: "behavior-fix",
  entity_context: "entity-context",
};

function normalizeBacklogTriggerTypes(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const items = value.items;
  if (!Array.isArray(items)) return raw;
  return {
    ...value,
    items: items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }
      const itemValue = item as Record<string, unknown>;
      const type = itemValue.type;
      if (typeof type !== "string") return item;
      return {
        ...itemValue,
        type: LEGACY_TRIGGER_TYPE_MAP[type] ?? type,
      };
    }),
  };
}

const EvolutionSourceSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  turnStart: z.string(),
});

const TriggerKeywordTargetSchema = z.enum([
  "successful-pattern",
  "behavior-fix",
  "entity-context",
]);

const KeywordChangeSchema = z.object({
  add: z
    .array(z.string())
    .transform((values) => normalizeKeywordList(values, [])),
  remove: z
    .array(z.string())
    .transform((values) => normalizeKeywordList(values, [])),
});

const TriggerKeywordsSchema = z
  .unknown()
  .transform((value) => normalizeEvolutionTriggerKeywords(value));

const ProcessedEventOutcomeSchema = z.enum(PROCESSED_EVENT_OUTCOMES);

function normalizeAllowlistedCounts<T extends string>(
  value: unknown,
  allowedKeys: readonly T[],
): Partial<Record<T, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const output: Partial<Record<T, number>> = {};
  for (const reasonCode of allowedKeys) {
    const count = input[reasonCode];
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      output[reasonCode] = count;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function normalizeNoFindingReasonCounts(
  value: unknown,
): NoFindingReasonCounts | undefined {
  return normalizeAllowlistedCounts(value, NO_FINDING_REASON_CODES);
}

export function normalizeSchemaRejectionReasonCounts(
  value: unknown,
): SchemaRejectionReasonCounts | undefined {
  return normalizeAllowlistedCounts(value, SCHEMA_REJECTION_REASON_CODES);
}

const ProcessedEventRecordSchema = z.union([
  z.string().transform((processedAt): ProcessedEventRecord => ({
    processedAt,
    triggers: [],
    findingCount: 0,
    outcome: "unknown",
  })),
  z
    .object({
      processedAt: z.string(),
      triggers: z.array(z.enum(EVOLUTION_TRIGGER_TYPES)).catch([]),
      findingCount: z.number().int().nonnegative().catch(0),
      outcome: ProcessedEventOutcomeSchema.catch("unknown"),
      noFindingReasonCounts: z.unknown().optional(),
      schemaRejectionReasonCounts: z.unknown().optional(),
    })
    .transform(
      ({
        noFindingReasonCounts,
        schemaRejectionReasonCounts,
        ...record
      }): ProcessedEventRecord => {
        const normalizedReasonCounts = normalizeNoFindingReasonCounts(
          noFindingReasonCounts,
        );
        const normalizedSchemaRejectionCounts =
          normalizeSchemaRejectionReasonCounts(schemaRejectionReasonCounts);
        return {
          ...record,
          ...(normalizedReasonCounts
            ? { noFindingReasonCounts: normalizedReasonCounts }
            : {}),
          ...(normalizedSchemaRejectionCounts
            ? { schemaRejectionReasonCounts: normalizedSchemaRejectionCounts }
            : {}),
        };
      },
    ),
]);

const ProcessedEventsSchema = z.record(z.string(), ProcessedEventRecordSchema);

const BaseItemSchema = z.object({
  id: z.string(),
  type: z.enum(EVOLUTION_TRIGGER_TYPES),
  dedupeKey: z.string(),
  summary: z.string(),
  correctionGoal: z.string(),
  details: z.object({
    evidence: z.array(z.string()),
    suggestedChange: z.string(),
  }),
  frequency: z.number().int().positive(),
  sources: z.array(EvolutionSourceSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["pending", "processed", "dismissed"]),
});

const BacklogItemSchema = BaseItemSchema.extend({
  targetKind: z.enum(["intent-markdown", "trigger-keywords"]),
  operation: z.enum(BACKLOG_OPERATIONS),
  targetIntentIds: z.array(z.string().trim().min(1)),
  targetTrigger: TriggerKeywordTargetSchema.optional(),
  keywordChange: KeywordChangeSchema.optional(),
});

function migrateItem(rawItem: unknown): unknown {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return rawItem;
  }
  const item = rawItem as Record<string, unknown>;
  return {
    ...item,
    targetKind: item.targetKind ?? "intent-markdown",
    operation: item.operation ?? "unknown",
    targetIntentIds: item.targetIntentIds ?? [],
  };
}

const BacklogV1Schema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedEvents: ProcessedEventsSchema,
  items: z.array(BaseItemSchema),
});

export const EvolutionBacklogSchema = z.object({
  schemaVersion: z.literal(3),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggerKeywords: TriggerKeywordsSchema,
  processedEvents: ProcessedEventsSchema,
  items: z.array(BacklogItemSchema),
});

export function createBacklog(
  nowIso: string,
  triggerKeywordSeed?: Partial<EvolutionTriggerKeywords>,
): EvolutionBacklog {
  return {
    schemaVersion: 3,
    createdAt: nowIso,
    updatedAt: nowIso,
    triggerKeywords: normalizeEvolutionTriggerKeywords(triggerKeywordSeed),
    processedEvents: {},
    items: [],
  };
}

export function parseBacklog(
  raw: unknown,
  triggerKeywordSeed?: Partial<EvolutionTriggerKeywords>,
): EvolutionBacklog {
  const normalized = normalizeBacklogTriggerTypes(raw);
  const version = z.object({ schemaVersion: z.number() }).parse(normalized);
  if (version.schemaVersion === 3) {
    return EvolutionBacklogSchema.parse(normalized);
  }
  if (version.schemaVersion === 2) {
    const legacy = z
      .object({
        schemaVersion: z.literal(2),
        createdAt: z.string(),
        updatedAt: z.string(),
        processedEvents: ProcessedEventsSchema,
        items: z.array(z.unknown()),
      })
      .parse(normalized);
    return EvolutionBacklogSchema.parse({
      ...legacy,
      schemaVersion: 3,
      triggerKeywords: normalizeEvolutionTriggerKeywords(triggerKeywordSeed),
      items: legacy.items.map(migrateItem),
    });
  }
  const legacy = BacklogV1Schema.parse(normalized);
  return EvolutionBacklogSchema.parse({
    ...legacy,
    schemaVersion: 3,
    triggerKeywords: normalizeEvolutionTriggerKeywords(triggerKeywordSeed),
    items: legacy.items.map(migrateItem),
  });
}

export function readBacklog(
  backlogPath: string,
  triggerKeywordSeed?: Partial<EvolutionTriggerKeywords>,
): EvolutionBacklog {
  return parseBacklog(readJsonFile<unknown>(backlogPath), triggerKeywordSeed);
}

export function readEvolutionTriggerKeywords(
  backlogPath: string,
  triggerKeywordSeed?: Partial<EvolutionTriggerKeywords>,
): EvolutionTriggerKeywords {
  if (!fileExists(backlogPath)) {
    return normalizeEvolutionTriggerKeywords(triggerKeywordSeed);
  }
  return readBacklog(backlogPath, triggerKeywordSeed).triggerKeywords;
}

export function writeBacklogAtomic(
  backlogPath: string,
  backlog: EvolutionBacklog,
): void {
  const parsed = EvolutionBacklogSchema.parse(backlog);
  writeJsonAtomic(backlogPath, parsed);
}

export function selectPendingItem(
  backlog: EvolutionBacklog,
  id?: string,
): BacklogItem | undefined {
  if (id) {
    return backlog.items.find(
      (item) => item.id === id && item.status === "pending",
    );
  }
  return backlog.items
    .filter((item) => item.status === "pending")
    .sort(
      (a, b) =>
        b.frequency - a.frequency ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )[0];
}

export function updatePendingTarget(
  backlog: EvolutionBacklog,
  id: string,
  operation: EvolutionOperation,
  targetIntentIds: string[],
  nowIso: string,
): BacklogItem {
  const item = selectPendingItem(backlog, id);
  if (!item) throw new Error(`pending backlog item not found: ${id}`);
  const normalizedTargets = [
    ...new Set(targetIntentIds.map((target) => target.trim()).filter(Boolean)),
  ];
  if (normalizedTargets.length === 0)
    throw new Error("at least one target intent ID is required");
  item.operation = operation;
  item.targetIntentIds = normalizedTargets;
  item.updatedAt = nowIso;
  backlog.updatedAt = nowIso;
  return item;
}

export function markPendingProcessed(
  backlog: EvolutionBacklog,
  id: string,
  expectedUpdatedAt: string,
  nowIso: string,
): BacklogItem {
  const item = selectPendingItem(backlog, id);
  if (!item) throw new Error(`pending backlog item not found: ${id}`);
  const hasResolvedIntentTarget =
    item.targetKind === "intent-markdown" &&
    item.operation !== "unknown" &&
    item.operation !== "adjust-trigger-keywords" &&
    item.targetIntentIds.length > 0;
  if (!hasResolvedIntentTarget) {
    throw new Error(`backlog item target metadata is unresolved: ${id}`);
  }
  if (item.updatedAt !== expectedUpdatedAt) {
    throw new Error(`backlog item changed since it was selected: ${id}`);
  }
  item.status = "processed";
  item.updatedAt = nowIso;
  backlog.updatedAt = nowIso;
  return item;
}

export function markPendingDismissed(
  backlog: EvolutionBacklog,
  id: string,
  expectedUpdatedAt: string,
  nowIso: string,
): BacklogItem {
  const item = selectPendingItem(backlog, id);
  if (!item) throw new Error(`pending backlog item not found: ${id}`);
  if (item.updatedAt !== expectedUpdatedAt) {
    throw new Error(`backlog item changed since it was selected: ${id}`);
  }
  item.status = "dismissed";
  item.updatedAt = nowIso;
  backlog.updatedAt = nowIso;
  return item;
}

// ============================================================================
// processedEvents Retention
// ============================================================================

/**
 * Prune processedEvents entries older than retention period.
 * Modifies the backlog in place.
 * @param backlog - The backlog to prune
 * @param nowMs - Optional current time in ms (defaults to Date.now())
 */
export function pruneProcessedEvents(
  backlog: EvolutionBacklog,
  nowMs: number = Date.now(),
): void {
  const cutoff = nowMs - PROCESSED_EVENTS_RETENTION_DAYS * 86_400_000;
  for (const eventId in backlog.processedEvents) {
    const eventTime = new Date(
      backlog.processedEvents[eventId].processedAt,
    ).getTime();
    // Prune expired entries and corrupt data (NaN from invalid dates)
    if (Number.isNaN(eventTime) || eventTime < cutoff) {
      delete backlog.processedEvents[eventId];
    }
  }
}
