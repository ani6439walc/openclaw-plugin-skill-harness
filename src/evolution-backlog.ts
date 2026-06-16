import { z } from "zod";
import { readJsonFile, writeJsonAtomic, safeWriteJson } from "./file-utils.js";
import type { EvolutionSource } from "./evolution-types.js";
import {
  EVOLUTION_TRIGGER_TYPES,
  type EvolutionTrigger,
} from "./trigger-checker.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "./constants.js";

export const EVOLUTION_OPERATIONS = [
  "create",
  "refine",
  "split",
  "merge",
] as const;
export const BACKLOG_OPERATIONS = ["unknown", ...EVOLUTION_OPERATIONS] as const;

export type EvolutionOperation = (typeof EVOLUTION_OPERATIONS)[number];
export type BacklogOperation = (typeof BACKLOG_OPERATIONS)[number];

export type BacklogItem = {
  id: string;
  type: EvolutionTrigger;
  operation: BacklogOperation;
  targetIntentIds: string[];
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

export type EvolutionBacklog = {
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  processedEvents: Record<string, string>;
  items: BacklogItem[];
};

const EvolutionSourceSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  turnStart: z.string(),
});

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

const BacklogV1Schema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedEvents: z.record(z.string(), z.string()),
  items: z.array(BaseItemSchema),
});

export const EvolutionBacklogSchema = z.object({
  schemaVersion: z.literal(2),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedEvents: z.record(z.string(), z.string()),
  items: z.array(
    BaseItemSchema.extend({
      operation: z.enum(BACKLOG_OPERATIONS),
      targetIntentIds: z.array(z.string().trim().min(1)),
    }),
  ),
});

export function createBacklog(nowIso: string): EvolutionBacklog {
  return {
    schemaVersion: 2,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    items: [],
  };
}

export function parseBacklog(raw: unknown): EvolutionBacklog {
  const version = z.object({ schemaVersion: z.number() }).parse(raw);
  if (version.schemaVersion === 2) return EvolutionBacklogSchema.parse(raw);
  const legacy = BacklogV1Schema.parse(raw);
  return {
    ...legacy,
    schemaVersion: 2,
    items: legacy.items.map((item) => ({
      ...item,
      operation: "unknown",
      targetIntentIds: [],
    })),
  };
}

export function readBacklog(backlogPath: string): EvolutionBacklog {
  return parseBacklog(readJsonFile<unknown>(backlogPath));
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
  if (item.operation === "unknown" || item.targetIntentIds.length === 0) {
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
 */
export function pruneProcessedEvents(backlog: EvolutionBacklog): void {
  const cutoff = Date.now() - PROCESSED_EVENTS_RETENTION_DAYS * 86_400_000;
  for (const [eventId, timestamp] of Object.entries(backlog.processedEvents)) {
    const eventTime = new Date(timestamp).getTime();
    if (eventTime < cutoff) {
      delete backlog.processedEvents[eventId];
    }
  }
}
