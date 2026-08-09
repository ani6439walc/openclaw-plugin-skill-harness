import { describe, expect, it } from "vitest";
import {
  createKeywordCoverageLog,
  hashKeywordEventId,
  parseKeywordCoverageLog,
  pruneKeywordCoverageLog,
} from "./keyword-coverage-log.js";

describe("keyword coverage log", () => {
  it("creates a strict v1 log with normalized default keywords", () => {
    expect(createKeywordCoverageLog("2026-08-08T00:00:00.000Z")).toMatchObject({
      schemaVersion: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      processedKeywordEvents: {},
      targets: {},
      coverageEpochs: {},
      triggerKeywords: {
        successfulPattern: expect.any(Array),
        behaviorFix: expect.any(Array),
        entityContext: expect.any(Array),
      },
    });
  });

  it("uses a sha256 event key without persisting the raw event identifier", () => {
    const eventId = "session-123:2026-08-08T00:00:00.000Z";
    const hash = hashKeywordEventId(eventId);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(eventId);
  });

  it("rejects unknown top-level fields", () => {
    const log = createKeywordCoverageLog("2026-08-08T00:00:00.000Z");

    expect(() =>
      parseKeywordCoverageLog({ ...log, rawSessionId: "session-123" }),
    ).toThrow();
  });

  it("rejects raw epoch keys and invalid persisted timestamps", () => {
    const log = createKeywordCoverageLog("2026-08-08T00:00:00.000Z");

    expect(() =>
      parseKeywordCoverageLog({
        ...log,
        coverageEpochs: {
          "session-123": {
            reservedAt: "2026-08-08T00:00:00.000Z",
            targets: ["successful-pattern"],
            acceptedTurn: 50,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseKeywordCoverageLog({ ...log, createdAt: "not-a-date" }),
    ).toThrow();
  });

  it("prunes completed epoch metadata after thirty days without deleting pending work", () => {
    const log = createKeywordCoverageLog("2026-07-01T00:00:00.000Z");
    log.coverageEpochs["a".repeat(64)] = {
      reservedAt: "2026-07-01T00:00:00.000Z",
      targets: ["successful-pattern"],
      acceptedTurn: 50,
      outcome: "nofinding",
      completedAt: "2026-07-01T00:00:00.000Z",
    };
    log.coverageEpochs["b".repeat(64)] = {
      reservedAt: "2026-07-01T00:00:00.000Z",
      targets: ["behavior-fix"],
      acceptedTurn: 50,
    };
    log.processedKeywordEvents["c".repeat(64)] = {
      processedAt: "2026-07-01T00:00:00.000Z",
      targets: ["successful-pattern"],
      outcome: "nofinding",
      mutations: [],
    };
    log.processedKeywordEvents["d".repeat(64)] = {
      processedAt: "2026-08-01T00:00:00.000Z",
      targets: ["successful-pattern"],
      outcome: "nofinding",
      mutations: [],
    };

    pruneKeywordCoverageLog(log, Date.parse("2026-08-01T00:00:00.000Z"));

    expect(log.coverageEpochs).not.toHaveProperty("a".repeat(64));
    expect(log.coverageEpochs).toHaveProperty("b".repeat(64));
    expect(log.processedKeywordEvents).not.toHaveProperty("c".repeat(64));
    expect(log.processedKeywordEvents).toHaveProperty("d".repeat(64));
  });
});
