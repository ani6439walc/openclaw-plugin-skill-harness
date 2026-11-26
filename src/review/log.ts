import { z } from "zod";
import type { RelationPreparationSummary } from "./relations.js";
import type { RelationReviewAssessment } from "./types.js";
import type {
  ReviewDomainOutcome,
  ReviewSource,
  SkillRelationReviewFinding,
} from "./types.js";
import { REVIEW_TRIGGER } from "./triggers.js";
import { PROCESSED_EVENTS_RETENTION_DAYS } from "../constants.js";
import { SKILL_SOURCE_ORDER, type SkillSource } from "../skills/types.js";
import { relationTypes } from "../skills/relation-graph.js";
export type SkillPlacementReason = "low-adoption" | "zero-intent-match-usage";

export const PROCESSED_EVENT_OUTCOMES = [
  "skipped",
  "applied",
  "nofinding",
  "schema-rejected",
  "parse-failed",
  "subagent-error",
  "validation-failed",
] as const;
export type ProcessedEventOutcome = (typeof PROCESSED_EVENT_OUTCOMES)[number];

export const NO_FINDING_REASON_CODES = [
  "insufficient-evidence",
  "already-covered",
  "privacy-sensitive",
] as const;
export type NoFindingReasonCode = (typeof NO_FINDING_REASON_CODES)[number];
export type NoFindingReasonCounts = Partial<
  Record<NoFindingReasonCode, number>
>;
const STORED_NO_FINDING_REASON_CODES = [
  ...NO_FINDING_REASON_CODES,
  "routine-tool-use",
  "outside-intent-scope",
  "wrong-trigger",
] as const;
type StoredNoFindingReasonCounts = Partial<
  Record<(typeof STORED_NO_FINDING_REASON_CODES)[number], number>
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

// Historical schema-v9 receipts keep their original trigger on reads and rewrites.
const StoredTriggerSchema = z.enum([
  REVIEW_TRIGGER,
  "routing-uncertainty",
  "capability-fit",
]);
type StoredTrigger = z.infer<typeof StoredTriggerSchema>;
type StoredRelationChange = Omit<SkillRelationReviewFinding, "trigger"> & {
  trigger: StoredTrigger;
};

export type ProcessedEventRecord = {
  processedAt: string;
  source?: ReviewSource;
  triggers: StoredTrigger[];
  changeCount: number;
  outcome: ProcessedEventOutcome;
  changes?: StoredRelationChange[];
  changedRelationCount?: number;
  relationBatchId?: string;
  relationOutcome?: ReviewDomainOutcome;
  validationErrors?: string[];
  noFindingReasonCounts?: StoredNoFindingReasonCounts;
  schemaRejectionReasonCounts?: SchemaRejectionReasonCounts;
  relationPreparation?: RelationPreparationSummary;
  relationReview?: RelationReviewAssessment;
  relationSearchCount?: number;
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
  schemaVersion: 9;
  createdAt: string;
  updatedAt: string;
  processedEvents: Record<string, ProcessedEventRecord>;
  reviewedSkillEpochs: Record<string, ReviewedSkillEpoch>;
  relationInspectionCursors?: Record<
    string,
    { offset: number; updatedAt: string }
  >;
};

export const MAX_RELATION_INSPECTION_CURSORS = 256;
const InspectionCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const RelationPreparationSchema = z
  .object({
    status: z.enum(["ready", "skipped"]),
    reason: z
      .enum([
        "no-seeds",
        "registry-unavailable",
        "no-eligible-seeds",
        "preparation-failed",
        "no-data-root",
      ])
      .optional(),
    requestedSeeds: InspectionCountSchema,
    capturedSeeds: InspectionCountSchema,
    capturedExtras: InspectionCountSchema.max(8),
    existingNeighborAttempts: InspectionCountSchema.max(4),
    discoveryAttempts: InspectionCountSchema.max(8),
    skippedCaptureCount: InspectionCountSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "skipped") !== (value.reason !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Skipped preparations require a reason",
      });
    if (value.existingNeighborAttempts + value.discoveryAttempts > 8)
      ctx.addIssue({
        code: "custom",
        path: ["discoveryAttempts"],
        message: "Extra attempt budget exceeded",
      });
    if (value.capturedSeeds > value.requestedSeeds)
      ctx.addIssue({
        code: "custom",
        path: ["capturedSeeds"],
        message: "Captured seeds exceed requested seeds",
      });
  });
export const RelationReviewAssessmentSchema = z
  .object({
    existing: z.enum(["changes-proposed", "no-change", "not-applicable"]),
    discovery: z.enum(["changes-proposed", "no-change", "not-applicable"]),
  })
  .strict();

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
const PositiveCountsSchema = z.record(z.string(), z.number().int().positive());
const NoFindingReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, STORED_NO_FINDING_REASON_CODES),
).transform((value): StoredNoFindingReasonCounts => value);
const SchemaRejectionReasonCountsSchema = PositiveCountsSchema.refine((value) =>
  hasOnlyKeys(value, SCHEMA_REJECTION_REASON_CODES),
).transform((value): SchemaRejectionReasonCounts => value);

const StableSkillIdSchema = z.string().trim().min(1).max(1000);
const BoundedRelationTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= 2000, {
    message: "Relation text exceeds the code point limit",
  });
