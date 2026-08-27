import { logger } from "../../api.js";
import {
  reviewLogPath,
  fileExists,
  readJsonFile,
  safeWriteJson,
  withFileLock,
} from "../file-utils.js";
import type { ReviewFinding, ReviewSource } from "./types.js";
import type { SkillPlacementCandidate } from "../stats/aggregator.js";
import {
  createReviewLogV7,
  ReviewLogV7Schema,
  parseReviewLogV7,
  pruneReviewLogV7Events,
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
  if (finding.targetKind === "skill-experience") {
    return {
      trigger: finding.trigger,
      targetKind: "skill-experience",
      operation: "create",
      targetIntentIds: [],
      targetExperienceIds: [...finding.targetExperienceIds],
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

export class IntentReviewLogWriter {
  constructor(private readonly dataRoot: string) {}

  completedSkillEpochKeys(): ReadonlySet<string> | undefined {
    const logPath = reviewLogPath(this.dataRoot);
    if (!fileExists(logPath)) return new Set();
    try {
      return new Set(
        Object.keys(
          parseReviewLogV7(readJsonFile<unknown>(logPath)).reviewedSkillEpochs,
        ),
      );
    } catch (error) {
      logger.warn("failed to read v7 completed skill epochs", {
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
      changedExperienceIds?: readonly string[];
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
          ? parseReviewLogV7(readJsonFile<unknown>(logPath))
          : createReviewLogV7(nowIso);
        pruneReviewLogV7Events(log, options.nowMs ?? Date.now());
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
          ...(options.changedExperienceIds?.length
            ? { changedExperienceIds: [...options.changedExperienceIds] }
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
          ReviewLogV7Schema.parse(log),
          "failed to write v7 historical keyword audit",
        );
      } catch (error) {
        logger.warn("failed to update v7 historical keyword audit", {
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
    findings: readonly ReviewFinding[],
    options: {
      nowMs?: number;
      triggers?: readonly ReviewTrigger[];
      outcome?: ProcessedEventOutcome;
      changedIntentIds?: readonly string[];
      changedExperienceIds?: readonly string[];
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
          ? parseReviewLogV7(readJsonFile<unknown>(logPath))
          : createReviewLogV7(nowIso);
        pruneReviewLogV7Events(log, options.nowMs ?? Date.now());
        if (Object.hasOwn(log.processedEvents, eventId)) return false;

        const changes = findings.map(appliedChangeFromFinding);
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
          ...(options.changedExperienceIds?.length
            ? { changedExperienceIds: [...options.changedExperienceIds] }
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
          ReviewLogV7Schema.parse(log),
          "failed to write v7 intent review log",
        );
      } catch (error) {
        logger.warn("failed to update v7 intent review log", {
          error,
          path: logPath,
        });
        return false;
      }
    });
    return result ?? false;
  }
}
