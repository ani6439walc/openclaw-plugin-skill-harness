import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  evolutionBacklogPath,
  intentsPath,
  resolvePluginDataRoot,
} from "./file-utils.js";
import {
  EVOLUTION_OPERATIONS,
  markPendingDismissed,
  markPendingProcessed,
  readBacklog,
  selectPendingItem,
  updatePendingTarget,
  writeBacklogAtomic,
  type EvolutionBacklog,
  type EvolutionOperation,
  type ProcessedEventRecord,
} from "./evolution-backlog.js";
import { validateIntentDirectory } from "./intent-validation.js";

const PLUGIN_ID = "intention-hint";

type CliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === name && args[index + 1] ? [args[index + 1]] : [],
  );
}

function requireOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}

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

function markAndWriteItem(params: {
  args: string[];
  backlog: ReturnType<typeof readBacklog>;
  backlogPath: string;
  io: CliIo;
  mark: (
    backlog: ReturnType<typeof readBacklog>,
    id: string,
    expectedUpdatedAt: string,
    nowIso: string,
  ) => unknown;
}): number {
  const id = requireOption(params.args, "--id");
  params.mark(
    params.backlog,
    id,
    requireOption(params.args, "--expected-updated-at"),
    nowIso(),
  );
  writeBacklogAtomic(params.backlogPath, params.backlog);
  params.io.stdout(
    JSON.stringify(
      params.backlog.items.find((item) => item.id === id),
      null,
      2,
    ),
  );
  return 0;
}

export function resolveDefaultEvolutionBacklogRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePluginDataRoot(resolveStateDir(env), PLUGIN_ID);
}

export function runEvolutionBacklogCommand(
  rawArgs: string[],
  pluginRoot: string,
  io: CliIo = {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  },
): number {
  try {
    const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
    const command = args[0];
    const backlogPath = evolutionBacklogPath(pluginRoot);
    if (!command)
      throw new Error(
        "usage: evolution-backlog <list|show|review-health|set-target|validate-intents|mark-processed|mark-dismissed>",
      );

    if (command === "validate-intents") {
      const result = validateIntentDirectory(
        intentsPath(pluginRoot),
        options(args, "--id"),
      );
      io.stdout(JSON.stringify(result, null, 2));
      return result.valid ? 0 : 1;
    }

    if (!fs.existsSync(backlogPath))
      throw new Error(`backlog not found: ${backlogPath}`);
    const backlog = readBacklog(backlogPath);

    if (command === "review-health") {
      const days = Number(option(args, "--days") ?? 7);
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error("--days must be a positive number");
      }
      const nowOption = option(args, "--now");
      const nowMs = nowOption ? parseTimeMs(nowOption) : Date.now();
      if (nowMs === undefined) {
        throw new Error("--now must be a valid date/time");
      }
      io.stdout(
        JSON.stringify(
          summarizeReviewHealth({ backlog, nowMs, days }),
          null,
          2,
        ),
      );
      return 0;
    }

    if (command === "list") {
      const items = backlog.items
        .filter((item) => item.status === "pending")
        .sort(
          (a, b) =>
            b.frequency - a.frequency ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      io.stdout(
        args.includes("--json")
          ? JSON.stringify(items, null, 2)
          : items
              .map(
                (item) =>
                  `${item.id}\t${item.frequency}\t${item.operation}\t${item.summary}`,
              )
              .join("\n"),
      );
      return 0;
    }

    if (command === "show") {
      const item = selectPendingItem(backlog, option(args, "--id"));
      if (!item) throw new Error("pending backlog item not found");
      io.stdout(JSON.stringify(item, null, 2));
      return 0;
    }

    if (command === "set-target") {
      const id = requireOption(args, "--id");
      const operation = requireOption(args, "--operation");
      if (!EVOLUTION_OPERATIONS.includes(operation as EvolutionOperation)) {
        throw new Error(`invalid operation: ${operation}`);
      }
      const targets = options(args, "--target-intent");
      updatePendingTarget(
        backlog,
        id,
        operation as EvolutionOperation,
        targets,
        nowIso(),
      );
      writeBacklogAtomic(backlogPath, backlog);
      io.stdout(JSON.stringify(selectPendingItem(backlog, id), null, 2));
      return 0;
    }

    if (command === "mark-processed") {
      return markAndWriteItem({
        args,
        backlog,
        backlogPath,
        io,
        mark: markPendingProcessed,
      });
    }

    if (command === "mark-dismissed") {
      return markAndWriteItem({
        args,
        backlog,
        backlogPath,
        io,
        mark: markPendingDismissed,
      });
    }

    throw new Error(`unknown backlog command: ${command}`);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = runEvolutionBacklogCommand(
    process.argv.slice(2),
    resolveDefaultEvolutionBacklogRoot(),
  );
}
