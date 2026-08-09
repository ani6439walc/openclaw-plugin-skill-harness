import { z } from "zod";
import { fileExists, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import type { ReviewFinding, ReviewSource } from "./types.js";
import { REVIEW_TRIGGER_TYPES, type ReviewTrigger } from "./triggers.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "../constants.js";
import { SKILL_SOURCE_ORDER, type SkillSource } from "../skills/types.js";
import type { SkillPlacementReason } from "../stats/aggregator.js";
import {
  normalizeReviewTriggerKeywords,
  normalizeKeywordList,
  type ReviewTriggerKeywords,
  type TriggerKeywordTarget,
} from "./trigger-keywords.js";

export const REVIEW_OPERATIONS = [
  "create",
  "refine",
  "split",
  "merge",
] as const;

export type ReviewOperation = (typeof REVIEW_OPERATIONS)[number];

export const PROCESSED_EVENT_OUTCOMES = [
  "applied",
  "nofinding",
  "schema-rejected",
  "parse-failed",
  "subagent-error",
  "validation-failed",
] as const;

export type ProcessedEventOutcome = (typeof PROCESSED_EVENT_OUTCOMES)[number];

export const NO_FINDING_REASON_CODES = [
  "routine-tool-use",
  "outside-intent-scope",
  "insufficient-evidence",
  "wrong-trigger",
  "already-covered",
  "privacy-sensitive",
] as const;

export type NoFindingReasonCode = (typeof NO_FINDING_REASON_CODES)[number];
export type NoFindingReasonCounts = Partial<
  Record<NoFindingReasonCode, number>
>;

export const SCHEMA_REJECTION_REASON_CODES = [
  "missing-required-field",
  "missing-trigger-decision",
  "missing-target",
  "invalid-operation",
  "invalid-trigger-keyword-target",
  "invalid-field-type",
  "too-long-field",
  "invalid-shape",
  "unknown",
] as const;

export type SchemaRejectionReasonCode =
  (typeof SCHEMA_REJECTION_REASON_CODES)[number];
export type SchemaRejectionReasonCounts = Partial<
  Record<SchemaRejectionReasonCode, number>
>;

export type AppliedReviewChange = {
  trigger: ReviewTrigger;
  targetKind: "intent-markdown" | "trigger-keywords";
  operation: ReviewOperation | "adjust-trigger-keywords";
  targetIntentIds: string[];
  targetTrigger?: TriggerKeywordTarget;
  keywordChange?: { add: string[]; remove: string[] };
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

export type ProcessedEventRecord = {
  processedAt: string;
  source?: ReviewSource;
  triggers: ReviewTrigger[];
  changeCount: number;
  outcome: ProcessedEventOutcome;
  changes?: AppliedReviewChange[];
  changedIntentIds?: string[];
  validationErrors?: string[];
  noFindingReasonCounts?: NoFindingReasonCounts;
  schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
};

export type AppliedIntentReviewChange = Omit<
  AppliedReviewChange,
  "targetKind" | "operation" | "targetTrigger" | "keywordChange"
> & {
  targetKind: "intent-markdown";
  operation: ReviewOperation;
};

export type IntentProcessedEventRecord = Omit<
  ProcessedEventRecord,
  "changes"
> & {
  changes?: AppliedIntentReviewChange[];
};

export type ReviewedSkillEpoch = {
  agentId: string;
  skillName: string;
  source: SkillSource;
  reason: SkillPlacementReason;
  completedAt: string;
  outcome: "applied" | "nofinding";
  eventId: string;
};

export type ReviewLog = {
  schemaVersion: 5;
  createdAt: string;
  updatedAt: string;
  triggerKeywords: ReviewTriggerKeywords;
  processedEvents: Record<string, ProcessedEventRecord>;
  reviewedSkillEpochs: Record<string, ReviewedSkillEpoch>;
};

export type ReviewLogV6 = {
  schemaVersion: 6;
  createdAt: string;
  updatedAt: string;
  processedEvents: Record<string, IntentProcessedEventRecord>;
  reviewedSkillEpochs: Record<string, ReviewedSkillEpoch>;
  historicalKeywordAudits: Record<string, ProcessedEventRecord>;
};

const ReviewSourceSchema = z
  .object({
    sessionId: z.string(),
    sessionKey: z.string().optional(),
    agentId: z.string().optional(),
    turnStart: z.string(),
  })
  .strict();

const TriggerKeywordTargetSchema = z.enum([
  "successful-pattern",
  "behavior-fix",
  "entity-context",
]);

const KeywordListSchema = z
  .array(z.string())
  .transform((values) => normalizeKeywordList(values, []));

const TriggerKeywordsSchema = z
  .object({
    successfulPattern: KeywordListSchema,
    behaviorFix: KeywordListSchema,
    entityContext: KeywordListSchema,
  })
  .strict();

const ProcessedEventOutcomeSchema = z.enum(PROCESSED_EVENT_OUTCOMES);

function normalizeAllowlistedCounts<T extends string>(
  value: unknown,
  allowedKeys: readonly T[],
): Partial<Record<T, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const output: Partial<Record<T, number>> = {};
  for (const reasonCode of allowedKeys) {
    const count = input[reasonCode];
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      output[reasonCode] = count;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function normalizeNoFindingReasonCounts(
  value: unknown,
): NoFindingReasonCounts | undefined {
  return normalizeAllowlistedCounts(value, NO_FINDING_REASON_CODES);
}

export function normalizeSchemaRejectionReasonCounts(
  value: unknown,
): SchemaRejectionReasonCounts | undefined {
  return normalizeAllowlistedCounts(value, SCHEMA_REJECTION_REASON_CODES);
}

const KeywordChangeSchema = z
  .object({
    add: KeywordListSchema,
    remove: KeywordListSchema,
  })
  .strict();

const AppliedReviewChangeSchema = z
  .object({
    trigger: z.enum(REVIEW_TRIGGER_TYPES),
    targetKind: z.enum(["intent-markdown", "trigger-keywords"]),
    operation: z.enum([...REVIEW_OPERATIONS, "adjust-trigger-keywords"]),
    targetIntentIds: z.array(z.string().trim().min(1)),
    targetTrigger: TriggerKeywordTargetSchema.optional(),
    keywordChange: KeywordChangeSchema.optional(),
    dedupeKey: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    evidence: z.array(z.string()),
    correctionGoal: z.string().trim().min(1),
    suggestedChange: z.string().trim().min(1),
  })
  .strict()
  .transform((change): AppliedReviewChange => change);

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

const PositiveCountsSchema = z.record(z.string(), z.number().int().positive());
const NoFindingReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, NO_FINDING_REASON_CODES),
).transform((value): NoFindingReasonCounts => value);
const SchemaRejectionReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, SCHEMA_REJECTION_REASON_CODES),
).transform((value): SchemaRejectionReasonCounts => value);

