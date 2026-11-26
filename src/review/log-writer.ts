import { logger } from "../../api.js";
import {
  reviewLogPath,
  fileExists,
  readJsonFile,
  writeJsonAtomic,
  withFileLock,
} from "../file-utils.js";
import type {
  RelationReviewAssessment,
  ReviewDomainOutcome,
  ReviewFinding,
  ReviewSource,
} from "./types.js";
import {
  createReviewLog,
  ReviewLogSchema,
  parseReviewLog,
  pruneReviewLogEvents,
  type NoFindingReasonCounts,
  type ProcessedEventOutcome,
  type SchemaRejectionReasonCounts,
  MAX_RELATION_INSPECTION_CURSORS,
} from "./log.js";
import type { RelationPreparationSummary } from "./relations.js";
import { REVIEW_TRIGGER } from "./triggers.js";
import { safeErrorClassification } from "../error-diagnostics.js";

export class IntentReviewLogWriter {
  constructor(private readonly dataRoot: string) {}

  /** A missing log starts a new inspection. Existing history must admit this event. */
  inspectionOffsetsForEvent(
    eventId: string,
  ): ((key: string) => number) | undefined {
    try {
      const log = parseReviewLog(
        readJsonFile<unknown>(reviewLogPath(this.dataRoot)),
      );
      if (Object.hasOwn(log.processedEvents, eventId)) return;
      return (key) => log.relationInspectionCursors?.[key]?.offset ?? 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return () => 0;
      const diagnostic = safeErrorClassification(error);
      logger.warn(
        `skipping relation review: incompatible or unreadable log reason=${diagnostic.reason}`,
      );
      return;
    }
  }

  async record(
    eventId: string,
    source: ReviewSource,
    findings: readonly ReviewFinding[],
    options: {
      nowMs?: number;
      outcome?: ProcessedEventOutcome;
      changedRelationCount?: number;
      relationBatchId?: string;
      relationOutcome?: ReviewDomainOutcome;
      validationErrors?: readonly string[];
      noFindingReasonCounts?: NoFindingReasonCounts;
      schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
      relationPreparation?: RelationPreparationSummary;
      relationReview?: RelationReviewAssessment;
      relationSearchCount?: number;
      relationInspectionCursor?: { key: string; nextOffset: number };
    } = {},
  ): Promise<boolean> {
    if (!eventId) return false;
    const logPath = reviewLogPath(this.dataRoot);
    const result = await withFileLock(logPath, async () => {
      try {
        const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
        let log = createReviewLog(nowIso);
        if (fileExists(logPath)) {
          // Unknown/newer or corrupt history must never be replaced by an empty log.
          log = parseReviewLog(readJsonFile<unknown>(logPath));
        }
        pruneReviewLogEvents(log, options.nowMs ?? Date.now());
        if (Object.hasOwn(log.processedEvents, eventId)) return false;

        const changes = [...findings];
        const outcome =
          options.outcome ?? (changes.length > 0 ? "applied" : "nofinding");
        log.processedEvents[eventId] = {
          processedAt: nowIso,
          source,
          triggers: [REVIEW_TRIGGER],
          changeCount: changes.length,
          outcome,
          ...(changes.length > 0 ? { changes } : {}),
          ...(options.changedRelationCount !== undefined
            ? { changedRelationCount: options.changedRelationCount }
            : {}),
          ...(options.relationBatchId !== undefined
            ? { relationBatchId: options.relationBatchId }
            : {}),
          ...(options.relationOutcome !== undefined
            ? { relationOutcome: options.relationOutcome }
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
          ...(options.relationPreparation
            ? { relationPreparation: options.relationPreparation }
            : {}),
          ...(options.relationReview
            ? { relationReview: options.relationReview }
            : {}),
          ...(options.relationSearchCount !== undefined
            ? { relationSearchCount: options.relationSearchCount }
            : {}),
        };
        if (options.relationInspectionCursor) {
          const { key, nextOffset } = options.relationInspectionCursor;
          if (
            !/^[a-f0-9]{64}$/.test(key) ||
            !Number.isSafeInteger(nextOffset) ||
            nextOffset < 0
          )
            throw new Error("invalid-relation-inspection-cursor");
          const cursors = (log.relationInspectionCursors ??= {});
          cursors[key] = { offset: nextOffset, updatedAt: nowIso };
          const oldest = Object.keys(cursors).sort((a, b) => {
            const left = cursors[a]!.updatedAt,
              right = cursors[b]!.updatedAt;
            return left < right
              ? -1
              : left > right
                ? 1
                : a < b
                  ? -1
                  : a > b
                    ? 1
                    : 0;
          });
          for (const stale of oldest.slice(
            0,
            Math.max(0, oldest.length - MAX_RELATION_INSPECTION_CURSORS),
          ))
            delete cursors[stale];
        }
        log.updatedAt = nowIso;
        writeJsonAtomic(logPath, ReviewLogSchema.parse(log));
        return true;
      } catch (error) {
        const diagnostic = safeErrorClassification(error);
        logger.warn(
          `failed to update relation review log reason=${diagnostic.reason}${diagnostic.code ? ` code=${diagnostic.code}` : ""}`,
        );
        return false;
      }
    });
    return result ?? false;
  }
}
