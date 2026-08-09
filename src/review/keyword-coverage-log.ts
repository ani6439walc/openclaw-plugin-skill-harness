import { createHash } from "node:crypto";
import { z } from "zod";
import { KEYWORD_COVERAGE_RETENTION_DAYS } from "../constants.js";
import {
  normalizeReviewTriggerKeywords,
  type ReviewTriggerKeywords,
  type TriggerKeywordTarget,
} from "./trigger-keywords.js";

export interface ProcessedKeywordEvent {
  processedAt: string;
  targets: TriggerKeywordTarget[];
  outcome: "applied" | "nofinding";
  mutations: Array<{
    target: TriggerKeywordTarget;
    add: string[];
    remove: string[];
  }>;
}

export interface KeywordCoverageTargetState {
  cursor?: string;
  lastCompletedAcceptedTurn?: number;
}

export interface KeywordCoverageEpoch {
  reservedAt: string;
  targets: TriggerKeywordTarget[];
  acceptedTurn: number;
  outcome?: "applied" | "nofinding";
  completedAt?: string;
}

export interface KeywordCoverageLog {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  triggerKeywords: ReviewTriggerKeywords;
  processedKeywordEvents: Record<string, ProcessedKeywordEvent>;
  targets: Partial<Record<TriggerKeywordTarget, KeywordCoverageTargetState>>;
  coverageEpochs: Record<string, KeywordCoverageEpoch>;
  migration?: {
    sourceReviewSha256: string;
    completedAt?: string;
  };
}

const TargetSchema = z.enum([
  "successful-pattern",
  "behavior-fix",
  "entity-context",
]);
const IsoTimestampSchema = z
  .string()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const OpaqueHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const KeywordListSchema = z
  .array(z.string())
  .transform((values) => values.map((value) => value.trim()).filter(Boolean));

const TriggerKeywordsSchema = z
  .object({
    successfulPattern: KeywordListSchema,
    behaviorFix: KeywordListSchema,
    entityContext: KeywordListSchema,
  })
  .strict()
  .transform((value) => normalizeReviewTriggerKeywords(value));

const ProcessedKeywordEventSchema = z
  .object({
    processedAt: IsoTimestampSchema,
    targets: z.array(TargetSchema),
    outcome: z.enum(["applied", "nofinding"]),
    mutations: z.array(
      z
        .object({
          target: TargetSchema,
          add: KeywordListSchema,
          remove: KeywordListSchema,
        })
        .strict(),
    ),
  })
  .strict();

const KeywordCoverageTargetStateSchema = z
  .object({
    cursor: z.string().optional(),
    lastCompletedAcceptedTurn: z.number().int().nonnegative().optional(),
  })
  .strict();

const KeywordCoverageEpochSchema = z
  .object({
    reservedAt: IsoTimestampSchema,
    targets: z.array(TargetSchema),
    acceptedTurn: z.number().int().nonnegative(),
    outcome: z.enum(["applied", "nofinding"]).optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();

const MigrationSchema = z
  .object({
    sourceReviewSha256: OpaqueHashSchema,
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();

export const KeywordCoverageLogSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    triggerKeywords: TriggerKeywordsSchema,
    processedKeywordEvents: z.record(
      OpaqueHashSchema,
      ProcessedKeywordEventSchema,
    ),
    targets: z.partialRecord(TargetSchema, KeywordCoverageTargetStateSchema),
    coverageEpochs: z.record(OpaqueHashSchema, KeywordCoverageEpochSchema),
    migration: MigrationSchema.optional(),
  })
  .strict();

export function createKeywordCoverageLog(
  nowIso: string,
  keywords?: Partial<ReviewTriggerKeywords>,
): KeywordCoverageLog {
  return {
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    triggerKeywords: normalizeReviewTriggerKeywords(keywords),
    processedKeywordEvents: {},
    targets: {},
    coverageEpochs: {},
  };
}

export function parseKeywordCoverageLog(raw: unknown): KeywordCoverageLog {
  return KeywordCoverageLogSchema.parse(raw);
}

export function pruneKeywordCoverageLog(
  log: KeywordCoverageLog,
  nowMs: number,
): boolean {
  let changed = false;
  const retentionMs = KEYWORD_COVERAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [eventHash, event] of Object.entries(log.processedKeywordEvents)) {
    if (nowMs - Date.parse(event.processedAt) >= retentionMs) {
      delete log.processedKeywordEvents[eventHash];
      changed = true;
    }
  }
  for (const [epochKey, epoch] of Object.entries(log.coverageEpochs)) {
    if (!epoch.outcome || !epoch.completedAt) continue;
    if (nowMs - Date.parse(epoch.completedAt) >= retentionMs) {
      delete log.coverageEpochs[epochKey];
      changed = true;
    }
  }
  return changed;
}

export function hashKeywordEventId(eventId: string): string {
  return createHash("sha256").update(eventId).digest("hex");
}
