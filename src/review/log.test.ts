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
