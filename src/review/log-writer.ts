import { logger } from "../../api.js";
import {
  pluginRoot,
  reviewLogPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
  withFileLock,
} from "../file-utils.js";
import type {
  IntentMarkdownReviewFinding,
  ReviewFinding,
  ReviewSource,
} from "./types.js";
import type { SkillPlacementCandidate } from "../stats/aggregator.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";
import { normalizeKeywordList } from "./trigger-keywords.js";
import {
  createReviewLog,
  createReviewLogV6,
  readReviewLog,
  pruneProcessedEvents,
  ReviewLogSchema,
  ReviewLogV6Schema,
  parseReviewLogV6,
  pruneReviewLogV6Events,
  normalizeNoFindingReasonCounts,
  normalizeSchemaRejectionReasonCounts,
  type AppliedIntentReviewChange,
  type AppliedReviewChange,
  type NoFindingReasonCounts,
  type ProcessedEventOutcome,
  type SchemaRejectionReasonCounts,
} from "./log.js";
import type { ReviewTrigger } from "./triggers.js";

function appliedChangeFromFinding(finding: ReviewFinding): AppliedReviewChange {
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

function appliedIntentChangeFromFinding(
  finding: IntentMarkdownReviewFinding,
): AppliedIntentReviewChange {
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
  const add = normalizeKeywordList(change.add, []).filter(
    (keyword) => !remove.has(keyword),
  );
  return normalizeKeywordList(
    [...current.filter((keyword) => !remove.has(keyword)), ...add],
    [],
  );
}

export class ReviewLogWriter {
  private constructor(
    private readonly pluginRoot: string,
    private readonly options: {
      triggerKeywordSeed?: () => Partial<ReviewTriggerKeywords> | undefined;
      onAfterWrite?: () => void;
    } = {},
  ) {}

  static create(
    pluginRoot: string,
    options: {
      triggerKeywordSeed?: () => Partial<ReviewTriggerKeywords> | undefined;
      onAfterWrite?: () => void;
    } = {},
  ): ReviewLogWriter {
    return new ReviewLogWriter(pluginRoot, options);
  }

  completedSkillEpochKeys(): ReadonlySet<string> | undefined {
    const logPath = reviewLogPath(this.pluginRoot);
    if (!fileExists(logPath)) return new Set();
    try {
      return new Set(Object.keys(readReviewLog(logPath).reviewedSkillEpochs));
    } catch (error) {
      logger.warn("failed to read completed skill epochs", {
        error,
        path: logPath,
      });
      return undefined;
    }
  }

  async record(
    eventId: string,
    source: ReviewSource,
    findings: readonly ReviewFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly ReviewTrigger[];
      outcome?: ProcessedEventOutcome;
      changedIntentIds?: readonly string[];
      validationErrors?: readonly string[];
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
      skillPlacementCandidate?: SkillPlacementCandidate;
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const logPath = reviewLogPath(this.pluginRoot);

    const result = await withFileLock(logPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        const triggerKeywordSeed = this.options.triggerKeywordSeed?.();
        const log = fileExists(logPath)
          ? readReviewLog(logPath)
          : createReviewLog(nowIso, triggerKeywordSeed);

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

        const candidate = options.skillPlacementCandidate;
        if (
          candidate &&
          (outcome === "applied" || outcome === "nofinding") &&
          !Object.hasOwn(log.reviewedSkillEpochs, candidate.epochKey)
        ) {
          Object.defineProperty(log.reviewedSkillEpochs, candidate.epochKey, {
            configurable: true,
            enumerable: true,
            value: {
              agentId: candidate.agentId,
              skillName: candidate.name,
              source: candidate.source,
              reason: candidate.reason,
              completedAt: nowIso,
              outcome,
              eventId,
            },
            writable: true,
          });
        }

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
        const validated = ReviewLogSchema.parse(log);
        return safeWriteJson(logPath, validated, "failed to write review log");
      } catch (err) {
        logger.warn("failed to update review log", {
          error: err,
          path: logPath,
        });
        return false;
      }
    });

    if (result === undefined) {
      logger.warn("failed to acquire lock for review log", {
        path: logPath,
      });
      return false;
    }
    if (result) this.options.onAfterWrite?.();
    return result;
  }
}

export class IntentReviewLogWriter {
  private constructor(private readonly dataRoot: string) {}

  static create(dataRoot: string): IntentReviewLogWriter {
    return new IntentReviewLogWriter(dataRoot);
  }

  completedSkillEpochKeys(): ReadonlySet<string> | undefined {
    const logPath = reviewLogPath(this.dataRoot);
    if (!fileExists(logPath)) return new Set();
    try {
      return new Set(
        Object.keys(
          parseReviewLogV6(readJsonFile<unknown>(logPath)).reviewedSkillEpochs,
        ),
      );
    } catch (error) {
      logger.warn("failed to read v6 completed skill epochs", {
        error,
        path: logPath,
      });
      return undefined;
    }
  }

