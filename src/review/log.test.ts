import { describe, expect, it } from "vitest";
import { parseReviewLog } from "./log.js";

const relationChange = {
  trigger: "capability-fit",
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
    schemaVersion: 8,
    createdAt: "2026-06-11",
    updatedAt: "2026-06-11",
    processedEvents: {
      event: {
        processedAt: "2026-06-11",
        triggers: ["capability-fit"],
        changeCount: 1,
        outcome: "applied",
        changes: [change],
        ...receipt,
      },
    },
    reviewedSkillEpochs: {},
  };
}

describe("relation review audit", () => {
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
    "roundtrips relation %s without experience targets",
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

  it("retains a graph receipt after an aborted experience domain", () => {
    const raw = relationLog(relationChange, {
      outcome: "partially-applied",
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
      experienceOutcome: "aborted",
    });
    expect(parseReviewLog(raw)).toEqual(raw);
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
    { changedRelationCount: 1, relationOutcome: "applied" },
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
  it("keeps a strict v8 audit contract", () => {
    expect(
      parseReviewLog({
        schemaVersion: 8,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
      }),
    ).toMatchObject({ schemaVersion: 8 });

    expect(() =>
      parseReviewLog({
        schemaVersion: 8,
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
        schemaVersion: 8,
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

  it("accepts a reviewer-owned standalone delete operation", () => {
    const parsed = parseReviewLog({
      schemaVersion: 8,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["experience-health-check"],
          changeCount: 1,
          outcome: "applied",
          changes: [
            {
              trigger: "experience-health-check",
              targetKind: "skill-experience",
              operation: "delete",
              targetExperienceIds: ["obsolete"],
              dedupeKey: "obsolete-experience",
              summary: "Remove an obsolete experience.",
              evidence: ["The catalog has a durable duplicate boundary."],
              correctionGoal: "Remove the redundant runtime experience.",
              suggestedChange: "Delete obsolete experience.",
            },
          ],
        },
      },
      reviewedSkillEpochs: {},
    });

    expect(parsed.processedEvents.event?.changes?.[0]?.operation).toBe(
      "delete",
    );
  });

  it("requires complete and coherent stored merge metadata", () => {
    const change = {
      trigger: "experience-health-check",
      targetKind: "skill-experience",
      operation: "merge",
      sourceExperienceIds: ["obsolete"],
      retainedExperienceId: "retained",
      targetExperienceIds: ["obsolete", "retained"],
      dedupeKey: "merge-experience",
      summary: "Merge duplicate experiences.",
      evidence: ["The procedures overlap."],
      correctionGoal: "Keep one maintained workflow.",
      suggestedChange: "Retain one experience and remove the source.",
    };
    const logWith = (value: Record<string, unknown>) => ({
      schemaVersion: 8,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["experience-health-check"],
          changeCount: 1,
          outcome: "applied",
          changes: [value],
        },
      },
      reviewedSkillEpochs: {},
    });

    expect(parseReviewLog(logWith(change))).toBeDefined();
    for (const invalid of [
      (() => {
        const value = { ...change };
        delete (value as Partial<typeof change>).sourceExperienceIds;
        return value;
      })(),
      { ...change, sourceExperienceIds: ["obsolete", "obsolete"] },
      { ...change, retainedExperienceId: "obsolete" },
      { ...change, operation: "delete", sourceExperienceIds: ["obsolete"] },
    ]) {
      expect(() => parseReviewLog(logWith(invalid))).toThrow();
    }
  });
});

describe("historical review audit compatibility", () => {
  const legacyEvent = {
    processedAt: "2026-06-11T00:01:00.000Z",
    triggers: ["intent-health-check"],
    changeCount: 1,
    outcome: "applied",
    changedIntentIds: ["build"],
    changes: [
      {
        trigger: "intent-health-check",
        targetKind: "intent-markdown",
        operation: "merge",
        targetIntentIds: ["build", "test"],
        dedupeKey: "merge-build",
        summary: "Merge workflows",
        evidence: ["Same procedure"],
        correctionGoal: "Remove duplication",
        suggestedChange: "Merge entries",
      },
    ],
  };
  it("preserves legacy v8 intent audit entries and completed skill epochs", () => {
    const raw = {
      schemaVersion: 8,
      createdAt: "2026-06-11",
      updatedAt: "2026-06-11",
      processedEvents: { previous: legacyEvent },
      reviewedSkillEpochs: {
        ["a".repeat(64)]: {
          agentId: "main",
          skillName: "writer",
          source: "workspace",
          reason: "low-adoption",
          completedAt: "2026-06-11",
          outcome: "nofinding",
          eventId: "epoch",
        },
      },
    };
    expect(parseReviewLog(raw)).toEqual(raw);
    expect(
      parseReviewLog(JSON.parse(JSON.stringify(parseReviewLog(raw)))),
    ).toEqual(raw);
  });

  it("migrates v7 while retaining historical records", () => {
    const parsed = parseReviewLog({
      schemaVersion: 7,
      createdAt: "2026-06-11",
      updatedAt: "2026-06-11",
      processedEvents: { previous: legacyEvent },
    });
    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.processedEvents.previous).toEqual(legacyEvent);
    expect(parsed.reviewedSkillEpochs).toEqual({});
  });

  it("migrates historical v7 trigger aliases and placement epochs, dropping retired keyword audits", () => {
    const epochKey = "b".repeat(64);
    const epoch = {
      agentId: "main",
      skillName: "writer",
      source: "workspace",
      reason: "zero-recommendation-usage",
      completedAt: "2026-06-11",
      outcome: "nofinding",
      eventId: "previous",
    };
    const parsed = parseReviewLog({
      schemaVersion: 7,
      createdAt: "2026-06-11",
      updatedAt: "2026-06-11",
      processedEvents: {
        previous: {
          ...legacyEvent,
          triggers: ["skill-placement"],
          changes: [{ ...legacyEvent.changes[0], trigger: "skill-placement" }],
        },
        malformed: { processedAt: "not-a-record" },
      },
      reviewedSkillEpochs: { [epochKey]: epoch },
      historicalKeywordAudits: {
        keyword: { triggers: ["successful-pattern"] },
      },
    });
    expect(parsed.processedEvents.previous).toMatchObject({
      triggers: ["capability-fit"],
      changes: [
        { trigger: "capability-fit", targetIntentIds: ["build", "test"] },
      ],
    });
    expect(parsed.processedEvents).not.toHaveProperty("malformed");
    expect(parsed.reviewedSkillEpochs[epochKey]).toEqual({
      ...epoch,
      reason: "zero-intent-match-usage",
    });
    expect(parsed).not.toHaveProperty("historicalKeywordAudits");
  });

  it("preserves legacy experience records with their empty intent target array", () => {
    const event = {
      ...legacyEvent,
      changes: [
        {
          ...legacyEvent.changes[0],
          targetKind: "skill-experience",
          operation: "create",
          targetIntentIds: [],
          targetExperienceIds: ["exp-one"],
        },
      ],
    };
    expect(
      parseReviewLog({
        schemaVersion: 8,
        createdAt: "2026-06-11",
        updatedAt: "2026-06-11",
        processedEvents: { previous: event },
        reviewedSkillEpochs: {},
      }).processedEvents.previous,
    ).toEqual(event);
  });
});
