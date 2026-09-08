import { z } from "zod";
import type { ReviewSource } from "./types.js";
import { REVIEW_TRIGGER_TYPES, type ReviewTrigger } from "./triggers.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "../constants.js";
import { SKILL_SOURCE_ORDER, type SkillSource } from "../skills/types.js";
import type { SkillPlacementReason } from "../stats/aggregator.js";

export const REVIEW_OPERATIONS = [
  "create",
  "refine",
  "split",
  "merge",
  "delete",
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
  targetKind: "intent-markdown" | "skill-experience";
  operation: ReviewOperation;
  targetIntentIds: string[];
  targetExperienceIds?: string[];
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
  changedExperienceIds?: string[];
  validationErrors?: string[];
  noFindingReasonCounts?: NoFindingReasonCounts;
  schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
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

export type ReviewLogV8 = {
  schemaVersion: 8;
  createdAt: string;
  updatedAt: string;
  processedEvents: Record<string, ProcessedEventRecord>;
  reviewedSkillEpochs: Record<string, ReviewedSkillEpoch>;
};

const ReviewSourceSchema = z
  .object({
    sessionId: z.string(),
    sessionKey: z.string().optional(),
    agentId: z.string().optional(),
    turnStart: z.string(),
  })
  .strict();
const ProcessedEventOutcomeSchema = z.enum(PROCESSED_EVENT_OUTCOMES);

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function normalizedCounts<T extends string>(
  value: unknown,
  allowed: readonly T[],
): Partial<Record<T, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result: Partial<Record<T, number>> = {};
  for (const key of allowed) {
    const count = (value as Record<string, unknown>)[key];
    if (typeof count === "number" && Number.isInteger(count) && count > 0)
      result[key] = count;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
export function normalizeNoFindingReasonCounts(
  value: unknown,
): NoFindingReasonCounts | undefined {
  return normalizedCounts(value, NO_FINDING_REASON_CODES);
}

const PositiveCountsSchema = z.record(z.string(), z.number().int().positive());
const NoFindingReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, NO_FINDING_REASON_CODES),
).transform((value): NoFindingReasonCounts => value);
const SchemaRejectionReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, SCHEMA_REJECTION_REASON_CODES),
).transform((value): SchemaRejectionReasonCounts => value);
const IntentChangeSchema = z
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
const ExperienceChangeSchema = z
  .object({
    trigger: z.enum(REVIEW_TRIGGER_TYPES),
    targetKind: z.literal("skill-experience"),
    operation: z.literal("create"),
    targetIntentIds: z.array(z.string()).length(0),
    targetExperienceIds: z.array(z.string().trim().min(3)).length(1),
    dedupeKey: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    evidence: z.array(z.string()),
    correctionGoal: z.string().trim().min(1),
    suggestedChange: z.string().trim().min(1),
  })
  .strict();
const ProcessedEventRecordSchema = z
  .object({
    processedAt: z.string(),
    source: ReviewSourceSchema.optional(),
    triggers: z.array(z.enum(REVIEW_TRIGGER_TYPES)),
    changeCount: z.number().int().nonnegative(),
    outcome: ProcessedEventOutcomeSchema,
    changes: z
      .array(z.union([IntentChangeSchema, ExperienceChangeSchema]))
      .optional(),
    changedIntentIds: z.array(z.string()).optional(),
    changedExperienceIds: z.array(z.string()).optional(),
    validationErrors: z.array(z.string()).optional(),
    noFindingReasonCounts: NoFindingReasonCountsSchema.optional(),
    schemaRejectionReasonCounts: SchemaRejectionReasonCountsSchema.optional(),
  })
  .strict()
  .transform((record): ProcessedEventRecord => record);
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
export const ReviewLogV8Schema = z
  .object({
    schemaVersion: z.literal(8),
    createdAt: z.string(),
    updatedAt: z.string(),
    processedEvents: z.record(z.string(), ProcessedEventRecordSchema),
    reviewedSkillEpochs: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      ReviewedSkillEpochSchema,
    ),
  })
  .strict()
  .transform((log): ReviewLogV8 => log);

export function createReviewLogV8(nowIso: string): ReviewLogV8 {
  return {
    schemaVersion: 8,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    reviewedSkillEpochs: {},
  };
}