const RelationEvidenceSchema = z
  .object({
    skillId: StableSkillIdSchema,
    filePath: z.literal("SKILL.md"),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z
      .string()
      .refine((value) => value.trim().length > 0 && [...value].length <= 2000, {
        message: "Evidence quote must be nonempty and bounded",
      }),
  })
  .strict()
  .refine(
    (entry) =>
      entry.endLine >= entry.startLine && entry.endLine - entry.startLine < 200,
    { path: ["endLine"], message: "Invalid evidence line span" },
  );

// Shared by model output validation and the persisted Review audit.
export const RelationChangeFieldsSchema = z
  .object({
    targetKind: z.literal("skill-relation"),
    operation: z.enum(["create", "update", "delete"]),
    fromSkillId: StableSkillIdSchema,
    toSkillId: StableSkillIdSchema,
    relationType: z.enum(relationTypes).optional(),
    reason: BoundedRelationTextSchema.optional(),
    relationEvidence: z.array(RelationEvidenceSchema).min(2).max(16),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (change.fromSkillId === change.toSkillId) {
      ctx.addIssue({
        code: "custom",
        path: ["toSkillId"],
        message: "Self relation",
      });
    }
    if (change.operation !== "delete") {
      for (const field of ["relationType", "reason"] as const) {
        if (change[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Required for relation mutation",
          });
        }
      }
    }
    const endpoints = new Set([change.fromSkillId, change.toSkillId]);
    const covered = new Set<string>();
    for (const [index, entry] of change.relationEvidence.entries()) {
      if (!endpoints.has(entry.skillId)) {
        ctx.addIssue({
          code: "custom",
          path: ["relationEvidence", index, "skillId"],
          message: "Evidence must describe an endpoint",
        });
      }
      covered.add(entry.skillId);
    }
    if ([...endpoints].some((id) => !covered.has(id))) {
      ctx.addIssue({
        code: "custom",
        path: ["relationEvidence"],
        message: "Both endpoints require evidence",
      });
    }
  });

export const StoredRelationChangeSchema = RelationChangeFieldsSchema.safeExtend(
  {
    trigger: StoredTriggerSchema,
    dedupeKey: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    evidence: z.array(z.string().trim().min(1).max(1000)).max(10),
    correctionGoal: z.string().trim().min(1).max(1000),
    suggestedChange: z.string().trim().min(1).max(12000),
  },
);

const ProcessedEventRecordSchema = z
  .object({
    processedAt: z.string(),
    source: ReviewSourceSchema.optional(),
    triggers: z.array(StoredTriggerSchema),
    changeCount: z.number().int().nonnegative(),
    outcome: ProcessedEventOutcomeSchema,
    changes: z.array(StoredRelationChangeSchema).optional(),
    changedRelationCount: z.number().int().nonnegative().optional(),
    relationBatchId: z.string().trim().min(1).max(1000).optional(),
    relationOutcome: z
      .enum(["applied", "validation-failed", "aborted"])
      .optional(),
    validationErrors: z.array(z.string()).optional(),
    noFindingReasonCounts: NoFindingReasonCountsSchema.optional(),
    schemaRejectionReasonCounts: SchemaRejectionReasonCountsSchema.optional(),
    relationPreparation: RelationPreparationSchema.optional(),
    relationReview: RelationReviewAssessmentSchema.optional(),
    relationSearchCount: InspectionCountSchema.max(4).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (
      (record.outcome === "skipped") !==
      (record.relationPreparation?.status === "skipped")
    ) {
      issue(
        "outcome",
        "Skipped outcomes and skipped preparations must occur together",
      );
    }
    if (record.changeCount !== (record.changes?.length ?? 0)) {
      issue("changeCount", "Receipt change count must match applied findings");
    }
    if (record.changedRelationCount !== undefined) {
      if (record.changedRelationCount !== record.changeCount) {
        issue(
          "changedRelationCount",
          "Relation count must match applied findings",
        );
      }
      if (record.changedRelationCount > 0) {
        if (!record.relationBatchId)
          issue(
            "relationBatchId",
            "Committed relations require a batch receipt",
          );
        if (record.relationOutcome !== "applied")
          issue(
            "relationOutcome",
            "Committed relation batches must be applied",
          );
      } else if (record.relationBatchId !== undefined) {
        issue(
          "relationBatchId",
          "Empty relation batch cannot have a commit receipt",
        );
      }
    } else if (record.relationBatchId !== undefined || record.changeCount > 0) {
      issue("changedRelationCount", "Relation receipt requires a count");
    }
    if (record.changeCount > 0 !== (record.outcome === "applied")) {
      issue("outcome", "Applied outcome requires committed relation changes");
    }
    if (record.relationOutcome === "applied" && record.changeCount === 0) {
      issue(
        "relationOutcome",
        "Applied relation outcome requires a committed batch",
      );
    }
  })
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
    schemaVersion: z.literal(9),
    createdAt: z.string(),
    updatedAt: z.string(),
    processedEvents: z.record(z.string(), ProcessedEventRecordSchema),
    reviewedSkillEpochs: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      ReviewedSkillEpochSchema,
    ),
    relationInspectionCursors: z
      .record(
        z.string().regex(/^[a-f0-9]{64}$/),
        z
          .object({
            offset: InspectionCountSchema,
            updatedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .refine(
        (entries) =>
          Object.keys(entries).length <= MAX_RELATION_INSPECTION_CURSORS,
      )
      .optional(),
  })
  .strict()
  .transform((log): ReviewLog => log);

export function createReviewLog(nowIso: string): ReviewLog {
  return {
    schemaVersion: 9,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    reviewedSkillEpochs: {},
  };
}

export function parseReviewLog(raw: unknown): ReviewLog {
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
