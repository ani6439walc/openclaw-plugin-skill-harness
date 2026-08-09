import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  fileExists,
  readJsonFile,
  withFileLock,
  writeJsonAtomic,
} from "../file-utils.js";
import {
  createKeywordCoverageLog,
  parseKeywordCoverageLog,
  type KeywordCoverageLog,
} from "./keyword-coverage-log.js";
import {
  createReviewLogV6,
  parseReviewLogV5ForMigration,
  parseReviewLogV6,
  type ProcessedEventRecord,
  type ReviewLog,
  type ReviewLogV6,
} from "./log.js";

export interface KeywordStateMigrationResult {
  status: "not-needed" | "migrated" | "recovered" | "failed";
}

export interface KeywordStateMigrationInput {
  reviewPath: string;
  keywordCoveragePath: string;
  nowMs?: number;
}

function hashRawReview(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isKeywordAudit(record: ProcessedEventRecord): boolean {
  return (
    record.triggers.some(
      (trigger) =>
        trigger === "successful-pattern" ||
        trigger === "behavior-fix" ||
        trigger === "entity-context",
    ) ||
    (record.changes ?? []).some(
      (change) => change.targetKind === "trigger-keywords",
    )
  );
}

function migrateReview(log: ReviewLog): ReviewLogV6 {
  const migrated = createReviewLogV6(log.updatedAt);
  migrated.createdAt = log.createdAt;
  migrated.updatedAt = log.updatedAt;
  migrated.reviewedSkillEpochs = log.reviewedSkillEpochs;
  for (const [eventId, record] of Object.entries(log.processedEvents)) {
    if (isKeywordAudit(record)) {
      migrated.historicalKeywordAudits[eventId] = record;
    } else {
      migrated.processedEvents[eventId] = parseReviewLogV6({
        ...createReviewLogV6(log.updatedAt),
        processedEvents: { [eventId]: record },
      }).processedEvents[eventId];
    }
  }
  return parseReviewLogV6(migrated);
}

function finishMigration(
  coverage: KeywordCoverageLog,
  completedAt: string,
): KeywordCoverageLog {
  if (!coverage.migration) throw new Error("missing migration marker");
  return parseKeywordCoverageLog({
    ...coverage,
    updatedAt: completedAt,
    migration: {
      ...coverage.migration,
      completedAt,
    },
  });
}

export async function migrateKeywordStateOnce(
  input: KeywordStateMigrationInput,
): Promise<KeywordStateMigrationResult> {
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const migrationLockPath = `${input.keywordCoveragePath}.migration`;
  const result = await withFileLock<KeywordStateMigrationResult>(
    migrationLockPath,
    async () => {
      const reviewResult = await withFileLock<KeywordStateMigrationResult>(
        input.reviewPath,
        async () =>
          (await withFileLock<KeywordStateMigrationResult>(
            input.keywordCoveragePath,
            async () => {
              try {
                if (!fileExists(input.reviewPath))
                  return { status: "not-needed" };
                const rawReview = fs.readFileSync(input.reviewPath, "utf8");
                const reviewRaw = JSON.parse(rawReview) as unknown;

                if (fileExists(input.keywordCoveragePath)) {
                  const coverage = parseKeywordCoverageLog(
                    readJsonFile<unknown>(input.keywordCoveragePath),
                  );
                  try {
                    parseReviewLogV6(reviewRaw);
                    return { status: "not-needed" };
                  } catch {
                    // Only a validated unchanged v5 source may recover an incomplete cutover.
                  }
                  const legacy = parseReviewLogV5ForMigration(reviewRaw);
                  if (
                    !coverage.migration ||
                    coverage.migration.completedAt ||
                    coverage.migration.sourceReviewSha256 !==
                      hashRawReview(rawReview)
                  ) {
                    return { status: "failed" };
                  }
                  writeJsonAtomic(input.reviewPath, migrateReview(legacy));
                  writeJsonAtomic(
                    input.keywordCoveragePath,
                    finishMigration(coverage, nowIso),
                  );
                  return { status: "recovered" };
                }

                const legacy = parseReviewLogV5ForMigration(reviewRaw);
                const coverage = createKeywordCoverageLog(
                  nowIso,
                  legacy.triggerKeywords,
                );
                coverage.migration = {
                  sourceReviewSha256: hashRawReview(rawReview),
                };
                writeJsonAtomic(
                  input.keywordCoveragePath,
                  parseKeywordCoverageLog(coverage),
                );
                writeJsonAtomic(input.reviewPath, migrateReview(legacy));
                writeJsonAtomic(
                  input.keywordCoveragePath,
                  finishMigration(coverage, nowIso),
                );
                return { status: "migrated" };
              } catch {
                return { status: "failed" };
              }
            },
          )) ?? { status: "failed" },
      );
      return reviewResult ?? { status: "failed" };
    },
  );
  return result ?? { status: "failed" };
}