const ProcessedEventRecordSchema = z
  .object({
    processedAt: z.string(),
    source: ReviewSourceSchema.optional(),
    triggers: z.array(z.enum(REVIEW_TRIGGER_TYPES)),
    changeCount: z.number().int().nonnegative(),
    outcome: ProcessedEventOutcomeSchema,
    changes: z.array(AppliedReviewChangeSchema).optional(),
    changedIntentIds: z.array(z.string()).optional(),
    validationErrors: z.array(z.string()).optional(),
    noFindingReasonCounts: NoFindingReasonCountsSchema.optional(),
    schemaRejectionReasonCounts: SchemaRejectionReasonCountsSchema.optional(),
  })
  .strict()
  .transform((record): ProcessedEventRecord => record);

const ProcessedEventsSchema = z.record(z.string(), ProcessedEventRecordSchema);

const ReviewedSkillEpochSchema = z
  .object({
    agentId: z.string().trim().min(1),
    skillName: z.string().trim().min(1),
    source: z.enum(SKILL_SOURCE_ORDER),
    reason: z.enum(["low-adoption", "zero-recommendation-usage"]),
    completedAt: z.string(),
    outcome: z.enum(["applied", "nofinding"]),
    eventId: z.string().trim().min(1),
  })
  .strict();

const ReviewedSkillEpochsSchema = z.record(
  z.string().regex(/^[a-f0-9]{64}$/),
  ReviewedSkillEpochSchema,
);

export const ReviewLogSchema = z
  .object({
    schemaVersion: z.literal(5),
    createdAt: z.string(),
    updatedAt: z.string(),
    triggerKeywords: TriggerKeywordsSchema,
    processedEvents: ProcessedEventsSchema,
    reviewedSkillEpochs: ReviewedSkillEpochsSchema,
  })
  .strict();

