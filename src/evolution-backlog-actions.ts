import * as fs from "node:fs";
import { evolutionBacklogPath, intentsPath } from "./file-utils.js";
import {
  EVOLUTION_OPERATIONS,
  markPendingDismissed,
  markPendingProcessed,
  readBacklog,
  selectPendingItem,
  updatePendingTarget,
  writeBacklogAtomic,
  type BacklogItem,
  type EvolutionBacklog,
  type EvolutionOperation,
  type ProcessedEventRecord,
} from "./evolution-backlog.js";
import {
  validateIntentDirectory,
  type IntentValidationResult,
} from "./intent-validation.js";

export type EvolutionBacklogAction =
  | { action: "list" }
  | { action: "show"; id?: string }
  | { action: "review-health"; days?: number; now?: string }
  | {
      action: "set-target";
      id: string;
      operation: EvolutionOperation;
      targetIntentIds: string[];
    }
  | { action: "validate-intents"; ids?: string[] }
  | { action: "mark-processed"; id: string; expectedUpdatedAt: string }
  | { action: "mark-dismissed"; id: string; expectedUpdatedAt: string };

export type ReviewHealthSummary = ReturnType<typeof summarizeReviewHealth>;

export type EvolutionBacklogActionSuccess =
  BacklogItem[] | BacklogItem | IntentValidationResult | ReviewHealthSummary;

export type EvolutionBacklogActionResult =
  | { ok: true; result: EvolutionBacklogActionSuccess }
  | { ok: false; error: string };

function nowIso(): string {
  return new Date().toISOString();
}

function emptyCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (!value) return;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function summarizeReviewHealth(params: {
  backlog: EvolutionBacklog;
  nowMs: number;
  days: number;
}) {
  const cutoffMs = params.nowMs - params.days * 24 * 60 * 60 * 1000;
  const processedEvents = Object.values(params.backlog.processedEvents);
  const recentEvents = processedEvents.filter((event) => {
    const processedAtMs = parseTimeMs(event.processedAt);
    return processedAtMs !== undefined && processedAtMs >= cutoffMs;
  });

  const countOutcomes = (events: ProcessedEventRecord[]) => {
    const counts = emptyCounts();
    for (const event of events) increment(counts, event.outcome);
    return counts;
  };
  const countTriggers = (events: ProcessedEventRecord[]) => {
    const counts = emptyCounts();
    for (const event of events) {
      for (const trigger of event.triggers) increment(counts, trigger);
    }
    return counts;
  };
  const countNoFindingReasons = (events: ProcessedEventRecord[]) => {
    const counts = emptyCounts();
    for (const event of events) {
      for (const [reasonCode, count] of Object.entries(
        event.noFindingReasonCounts ?? {},
      )) {
        counts[reasonCode] = (counts[reasonCode] ?? 0) + count;
      }
    }
    return counts;
  };
  const countSchemaRejectionReasons = (events: ProcessedEventRecord[]) => {
    const counts = emptyCounts();
    for (const event of events) {
      for (const [reasonCode, count] of Object.entries(
        event.schemaRejectionReasonCounts ?? {},
      )) {
        counts[reasonCode] = (counts[reasonCode] ?? 0) + count;
      }
    }
    return counts;
  };

  const recentCreated = params.backlog.items.filter((item) => {
    const createdAtMs = parseTimeMs(item.createdAt);
    return createdAtMs !== undefined && createdAtMs >= cutoffMs;
  }).length;
  const recentUpdated = params.backlog.items.filter((item) => {
    const updatedAtMs = parseTimeMs(item.updatedAt);
    return updatedAtMs !== undefined && updatedAtMs >= cutoffMs;
  }).length;
  const byStatus = emptyCounts();
  for (const item of params.backlog.items) increment(byStatus, item.status);

  return {
    schemaVersion: params.backlog.schemaVersion,
    updatedAt: params.backlog.updatedAt,
    windowDays: params.days,
    processedEvents: {
      total: processedEvents.length,
      recent: recentEvents.length,
      totalByOutcome: countOutcomes(processedEvents),
      recentByOutcome: countOutcomes(recentEvents),
      recentByTrigger: countTriggers(recentEvents),
      totalNoFindingReasonCounts: countNoFindingReasons(processedEvents),
      recentNoFindingReasonCounts: countNoFindingReasons(recentEvents),
      totalSchemaRejectionReasonCounts:
        countSchemaRejectionReasons(processedEvents),
      recentSchemaRejectionReasonCounts:
        countSchemaRejectionReasons(recentEvents),
    },
    items: {
      total: params.backlog.items.length,
      pending: byStatus.pending ?? 0,
      byStatus,
      recentCreated,
      recentUpdated,
    },
    rates: {
      recentNoFindingRate: rate(
        recentEvents.filter((event) => event.outcome === "nofinding").length,
        recentEvents.length,
      ),
      recentSchemaRejectedRate: rate(
        recentEvents.filter((event) => event.outcome === "schema-rejected")
          .length,
        recentEvents.length,
      ),
      recentParseFailedRate: rate(
        recentEvents.filter((event) => event.outcome === "parse-failed").length,
        recentEvents.length,
      ),
      // Approximation: backlog items are not linked one-to-one to processed
      // events, so recentCreated is a window-level item count rather than an
      // event-level write count. This is sufficient for a coarse health audit.
      recentNoNewItemRate: rate(
        Math.max(0, recentEvents.length - recentCreated),
        recentEvents.length,
      ),
    },
  };
}