const legacyTriggerMap: Record<string, ReviewTrigger> = {
  "successful-pattern": "intent-health-check",
  "satisfaction-check": "intent-health-check",
  "behavior-fix": "intent-health-check",
  "entity-context": "intent-health-check",
  "missing-intent": "routing-uncertainty",
  "weak-intent": "routing-uncertainty",
  "skill-candidate": "capability-fit",
  "process-gap": "capability-fit",
  "skill-placement": "capability-fit",
};
function migrateLegacyTrigger(value: unknown): ReviewTrigger | undefined {
  return typeof value === "string"
    ? (legacyTriggerMap[value] ??
        (REVIEW_TRIGGER_TYPES.includes(value as ReviewTrigger)
          ? (value as ReviewTrigger)
          : undefined))
    : undefined;
}
function migrateLegacyRecord(value: unknown): ProcessedEventRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const triggers = Array.isArray(record.triggers)
    ? record.triggers
        .map(migrateLegacyTrigger)
        .filter((trigger): trigger is ReviewTrigger => Boolean(trigger))
    : [];
  if (
    !triggers.length ||
    typeof record.processedAt !== "string" ||
    typeof record.changeCount !== "number" ||
    !PROCESSED_EVENT_OUTCOMES.includes(record.outcome as ProcessedEventOutcome)
  )
    return;
  const next: ProcessedEventRecord = {
    processedAt: record.processedAt,
    triggers: [...new Set(triggers)],
    changeCount: record.changeCount,
    outcome: record.outcome as ProcessedEventOutcome,
  };
  if (
    record.source &&
    typeof record.source === "object" &&
    !Array.isArray(record.source)
  )
    next.source = record.source as ReviewSource;
  for (const field of [
    "changedIntentIds",
    "changedExperienceIds",
    "validationErrors",
  ] as const)
    if (
      Array.isArray(record[field]) &&
      record[field].every((item) => typeof item === "string")
    )
      next[field] = [...record[field]];
  next.noFindingReasonCounts = normalizedCounts(
    record.noFindingReasonCounts,
    NO_FINDING_REASON_CODES,
  );
  next.schemaRejectionReasonCounts = normalizedCounts(
    record.schemaRejectionReasonCounts,
    SCHEMA_REJECTION_REASON_CODES,
  );
  return next;
}
export function migrateReviewLogV7(raw: unknown): ReviewLogV8 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const log = raw as Record<string, unknown>;
  if (
    log.schemaVersion !== 7 ||
    typeof log.createdAt !== "string" ||
    typeof log.updatedAt !== "string" ||
    !log.processedEvents ||
    typeof log.processedEvents !== "object" ||
    Array.isArray(log.processedEvents) ||
    !log.reviewedSkillEpochs ||
    typeof log.reviewedSkillEpochs !== "object" ||
    Array.isArray(log.reviewedSkillEpochs)
  )
    return;
  const processedEvents: Record<string, ProcessedEventRecord> = {};
  for (const [eventId, record] of Object.entries(
    log.processedEvents as Record<string, unknown>,
  )) {
    const migrated = migrateLegacyRecord(record);
    if (migrated) processedEvents[eventId] = migrated;
  }
  const candidate = {
    schemaVersion: 8 as const,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    processedEvents,
    reviewedSkillEpochs: log.reviewedSkillEpochs,
  };
  return ReviewLogV8Schema.safeParse(candidate).data;
}
export function parseReviewLogV8(raw: unknown): ReviewLogV8 {
  return ReviewLogV8Schema.parse(raw);
}
export function pruneReviewLogV8Events(
  log: ReviewLogV8,
  nowMs: number = Date.now(),
): void {
  const oldestAcceptedTime = Math.min(
    ...Object.values(log.processedEvents).map((record) =>
      new Date(record.processedAt).getTime(),
    ),
  );
  const cutoff = Math.min(
    nowMs - PROCESSED_EVENTS_RETENTION_DAYS * 86_400_000,
    Number.isFinite(oldestAcceptedTime) ? oldestAcceptedTime : nowMs,
  );
  for (const eventId in log.processedEvents) {
    const eventTime = new Date(
      log.processedEvents[eventId]!.processedAt,
    ).getTime();
    if (Number.isNaN(eventTime) || eventTime < cutoff)
      delete log.processedEvents[eventId];
  }
}