const IntentAppliedReviewChangeSchema = z
  .object({
    trigger: z.enum(REVIEW_TRIGGER_TYPES),
    targetKind: z.literal("intent-markdown"),
    operation: z.enum(REVIEW_OPERATIONS),
    targetIntentIds: z.array(z.string().trim().min(1)),
    dedupeKey: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    evidence: z.array(z.string()),
    correctionGoal: z.string().trim().min(1),
    suggestedChange: z.string().trim().min(1),
  })
  .strict();

const IntentProcessedEventRecordSchema = z
  .object({
    processedAt: z.string(),
    source: ReviewSourceSchema.optional(),
    triggers: z.array(z.enum(REVIEW_TRIGGER_TYPES)),
    changeCount: z.number().int().nonnegative(),
    outcome: ProcessedEventOutcomeSchema,
    changes: z.array(IntentAppliedReviewChangeSchema).optional(),
    changedIntentIds: z.array(z.string()).optional(),
    validationErrors: z.array(z.string()).optional(),
    noFindingReasonCounts: NoFindingReasonCountsSchema.optional(),
    schemaRejectionReasonCounts: SchemaRejectionReasonCountsSchema.optional(),
  })
  .strict()
  .refine((record) =>
    record.triggers.every(
      (trigger) =>
        trigger !== "successful-pattern" &&
        trigger !== "behavior-fix" &&
        trigger !== "entity-context",
    ),
  );

const HistoricalKeywordAuditRecordSchema = ProcessedEventRecordSchema.refine(
  (record) =>
    record.triggers.some(
      (trigger) =>
        trigger === "successful-pattern" ||
        trigger === "behavior-fix" ||
        trigger === "entity-context",
    ) ||
    (record.changes ?? []).some(
      (change) => change.targetKind === "trigger-keywords",
    ),
);

export const ReviewLogV6Schema = z
  .object({
    schemaVersion: z.literal(6),
    createdAt: z.string(),
    updatedAt: z.string(),
    processedEvents: z.record(z.string(), IntentProcessedEventRecordSchema),
    reviewedSkillEpochs: ReviewedSkillEpochsSchema,
    historicalKeywordAudits: z.record(
      z.string(),
      HistoricalKeywordAuditRecordSchema,
    ),
  })
  .strict()
  .transform((log): ReviewLogV6 => log);

export function createReviewLog(
  nowIso: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewLog {
  return {
    schemaVersion: 5,
    createdAt: nowIso,
    updatedAt: nowIso,
    triggerKeywords: normalizeReviewTriggerKeywords(triggerKeywordSeed),
    processedEvents: {},
    reviewedSkillEpochs: {},
  };
}

export function createReviewLogV6(nowIso: string): ReviewLogV6 {
  return {
    schemaVersion: 6,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    reviewedSkillEpochs: {},
    historicalKeywordAudits: {},
  };
}

export function parseReviewLog(raw: unknown): ReviewLog {
  return ReviewLogSchema.parse(raw);
}

export function parseReviewLogV5ForMigration(raw: unknown): ReviewLog {
  return ReviewLogSchema.parse(raw);
}

export function parseReviewLogV6(raw: unknown): ReviewLogV6 {
  return ReviewLogV6Schema.parse(raw);
}

export function readReviewLog(logPath: string): ReviewLog {
  return parseReviewLog(readJsonFile<unknown>(logPath));
}

export function readReviewTriggerKeywords(
  logPath: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewTriggerKeywords {
  if (!fileExists(logPath)) {
    return normalizeReviewTriggerKeywords(triggerKeywordSeed);
  }
  return readReviewLog(logPath).triggerKeywords;
}

export function writeReviewLogAtomic(logPath: string, log: ReviewLog): void {
  const parsed = ReviewLogSchema.parse(log);
  writeJsonAtomic(logPath, parsed);
}

export function pruneProcessedEvents(
  log: ReviewLog,
  nowMs: number = Date.now(),
): void {
  const cutoff = nowMs - PROCESSED_EVENTS_RETENTION_DAYS * 86_400_000;
  for (const eventId in log.processedEvents) {
    const eventTime = new Date(
      log.processedEvents[eventId].processedAt,
    ).getTime();
    if (Number.isNaN(eventTime) || eventTime < cutoff) {
      delete log.processedEvents[eventId];
    }
  }
}