  async recordHistoricalKeywordAudit(
    eventId: string,
    source: ReviewSource,
    findings: readonly ReviewFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly ReviewTrigger[];
      outcome?: ProcessedEventOutcome;
      changedIntentIds?: readonly string[];
      validationErrors?: readonly string[];
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const logPath = reviewLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        const log = fileExists(logPath)
          ? parseReviewLogV6(readJsonFile<unknown>(logPath))
          : createReviewLogV6(nowIso);
        pruneReviewLogV6Events(log, options.nowMs ?? Date.now());
        if (Object.hasOwn(log.historicalKeywordAudits, eventId)) return false;

        const changes = findings.map(appliedChangeFromFinding);
        const outcome =
          options.outcome ?? (changes.length > 0 ? "applied" : "nofinding");
        log.historicalKeywordAudits[eventId] = {
          processedAt: nowIso,
          source,
          triggers: [
            ...new Set(
              options.triggers ?? findings.map((finding) => finding.trigger),
            ),
          ],
          changeCount: changes.length,
          outcome,
          ...(changes.length > 0 ? { changes } : {}),
          ...(options.changedIntentIds?.length
            ? { changedIntentIds: [...options.changedIntentIds] }
            : {}),
          ...(options.validationErrors?.length
            ? { validationErrors: [...options.validationErrors] }
            : {}),
          ...(options.noFindingReasonCounts
            ? { noFindingReasonCounts: options.noFindingReasonCounts }
            : {}),
          ...(options.schemaRejectionReasonCounts
            ? {
                schemaRejectionReasonCounts:
                  options.schemaRejectionReasonCounts,
              }
            : {}),
        };
        log.updatedAt = nowIso;
        return safeWriteJson(
          logPath,
          ReviewLogV6Schema.parse(log),
          "failed to write v6 historical keyword audit",
        );
      } catch (error) {
        logger.warn("failed to update v6 historical keyword audit", {
          error,
          path: logPath,
        });
        return false;
      }
    });
    return result ?? false;
  }

  async record(
    eventId: string,
    source: ReviewSource,
    findings: readonly IntentMarkdownReviewFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly ReviewTrigger[];
      outcome?: ProcessedEventOutcome;
      changedIntentIds?: readonly string[];
      validationErrors?: readonly string[];
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
      skillPlacementCandidate?: SkillPlacementCandidate;
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const logPath = reviewLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        const log = fileExists(logPath)
          ? parseReviewLogV6(readJsonFile<unknown>(logPath))
          : createReviewLogV6(nowIso);
        pruneReviewLogV6Events(log, options.nowMs ?? Date.now());
        if (Object.hasOwn(log.processedEvents, eventId)) return false;

        const changes = findings.map(appliedIntentChangeFromFinding);
        const outcome =
          options.outcome ?? (changes.length > 0 ? "applied" : "nofinding");
        const candidate = options.skillPlacementCandidate;
        if (
          candidate &&
          (outcome === "applied" || outcome === "nofinding") &&
          Object.hasOwn(log.reviewedSkillEpochs, candidate.epochKey)
        ) {
          return false;
        }
        if (candidate && (outcome === "applied" || outcome === "nofinding")) {
          Object.defineProperty(log.reviewedSkillEpochs, candidate.epochKey, {
            configurable: true,
            enumerable: true,
            value: {
              agentId: candidate.agentId,
              skillName: candidate.name,
              source: candidate.source,
              reason: candidate.reason,
              completedAt: nowIso,
              outcome,
              eventId,
            },
            writable: true,
          });
        }
        log.processedEvents[eventId] = {
          processedAt: nowIso,
          source,
          triggers: [
            ...new Set(
              options.triggers ?? findings.map((finding) => finding.trigger),
            ),
          ],
          changeCount: changes.length,
          outcome,
          ...(changes.length > 0 ? { changes } : {}),
          ...(options.changedIntentIds?.length
            ? { changedIntentIds: [...options.changedIntentIds] }
            : {}),
          ...(options.validationErrors?.length
            ? { validationErrors: [...options.validationErrors] }
            : {}),
          ...(options.noFindingReasonCounts
            ? { noFindingReasonCounts: options.noFindingReasonCounts }
            : {}),
          ...(options.schemaRejectionReasonCounts
            ? {
                schemaRejectionReasonCounts:
                  options.schemaRejectionReasonCounts,
              }
            : {}),
        };
        log.updatedAt = nowIso;
        return safeWriteJson(
          logPath,
          ReviewLogV6Schema.parse(log),
          "failed to write v6 intent review log",
        );
      } catch (error) {
        logger.warn("failed to update v6 intent review log", {
          error,
          path: logPath,
        });
        return false;
      }
    });
    return result ?? false;
  }
}

export const defaultReviewLogWriter = ReviewLogWriter.create(pluginRoot);
