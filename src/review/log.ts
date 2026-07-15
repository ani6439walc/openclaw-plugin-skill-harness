import { z } from "zod";
import { fileExists, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import type { ReviewFinding, ReviewSource } from "./types.js";
import { REVIEW_TRIGGER_TYPES, type ReviewTrigger } from "./triggers.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "../constants.js";
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
  "unknown",
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

export type ReviewLog = {
  schemaVersion: 4;
  createdAt: string;
  updatedAt: string;
  triggerKeywords: ReviewTriggerKeywords;
  processedEvents: Record<string, ProcessedEventRecord>;
};

const LEGACY_TRIGGER_TYPE_MAP: Record<string, ReviewTrigger> = {
  skill_candidate: "skill-candidate",
  process_gap: "process-gap",
  successful_pattern: "successful-pattern",
  satisfaction_check: "satisfaction-check",
  missing_intent: "missing-intent",
  weak_intent: "weak-intent",
  behavior_fix: "behavior-fix",
  entity_context: "entity-context",
};

function normalizeTrigger(value: unknown): ReviewTrigger | undefined {
  if (typeof value !== "string") return;
  const normalized = LEGACY_TRIGGER_TYPE_MAP[value] ?? value;
  return (REVIEW_TRIGGER_TYPES as readonly string[]).includes(normalized)
    ? (normalized as ReviewTrigger)
    : undefined;
}

const ReviewSourceSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  turnStart: z.string(),
});

const TriggerKeywordTargetSchema = z.enum([
  "successful-pattern",
  "behavior-fix",
  "entity-context",
]);

const TriggerKeywordsSchema = z
  .unknown()
  .transform((value) => normalizeReviewTriggerKeywords(value));

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

const KeywordChangeSchema = z.object({
  add: z
    .array(z.string())
    .catch([])
    .transform((values) => normalizeKeywordList(values, [])),
  remove: z
    .array(z.string())
    .catch([])
    .transform((values) => normalizeKeywordList(values, [])),
});

const AppliedReviewChangeSchema = z
  .object({
    trigger: z.unknown().transform((value, ctx): ReviewTrigger => {
      const trigger = normalizeTrigger(value);
      if (!trigger) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid trigger",
        });
        return z.NEVER;
      }
      return trigger;
    }),
    targetKind: z.enum(["intent-markdown", "trigger-keywords"]),
    operation: z.enum([...REVIEW_OPERATIONS, "adjust-trigger-keywords"]),
    targetIntentIds: z.array(z.string().trim().min(1)).catch([]),
    targetTrigger: TriggerKeywordTargetSchema.optional(),
    keywordChange: KeywordChangeSchema.optional(),
    dedupeKey: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    evidence: z.array(z.string()).catch([]),
    correctionGoal: z.string().trim().min(1),
    suggestedChange: z.string().trim().min(1),
  })
  .transform((change): AppliedReviewChange => change);

const ProcessedEventRecordSchema = z.union([
  z.string().transform((processedAt): ProcessedEventRecord => ({
    processedAt,
    triggers: [],
    changeCount: 0,
    outcome: "unknown",
  })),
  z
    .object({
      processedAt: z.string(),
      source: ReviewSourceSchema.optional(),
      triggers: z
        .array(z.unknown())
        .catch([])
        .transform((values) =>
          values.flatMap((value) => normalizeTrigger(value) ?? []),
        ),
      findingCount: z.number().int().nonnegative().optional(),
      changeCount: z.number().int().nonnegative().optional(),
      outcome: z
        .union([ProcessedEventOutcomeSchema, z.literal("wrote-items")])
        .catch("unknown"),
      changes: z.array(AppliedReviewChangeSchema).optional(),
      changedIntentIds: z.array(z.string()).optional(),
      validationErrors: z.array(z.string()).optional(),
      noFindingReasonCounts: z.unknown().optional(),
      schemaRejectionReasonCounts: z.unknown().optional(),
    })
    .transform(
      ({
        findingCount,
        changeCount,
        outcome,
        noFindingReasonCounts,
        schemaRejectionReasonCounts,
        ...record
      }): ProcessedEventRecord => {
        const normalizedReasonCounts = normalizeNoFindingReasonCounts(
          noFindingReasonCounts,
        );
        const normalizedSchemaRejectionCounts =
          normalizeSchemaRejectionReasonCounts(schemaRejectionReasonCounts);
        return {
          ...record,
          changeCount:
            changeCount ?? findingCount ?? record.changes?.length ?? 0,
          outcome: outcome === "wrote-items" ? "applied" : outcome,
          ...(normalizedReasonCounts
            ? { noFindingReasonCounts: normalizedReasonCounts }
            : {}),
          ...(normalizedSchemaRejectionCounts
            ? { schemaRejectionReasonCounts: normalizedSchemaRejectionCounts }
            : {}),
        };
      },
    ),
]);

const ProcessedEventsSchema = z.record(z.string(), ProcessedEventRecordSchema);

export const ReviewLogSchema = z.object({
  schemaVersion: z.literal(4),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggerKeywords: TriggerKeywordsSchema,
  processedEvents: ProcessedEventsSchema,
});

export function createReviewLog(
  nowIso: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewLog {
  return {
    schemaVersion: 4,
    createdAt: nowIso,
    updatedAt: nowIso,
    triggerKeywords: normalizeReviewTriggerKeywords(triggerKeywordSeed),
    processedEvents: {},
  };
}

export function parseReviewLog(
  raw: unknown,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewLog {
  const version = z.object({ schemaVersion: z.number() }).parse(raw);
  if (version.schemaVersion === 4) return ReviewLogSchema.parse(raw);

  if (
    version.schemaVersion === 1 ||
    version.schemaVersion === 2 ||
    version.schemaVersion === 3
  ) {
    const legacy = z
      .object({
        createdAt: z.string(),
        updatedAt: z.string(),
        triggerKeywords: TriggerKeywordsSchema.optional(),
        processedEvents: ProcessedEventsSchema.catch({}),
      })
      .parse(raw);
    return ReviewLogSchema.parse({
      schemaVersion: 4,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      triggerKeywords: normalizeReviewTriggerKeywords(
        legacy.triggerKeywords ?? triggerKeywordSeed,
      ),
      processedEvents: legacy.processedEvents,
    });
  }

  throw new Error(
    `unsupported review schema version: ${version.schemaVersion}`,
  );
}

export function readReviewLog(
  logPath: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewLog {
  return parseReviewLog(readJsonFile<unknown>(logPath), triggerKeywordSeed);
}

export function readReviewTriggerKeywords(
  logPath: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewTriggerKeywords {
  if (!fileExists(logPath)) {
    return normalizeReviewTriggerKeywords(triggerKeywordSeed);
  }
  return readReviewLog(logPath, triggerKeywordSeed).triggerKeywords;
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
