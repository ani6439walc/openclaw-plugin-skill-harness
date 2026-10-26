import { logger } from "../../api.js";
import {
  reviewLogPath,
  fileExists,
  readJsonFile,
  writeJsonAtomic,
  withFileLock,
} from "../file-utils.js";
import type {
  ReviewDomainOutcome,
  ReviewFinding,
  ReviewSource,
} from "./types.js";
import {
  createReviewLog,
  ReviewLogSchema,
  parseReviewLog,
  pruneReviewLogEvents,
  type AppliedReviewChange,
  type NoFindingReasonCounts,
  type ProcessedEventOutcome,
  type SchemaRejectionReasonCounts,
} from "./log.js";
import type { ReviewTrigger } from "./triggers.js";
import { safeErrorClassification } from "../error-diagnostics.js";

function appliedChangeFromFinding(finding: ReviewFinding): AppliedReviewChange {
  const common = {
    trigger: finding.trigger,
    dedupeKey: finding.dedupeKey,
    summary: finding.summary,
    evidence: [...finding.evidence],
    correctionGoal: finding.correctionGoal,
    suggestedChange: finding.suggestedChange,
  };
  if (finding.targetKind === "skill-relation") {
    return {
      ...common,
      targetKind: "skill-relation",
      operation: finding.operation,
      fromSkillId: finding.fromSkillId,
      toSkillId: finding.toSkillId,
      ...(finding.relationType !== undefined
        ? { relationType: finding.relationType }
        : {}),
      ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
      relationEvidence: finding.relationEvidence.map((entry) => ({ ...entry })),
    };
  }
  return {
    ...common,
    targetKind: "skill-experience",
    operation: finding.operation,
    targetExperienceIds: [...finding.targetExperienceIds],
    ...(finding.operation === "merge"
      ? {
          sourceExperienceIds: [...finding.sourceExperienceIds],
          retainedExperienceId: finding.retainedExperienceId,
        }
      : {}),
  };
}

function readReviewLog(raw: unknown, nowIso: string) {
  try {
    return parseReviewLog(raw);
  } catch {
    return createReviewLog(nowIso);
  }
}

export class IntentReviewLogWriter {
  constructor(private readonly dataRoot: string) {}

  completedSkillEpochKeys(): ReadonlySet<string> | undefined {
    const logPath = reviewLogPath(this.dataRoot);
    if (!fileExists(logPath)) return new Set();
    try {
      return new Set(
        Object.keys(
          readReviewLog(
            readJsonFile<unknown>(logPath),
            new Date().toISOString(),
          ).reviewedSkillEpochs,
        ),
      );
    } catch (error) {
      const diagnostic = safeErrorClassification(error);
      logger.warn(
        `failed to read completed skill epochs reason=${diagnostic.reason}${diagnostic.code ? ` code=${diagnostic.code}` : ""}`,
      );
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
      changedExperienceIds?: readonly string[];
      changedRelationCount?: number;
      relationBatchId?: string;
      relationOutcome?: ReviewDomainOutcome;
      experienceOutcome?: ReviewDomainOutcome;
      partialExperienceIds?: readonly string[];
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
        let log = createReviewLog(nowIso);
        if (fileExists(logPath)) {
          try {
            log = readReviewLog(readJsonFile<unknown>(logPath), nowIso);
          } catch {
            // Invalid runtime state starts a fresh review window.
          }
        }
        pruneReviewLogEvents(log, options.nowMs ?? Date.now());
        if (Object.hasOwn(log.processedEvents, eventId)) return false;

        const changes = findings.map(appliedChangeFromFinding);
        const outcome =
          options.outcome ?? (changes.length > 0 ? "applied" : "nofinding");
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
          ...(options.changedRelationCount !== undefined
            ? { changedRelationCount: options.changedRelationCount }
            : {}),
          ...(options.relationBatchId !== undefined
            ? { relationBatchId: options.relationBatchId }
            : {}),
          ...(options.relationOutcome !== undefined
            ? { relationOutcome: options.relationOutcome }
            : {}),
          ...(options.experienceOutcome !== undefined
            ? { experienceOutcome: options.experienceOutcome }
            : {}),
          ...(options.partialExperienceIds?.length
            ? { partialExperienceIds: [...options.partialExperienceIds] }
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
        writeJsonAtomic(logPath, ReviewLogSchema.parse(log));
        return true;
      } catch (error) {
        const diagnostic = safeErrorClassification(error);
        logger.warn(
          `failed to update v8 intent review log reason=${diagnostic.reason}${diagnostic.code ? ` code=${diagnostic.code}` : ""}`,
        );
        return false;
      }
    });
    return result ?? false;
  }
}
