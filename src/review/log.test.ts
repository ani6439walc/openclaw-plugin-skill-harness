import { describe, expect, it } from "vitest";
import { migrateReviewLogV7, parseReviewLogV8 } from "./log.js";

describe("review log", () => {
  it("keeps a strict v8 audit contract", () => {
    expect(
      parseReviewLogV8({
        schemaVersion: 8,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
      }),
    ).toMatchObject({ schemaVersion: 8 });

    expect(() =>
      parseReviewLogV8({
        schemaVersion: 8,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
      }),
    ).toThrow();
  });

  it("migrates ordinary v7 events and drops historical keyword audits", () => {
    const migrated = migrateReviewLogV7({
      schemaVersion: 7,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["skill-candidate"],
          changeCount: 0,
          outcome: "nofinding",
        },
      },
      reviewedSkillEpochs: {},
      historicalKeywordAudits: {
        keyword: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["successful-pattern"],
          changeCount: 0,
          outcome: "nofinding",
        },
      },
    });

    expect(migrated).toEqual({
      schemaVersion: 8,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {
        event: expect.objectContaining({ triggers: ["capability-fit"] }),
      },
      reviewedSkillEpochs: {},
    });
  });

  it("drops invalid legacy processed events rather than rejecting the migration", () => {
    expect(
      migrateReviewLogV7({
        schemaVersion: 7,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {
          invalid: { processedAt: "not-a-record" },
        },
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
      }),
    ).toMatchObject({ schemaVersion: 8, processedEvents: {} });
  });
});
