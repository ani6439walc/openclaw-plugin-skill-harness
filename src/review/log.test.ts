import { describe, expect, it } from "vitest";
import { parseReviewLog } from "./log.js";

const relationChange = {
  trigger: "relation-health-check",
  targetKind: "skill-relation",
  operation: "create",
  fromSkillId: "source:one/skill-one",
  toSkillId: "source:two/skill-two",
  relationType: "composes_with",
  reason: "The procedures share a useful handoff.",
  relationEvidence: [
    {
      skillId: "source:one/skill-one",
      filePath: "SKILL.md",
      startLine: 1,
      endLine: 2,
      quote: "First procedure",
    },
    {
      skillId: "source:two/skill-two",
      filePath: "SKILL.md",
      startLine: 3,
      endLine: 4,
      quote: "Second procedure",
    },
  ],
  dedupeKey: "relation-change",
  summary: "Preserve a useful relation",
  evidence: ["Both endpoint documents were read"],
  correctionGoal: "Connect complementary procedures",
  suggestedChange: "Create the declared relation",
};

function relationLog(
  change: unknown = relationChange,
  receipt: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 9,
    createdAt: "2026-06-11",
    updatedAt: "2026-06-11",
    processedEvents: {
      event: {
        processedAt: "2026-06-11",
        triggers: ["relation-health-check"],
        changeCount: 1,
        outcome: "applied",
        changes: [change],
        changedRelationCount: 1,
        relationOutcome: "applied",
        relationBatchId: "batch-1",
        ...receipt,
      },
    },
    reviewedSkillEpochs: {},
  };
}

