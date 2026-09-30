import { describe, expect, it } from "vitest";
import { parseReviewLog } from "./log.js";

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