function listPendingItems(backlog: EvolutionBacklog): BacklogItem[] {
  return backlog.items
    .filter((item) => item.status === "pending")
    .sort(
      (a, b) =>
        b.frequency - a.frequency ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

function requireBacklog(dataRoot: string): {
  backlog: EvolutionBacklog;
  backlogPath: string;
} {
  const backlogPath = evolutionBacklogPath(dataRoot);
  if (!fs.existsSync(backlogPath)) {
    throw new Error(`backlog not found: ${backlogPath}`);
  }
  return { backlog: readBacklog(backlogPath), backlogPath };
}

function markAndWrite(params: {
  dataRoot: string;
  id: string;
  expectedUpdatedAt: string;
  mark: typeof markPendingProcessed | typeof markPendingDismissed;
}): BacklogItem {
  const { backlog, backlogPath } = requireBacklog(params.dataRoot);
  const item = params.mark(
    backlog,
    params.id,
    params.expectedUpdatedAt,
    nowIso(),
  );
  writeBacklogAtomic(backlogPath, backlog);
  return item;
}

export function runEvolutionBacklogAction(params: {
  action: EvolutionBacklogAction;
  dataRoot: string;
}): EvolutionBacklogActionResult {
  try {
    if (params.action.action === "validate-intents") {
      return {
        ok: true,
        result: validateIntentDirectory(
          intentsPath(params.dataRoot),
          params.action.ids ?? [],
        ),
      };
    }

    const { backlog, backlogPath } = requireBacklog(params.dataRoot);

    if (params.action.action === "review-health") {
      const days = params.action.days ?? 7;
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error("days must be a positive number");
      }
      const nowMs = params.action.now
        ? parseTimeMs(params.action.now)
        : Date.now();
      if (nowMs === undefined) {
        throw new Error("now must be a valid date/time");
      }
      return {
        ok: true,
        result: summarizeReviewHealth({ backlog, nowMs, days }),
      };
    }

    if (params.action.action === "list") {
      return { ok: true, result: listPendingItems(backlog) };
    }

    if (params.action.action === "show") {
      const item = selectPendingItem(backlog, params.action.id);
      if (!item) throw new Error("pending backlog item not found");
      return { ok: true, result: item };
    }

    if (params.action.action === "set-target") {
      if (!EVOLUTION_OPERATIONS.includes(params.action.operation)) {
        throw new Error(`invalid operation: ${params.action.operation}`);
      }
      const item = updatePendingTarget(
        backlog,
        params.action.id,
        params.action.operation,
        params.action.targetIntentIds,
        nowIso(),
      );
      writeBacklogAtomic(backlogPath, backlog);
      return { ok: true, result: item };
    }

    if (params.action.action === "mark-processed") {
      return {
        ok: true,
        result: markAndWrite({
          dataRoot: params.dataRoot,
          id: params.action.id,
          expectedUpdatedAt: params.action.expectedUpdatedAt,
          mark: markPendingProcessed,
        }),
      };
    }

    return {
      ok: true,
      result: markAndWrite({
        dataRoot: params.dataRoot,
        id: params.action.id,
        expectedUpdatedAt: params.action.expectedUpdatedAt,
        mark: markPendingDismissed,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