describe("relation review audit", () => {
  it("preserves historical v9 triggers and no-finding reason counts", () => {
    const raw = relationLog(
      { ...relationChange, trigger: "capability-fit" },
      {
        triggers: ["routing-uncertainty", "capability-fit"],
        noFindingReasonCounts: { "routine-tool-use": 1 },
      },
    );
    expect(parseReviewLog(raw)).toEqual(raw);
  });
  it("rejects impossible inspection counts and unbounded cursors", () => {
    const preparation = {
      status: "ready",
      requestedSeeds: 1,
      capturedSeeds: 1,
      capturedExtras: 8,
      existingNeighborAttempts: 4,
      discoveryAttempts: 5,
      skippedCaptureCount: 1,
    };
    expect(() =>
      parseReviewLog(
        relationLog(relationChange, { relationPreparation: preparation }),
      ),
    ).toThrow();
    const raw = {
      ...relationLog(),
      relationInspectionCursors: Object.fromEntries(
        Array.from({ length: 257 }, (_, i) => [
          i.toString(16).padStart(64, "0"),
          { offset: 0, updatedAt: "2026-11-01T00:00:00.000Z" },
        ]),
      ),
    };
    expect(() => parseReviewLog(raw)).toThrow();
  });
  it("preserves exact excerpt whitespace for later source validation", () => {
    const change = {
      ...relationChange,
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        quote: `  ${entry.quote}\n`,
      })),
    };
    expect(
      parseReviewLog(relationLog(change)).processedEvents.event?.changes?.[0],
    ).toEqual(change);
  });
  it.each(["create", "update", "delete"])(
    "roundtrips a committed relation %s",
    (operation) => {
      const raw = relationLog({ ...relationChange, operation });
      expect(
        parseReviewLog(JSON.parse(JSON.stringify(parseReviewLog(raw)))),
      ).toEqual(raw);
    },
  );

  it("accepts deletion evidence without replacement type or reason", () => {
    const { reason: _reason, relationType: _type, ...change } = relationChange;
    expect(
      parseReviewLog(relationLog({ ...change, operation: "delete" })),
    ).toBeDefined();
  });

  it("accepts bounded Unicode evidence and reasons", () => {
    const change = {
      ...relationChange,
      fromSkillId: "f".repeat(1000),
      reason: "🌸".repeat(2000),
      relationEvidence: [
        {
          ...relationChange.relationEvidence[0],
          skillId: "f".repeat(1000),
          endLine: 200,
          quote: "🌸".repeat(2000),
        },
        relationChange.relationEvidence[1],
      ],
    };
    expect(
      parseReviewLog(relationLog(change)).processedEvents.event?.changes?.[0],
    ).toEqual(change);
  });

  it.each([
    { operation: "refine" },
    { operation: "create", relationType: undefined },
    { operation: "update", reason: undefined },
    { relationType: "invented" },
    { reason: " " },
    { reason: "🌸".repeat(2001) },
    { fromSkillId: "x".repeat(1001) },
    { toSkillId: relationChange.fromSkillId },
    { relationEvidence: relationChange.relationEvidence.slice(0, 1) },
    {
      relationEvidence: Array.from(
        { length: 17 },
        (_, i) => relationChange.relationEvidence[i % 2],
      ),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        skillId: relationChange.fromSkillId,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        filePath: "references/other.md",
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        startLine: 0,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        startLine: 1.5,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        quote: " ",
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry, index) => ({
        ...entry,
        skillId: index === 0 ? "unrelated" : entry.skillId,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        startLine: 5,
        endLine: 4,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        startLine: 1,
        endLine: 201,
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        quote: "🌸".repeat(2001),
      })),
    },
    {
      relationEvidence: relationChange.relationEvidence.map((entry) => ({
        ...entry,
        verification: "verified",
      })),
    },
    { targetExperienceIds: ["experience"] },
    { verification_status: "verified" },
    { confidence: 0.9 },
  ])("rejects malformed relation fields %#", (override) => {
    expect(() =>
      parseReviewLog(relationLog({ ...relationChange, ...override })),
    ).toThrow();
  });

  it.each([
    { changedRelationCount: -1 },
    {
      changedRelationCount: 0,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
    },
    {
      changedRelationCount: 2,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
    },
    {
      changedRelationCount: 1,
      relationBatchId: undefined,
      relationOutcome: "applied",
    },
    {
      changedRelationCount: 1,
      relationBatchId: "",
      relationOutcome: "applied",
    },
    {
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "validation-failed",
    },
    {
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
      experienceOutcome: "aborted",
    },
    { partialExperienceIds: ["incomplete"], experienceOutcome: "applied" },
    {
      outcome: "validation-failed",
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
    },
    {
      outcome: "partially-applied",
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
    },
  ])("rejects inconsistent application receipt %#", (receipt) => {
    expect(() =>
      parseReviewLog(relationLog(relationChange, receipt)),
    ).toThrow();
  });
});

describe("review log", () => {
  it("keeps a strict v9 audit contract", () => {
    expect(
      parseReviewLog({
        schemaVersion: 9,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
      }),
    ).toMatchObject({ schemaVersion: 9 });

    expect(() =>
      parseReviewLog({
        schemaVersion: 9,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
      }),
    ).toThrow();
  });

  it("rejects retired native skill epochs", () => {
    expect(() =>
      parseReviewLog({
        schemaVersion: 9,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {
          ["a".repeat(64)]: {
            agentId: "main",
            skillName: "skill-harness",
            source: "native",
            reason: "low-adoption",
            completedAt: "2026-06-11T00:00:00.000Z",
            outcome: "nofinding",
            eventId: "event",
          },
        },
      }),
    ).toThrow();
  });

  it.each([7, 8, 10])("rejects unsupported log version %i", (schemaVersion) => {
    expect(() => parseReviewLog({ ...relationLog(), schemaVersion })).toThrow();
  });

  it.each(["experience-health-check", "intent-health-check"])(
    "rejects retired trigger %s",
    (trigger) => {
      expect(() =>
        parseReviewLog(relationLog({ ...relationChange, trigger })),
      ).toThrow();
      expect(() =>
        parseReviewLog(relationLog(relationChange, { triggers: [trigger] })),
      ).toThrow();
    },
  );
});
