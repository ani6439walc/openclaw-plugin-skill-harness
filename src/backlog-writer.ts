import { logger } from "../api.js";
import {
  pluginRoot,
  evolutionBacklogPath,
  fileExists,
  safeWriteJson,
  withFileLock,
} from "./file-utils.js";
import type { EvolutionFinding, EvolutionSource } from "./evolution-types.js";
import type { EvolutionTriggerKeywords } from "./evolution-trigger-keywords.js";
import {
  createBacklog,
  readBacklog,
  pruneProcessedEvents,
  EvolutionBacklogSchema,
  normalizeNoFindingReasonCounts,
  normalizeSchemaRejectionReasonCounts,
  type EvolutionBacklog,
  type NoFindingReasonCounts,
  type ProcessedEventOutcome,
  type SchemaRejectionReasonCounts,
} from "./evolution-backlog.js";
import type { EvolutionTrigger } from "./trigger-checker.js";

function backlogTargetFields(finding: EvolutionFinding) {
  if (finding.targetKind === "trigger-keywords") {
    return {
      targetKind: "trigger-keywords" as const,
      operation: "adjust-trigger-keywords" as const,
      targetIntentIds: [],
      targetTrigger: finding.targetTrigger,
      keywordChange: {
        add: [...finding.addKeywords],
        remove: [...finding.removeKeywords],
      },
    };
  }
  return {
    targetKind: "intent-markdown" as const,
    operation: finding.operation,
    targetIntentIds: [...finding.targetIntentIds],
    targetTrigger: undefined,
    keywordChange: undefined,
  };
}

function nextItemId(backlog: EvolutionBacklog, nowIso: string): string {
  const date = nowIso.slice(0, 10).replaceAll("-", "");
  const prefix = `IMP-${date}-`;
  const sequence =
    Math.max(
      0,
      ...backlog.items.map((item) => {
        const suffix = item.id.startsWith(prefix)
          ? Number(item.id.slice(prefix.length))
          : 0;
        return Number.isInteger(suffix) ? suffix : 0;
      }),
    ) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

export class BacklogWriter {
  private constructor(
    private readonly pluginRoot: string,
    private readonly options: {
      triggerKeywordSeed?: () => Partial<EvolutionTriggerKeywords> | undefined;
      onAfterWrite?: () => void;
    } = {},
  ) {}

  static create(
    pluginRoot: string,
    options: {
      triggerKeywordSeed?: () => Partial<EvolutionTriggerKeywords> | undefined;
      onAfterWrite?: () => void;
    } = {},
  ): BacklogWriter {
    return new BacklogWriter(pluginRoot, options);
  }

  async record(
    eventId: string,
    source: EvolutionSource,
    findings: readonly EvolutionFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly EvolutionTrigger[];
      outcome?: ProcessedEventOutcome;
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const backlogPath = evolutionBacklogPath(this.pluginRoot);

    // Use file lock for cross-process safety
    const result = await withFileLock(backlogPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        const triggerKeywordSeed = this.options.triggerKeywordSeed?.();
        const backlog = fileExists(backlogPath)
          ? readBacklog(backlogPath, triggerKeywordSeed)
          : createBacklog(nowIso, triggerKeywordSeed);

        // Prune old processedEvents before any mutation
        pruneProcessedEvents(backlog, options.nowMs ?? Date.now());

        if (backlog.processedEvents[eventId]) return false;

        for (const finding of findings) {
          const targetFields = backlogTargetFields(finding);
          const existing = backlog.items.find(
            (item) =>
              item.status === "pending" &&
              item.type === finding.trigger &&
              item.dedupeKey === finding.dedupeKey,
          );
          if (existing) {
            existing.frequency += 1;
            existing.sources.push(source);
            existing.updatedAt = nowIso;
            existing.targetKind = targetFields.targetKind;
            existing.operation = targetFields.operation;
            existing.targetIntentIds = targetFields.targetIntentIds;
            existing.targetTrigger = targetFields.targetTrigger;
            existing.keywordChange = targetFields.keywordChange;
            existing.summary = finding.summary;
            existing.correctionGoal = finding.correctionGoal;
            existing.details = {
              evidence: finding.evidence,
              suggestedChange: finding.suggestedChange,
            };
            continue;
          }

          backlog.items.push({
            id: nextItemId(backlog, nowIso),
            type: finding.trigger,
            ...targetFields,
            dedupeKey: finding.dedupeKey,
            summary: finding.summary,
            correctionGoal: finding.correctionGoal,
            details: {
              evidence: finding.evidence,
              suggestedChange: finding.suggestedChange,
            },
            frequency: 1,
            sources: [source],
            createdAt: nowIso,
            updatedAt: nowIso,
            status: "pending",
          });
        }

        backlog.updatedAt = nowIso;
        const triggers = [
          ...new Set(
            (
              options.triggers ?? findings.map((finding) => finding.trigger)
            ).filter(Boolean),
          ),
        ];
        const noFindingReasonCounts = normalizeNoFindingReasonCounts(
          options.noFindingReasonCounts,
        );
        const schemaRejectionReasonCounts =
          normalizeSchemaRejectionReasonCounts(
            options.schemaRejectionReasonCounts,
          );
        backlog.processedEvents[eventId] = {
          processedAt: nowIso,
          triggers,
          findingCount: findings.length,
          outcome:
            options.outcome ??
            (findings.length > 0 ? "wrote-items" : "nofinding"),
          ...(noFindingReasonCounts ? { noFindingReasonCounts } : {}),
          ...(schemaRejectionReasonCounts
            ? { schemaRejectionReasonCounts }
            : {}),
        };
        const validated = EvolutionBacklogSchema.parse(backlog);
        return safeWriteJson(
          backlogPath,
          validated,
          "failed to write evolution backlog",
        );
      } catch (err) {
        logger.warn("failed to update evolution backlog", {
          error: err,
          path: backlogPath,
        });
        return false;
      }
    });

    // withFileLock returns undefined if lock acquisition failed
    if (result === undefined) {
      logger.warn("failed to acquire lock for evolution backlog", {
        path: backlogPath,
      });
      return false;
    }
    if (result) this.options.onAfterWrite?.();
    return result;
  }
}

export const defaultBacklogWriter = BacklogWriter.create(pluginRoot);
