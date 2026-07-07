import { logger } from "../api.js";
import {
  pluginRoot,
  evolutionLogPath,
  fileExists,
  safeWriteJson,
  withFileLock,
} from "./file-utils.js";
import type { EvolutionFinding, EvolutionSource } from "./evolution-types.js";
import type { EvolutionTriggerKeywords } from "./evolution-trigger-keywords.js";
import { normalizeKeywordList } from "./evolution-trigger-keywords.js";
import {
  createEvolutionLog,
  readEvolutionLog,
  pruneProcessedEvents,
  EvolutionLogSchema,
  normalizeNoFindingReasonCounts,
  normalizeSchemaRejectionReasonCounts,
  type AppliedEvolutionChange,
  type NoFindingReasonCounts,
  type ProcessedEventOutcome,
  type SchemaRejectionReasonCounts,
} from "./evolution-log.js";
import type { EvolutionTrigger } from "./trigger-checker.js";

function appliedChangeFromFinding(
  finding: EvolutionFinding,
): AppliedEvolutionChange {
  if (finding.targetKind === "trigger-keywords") {
    return {
      trigger: finding.trigger,
      targetKind: "trigger-keywords",
      operation: "adjust-trigger-keywords",
      targetIntentIds: [],
      targetTrigger: finding.targetTrigger,
      keywordChange: {
        add: [...finding.addKeywords],
        remove: [...finding.removeKeywords],
      },
      dedupeKey: finding.dedupeKey,
      summary: finding.summary,
      evidence: [...finding.evidence],
      correctionGoal: finding.correctionGoal,
      suggestedChange: finding.suggestedChange,
    };
  }
  return {
    trigger: finding.trigger,
    targetKind: "intent-markdown",
    operation: finding.operation,
    targetIntentIds: [...finding.targetIntentIds],
    dedupeKey: finding.dedupeKey,
    summary: finding.summary,
    evidence: [...finding.evidence],
    correctionGoal: finding.correctionGoal,
    suggestedChange: finding.suggestedChange,
  };
}

function applyKeywordChange(
  current: string[],
  change: { add: string[]; remove: string[] },
): string[] {
  const remove = new Set(normalizeKeywordList(change.remove, []));
  return normalizeKeywordList(
    [...current.filter((keyword) => !remove.has(keyword)), ...change.add],
    [],
  );
}

export class EvolutionLogWriter {
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
  ): EvolutionLogWriter {
    return new EvolutionLogWriter(pluginRoot, options);
  }

  async record(
    eventId: string,
    source: EvolutionSource,
    findings: readonly EvolutionFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly EvolutionTrigger[];
      outcome?: ProcessedEventOutcome;
      changedIntentIds?: readonly string[];
      validationErrors?: readonly string[];
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const logPath = evolutionLogPath(this.pluginRoot);

    const result = await withFileLock(logPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        const triggerKeywordSeed = this.options.triggerKeywordSeed?.();
        const log = fileExists(logPath)
          ? readEvolutionLog(logPath, triggerKeywordSeed)
          : createEvolutionLog(nowIso, triggerKeywordSeed);

        pruneProcessedEvents(log, options.nowMs ?? Date.now());

        if (log.processedEvents[eventId]) return false;

        const changes = findings.map(appliedChangeFromFinding);
        for (const change of changes) {
          if (
            change.targetKind !== "trigger-keywords" ||
            !change.keywordChange
          ) {
            continue;
          }
          if (change.targetTrigger === "successful-pattern") {
            log.triggerKeywords.successfulPattern = applyKeywordChange(
              log.triggerKeywords.successfulPattern,
              change.keywordChange,
            );
          } else if (change.targetTrigger === "behavior-fix") {
            log.triggerKeywords.behaviorFix = applyKeywordChange(
              log.triggerKeywords.behaviorFix,
              change.keywordChange,
            );
          } else if (change.targetTrigger === "entity-context") {
            log.triggerKeywords.entityContext = applyKeywordChange(
              log.triggerKeywords.entityContext,
              change.keywordChange,
            );
          }
        }

        const triggers = [
          ...new Set(
            (
              options.triggers ?? findings.map((finding) => finding.trigger)
            ).filter(Boolean),
          ),
        ];
        const changedIntentIds = [
          ...new Set(
            (options.changedIntentIds ?? [])
              .map((intentId) => intentId.trim())
              .filter(Boolean),
          ),
        ];
        const validationErrors = [
          ...new Set(
            (options.validationErrors ?? [])
              .map((error) => error.trim())
              .filter(Boolean),
          ),
        ];
        const noFindingReasonCounts = normalizeNoFindingReasonCounts(
          options.noFindingReasonCounts,
        );
        const schemaRejectionReasonCounts =
          normalizeSchemaRejectionReasonCounts(
            options.schemaRejectionReasonCounts,
          );
        const outcome =
          options.outcome ?? (changes.length > 0 ? "applied" : "nofinding");

        log.updatedAt = nowIso;
        log.processedEvents[eventId] = {
          processedAt: nowIso,
          source,
          triggers,
          changeCount: changes.length,
          outcome,
          ...(changes.length > 0 ? { changes } : {}),
          ...(changedIntentIds.length > 0 ? { changedIntentIds } : {}),
          ...(validationErrors.length > 0 ? { validationErrors } : {}),
          ...(noFindingReasonCounts ? { noFindingReasonCounts } : {}),
          ...(schemaRejectionReasonCounts
            ? { schemaRejectionReasonCounts }
            : {}),
        };
        const validated = EvolutionLogSchema.parse(log);
        return safeWriteJson(
          logPath,
          validated,
          "failed to write evolution log",
        );
      } catch (err) {
        logger.warn("failed to update evolution log", {
          error: err,
          path: logPath,
        });
        return false;
      }
    });

    if (result === undefined) {
      logger.warn("failed to acquire lock for evolution log", {
        path: logPath,
      });
      return false;
    }
    if (result) this.options.onAfterWrite?.();
    return result;
  }
}

export const defaultEvolutionLogWriter = EvolutionLogWriter.create(pluginRoot);
