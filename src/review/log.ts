import { z } from "zod";
import type { ReviewSource } from "./types.js";
import { REVIEW_TRIGGER_TYPES } from "./triggers.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "../constants.js";
import { SKILL_SOURCE_ORDER, type SkillSource } from "../skills/types.js";
import type { SkillPlacementReason } from "../stats/aggregator.js";

export const REVIEW_OPERATIONS = [
  "create",
  "refine",
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

const STORED_REVIEW_TRIGGERS = [
  ...REVIEW_TRIGGER_TYPES,
  "intent-health-check",
] as const;
type StoredReviewTrigger = (typeof STORED_REVIEW_TRIGGERS)[number];

export type AppliedReviewChange = {
  trigger: StoredReviewTrigger;
  targetKind: "skill-experience";
  operation?: ReviewOperation;
  sourceExperienceIds?: string[];
  retainedExperienceId?: string;
  targetExperienceIds: string[];
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

// Historical intent edits remain audit data; they cannot become new review findings.
type LegacyReviewChange = Omit<
  AppliedReviewChange,
  "targetKind" | "operation" | "targetExperienceIds"
> & {
  targetKind: "intent-markdown" | "skill-experience";
  operation: ReviewOperation | "split" | "merge";
  targetIntentIds: string[];
  targetExperienceIds?: string[];
};

export type ProcessedEventRecord = {
  processedAt: string;
  source?: ReviewSource;
  triggers: StoredReviewTrigger[];
  changeCount: number;
  outcome: ProcessedEventOutcome;
  changes?: (AppliedReviewChange | LegacyReviewChange)[];
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

export type ReviewLog = {
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

const StoredExperienceIdSchema = z.string().trim().min(3).max(129);
const ExperienceChangeShape = {
  trigger: z.enum(STORED_REVIEW_TRIGGERS),
  targetKind: z.literal("skill-experience"),
  targetExperienceIds: z.array(StoredExperienceIdSchema).min(1),
  dedupeKey: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string()),
  correctionGoal: z.string().trim().min(1),
  suggestedChange: z.string().trim().min(1),
};

const UnclassifiedExperienceChangeSchema = z
  .object({
    ...ExperienceChangeShape,
    operation: z.undefined().optional(),
    sourceExperienceIds: z.never().optional(),
    retainedExperienceId: z.never().optional(),
  })
  .strict();
const ClassifiedExperienceChangeSchema = z
  .discriminatedUnion("operation", [
    z
      .object({
        ...ExperienceChangeShape,
        operation: z.enum(["create", "refine", "delete"]),
        sourceExperienceIds: z.never().optional(),
        retainedExperienceId: z.never().optional(),
      })
      .strict(),
    z
      .object({
        ...ExperienceChangeShape,
        operation: z.literal("merge"),
        sourceExperienceIds: z.array(StoredExperienceIdSchema).min(1).max(9),
        retainedExperienceId: StoredExperienceIdSchema,
      })
      .strict(),
  ])
  .superRefine((change, ctx) => {
    if (
      new Set(change.targetExperienceIds).size !==
      change.targetExperienceIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["targetExperienceIds"],
        message: "Duplicate targets",
      });
    }
    if (
      change.operation === "merge" &&
      (new Set(change.sourceExperienceIds).size !==
        change.sourceExperienceIds.length ||
        change.sourceExperienceIds.includes(change.retainedExperienceId))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceExperienceIds"],
        message:
          "Merge sources must be distinct from each other and the retained ID",
      });
    }
  });
const ExperienceChangeSchema = z.union([
  UnclassifiedExperienceChangeSchema,
  ClassifiedExperienceChangeSchema,
]);

const LegacyChangeSchema = z
  .object({
    ...ExperienceChangeShape,
    targetKind: z.enum(["intent-markdown", "skill-experience"]),
    operation: z.enum([...REVIEW_OPERATIONS, "split"]),
    targetIntentIds: z.array(z.string()),
    targetExperienceIds: z.array(StoredExperienceIdSchema).optional(),
    sourceExperienceIds: z
      .array(StoredExperienceIdSchema)
      .min(1)
      .max(9)
      .optional(),
    retainedExperienceId: StoredExperienceIdSchema.optional(),
  })
  .strict();

const ProcessedEventRecordSchema = z
  .object({
    processedAt: z.string(),
    source: ReviewSourceSchema.optional(),
    triggers: z.array(z.enum(STORED_REVIEW_TRIGGERS)),
    changeCount: z.number().int().nonnegative(),
    outcome: ProcessedEventOutcomeSchema,
    changes: z
      .array(z.union([ExperienceChangeSchema, LegacyChangeSchema]))
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
    reason: z.enum(["low-adoption", "zero-intent-match-usage"]),
    completedAt: z.string(),
    outcome: z.enum(["applied", "nofinding"]),
    eventId: z.string().trim().min(1),
  })
  .strict();

export const ReviewLogSchema = z
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
  .transform((log): ReviewLog => log);

export function createReviewLog(nowIso: string): ReviewLog {
  return {
    schemaVersion: 8,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    reviewedSkillEpochs: {},
  };
}

// These aliases existed in schema v7; they are accepted only during migration.
const LEGACY_TRIGGER_MAP: Record<string, StoredReviewTrigger> = {
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

export function parseReviewLog(raw: unknown): ReviewLog {
  if (
    raw &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    raw.schemaVersion === 7
  ) {
    const legacy = z
      .object({
        createdAt: z.string(),
        updatedAt: z.string(),
        processedEvents: z.record(
          z.string(),
          z.record(z.string(), z.unknown()),
        ),
        reviewedSkillEpochs: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .default({}),
      })
      .parse(raw);
    const mapTrigger = (trigger: unknown) =>
      typeof trigger === "string"
        ? (LEGACY_TRIGGER_MAP[trigger] ?? trigger)
        : trigger;
    const processedEvents: Record<string, ProcessedEventRecord> = {};
    for (const [eventId, record] of Object.entries(legacy.processedEvents)) {
      const parsed = ProcessedEventRecordSchema.safeParse({
        ...record,
        triggers: Array.isArray(record.triggers)
          ? [...new Set(record.triggers.map(mapTrigger))]
          : record.triggers,
        changes: Array.isArray(record.changes)
          ? record.changes.map((change) =>
              change && typeof change === "object" && "trigger" in change
                ? { ...change, trigger: mapTrigger(change.trigger) }
                : change,
            )
          : record.changes,
        noFindingReasonCounts: normalizedCounts(
          record.noFindingReasonCounts,
          NO_FINDING_REASON_CODES,
        ),
        schemaRejectionReasonCounts: normalizedCounts(
          record.schemaRejectionReasonCounts,
          SCHEMA_REJECTION_REASON_CODES,
        ),
      });
      if (parsed.success) processedEvents[eventId] = parsed.data;
    }
    return ReviewLogSchema.parse({
      schemaVersion: 8,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      processedEvents,
      reviewedSkillEpochs: Object.fromEntries(
        Object.entries(legacy.reviewedSkillEpochs).map(([key, epoch]) => [
          key,
          {
            ...epoch,
            reason:
              epoch.reason === "zero-recommendation-usage"
                ? "zero-intent-match-usage"
                : epoch.reason,
          },
        ]),
      ),
    });
  }
  return ReviewLogSchema.parse(raw);
}

export function pruneReviewLogEvents(
  log: ReviewLog,
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
