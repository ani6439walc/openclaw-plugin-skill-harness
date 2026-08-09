import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKeywordCoverageLog } from "./keyword-coverage-log.js";
import { createReviewLog, parseReviewLogV6 } from "./log.js";
import { migrateKeywordStateOnce } from "./keyword-state-migration.js";

const tempRoots: string[] = [];

function createPaths(): { reviewPath: string; keywordCoveragePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-migration-"));
  tempRoots.push(root);
  return {
    reviewPath: path.join(root, "review.json"),
    keywordCoveragePath: path.join(root, "keyword-coverage.json"),
  };
}

function writeV5(reviewPath: string): string {
  const review = createReviewLog("2026-08-09T00:00:00.000Z");
  review.triggerKeywords = {
    successfulPattern: [" ship it ", "ship it"],
    behaviorFix: ["fix it"],
    entityContext: ["remember this"],
  };
  review.processedEvents.event = {
    processedAt: "2026-08-09T00:00:00.000Z",
    triggers: ["skill-candidate"],
    changeCount: 0,
    outcome: "nofinding",
  };
  const raw = JSON.stringify(review);
  fs.writeFileSync(reviewPath, raw);
  return raw;
}

describe("keyword state migration", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("moves only v5 keyword arrays into coverage state and preserves review audit data as v6", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    const rawV5 = writeV5(reviewPath);

    await expect(
      migrateKeywordStateOnce({
        reviewPath,
        keywordCoveragePath,
        nowMs: Date.parse("2026-08-09T00:01:00.000Z"),
      }),
    ).resolves.toEqual({ status: "migrated" });

    const coverage = parseKeywordCoverageLog(
      JSON.parse(fs.readFileSync(keywordCoveragePath, "utf8")),
    );
    expect(coverage.triggerKeywords).toEqual({
      successfulPattern: ["ship it"],
      behaviorFix: ["fix it"],
      entityContext: ["remember this"],
    });
    expect(coverage.migration).toEqual({
      sourceReviewSha256: createHash("sha256").update(rawV5).digest("hex"),
      completedAt: "2026-08-09T00:01:00.000Z",
    });

    const review = parseReviewLogV6(
      JSON.parse(fs.readFileSync(reviewPath, "utf8")),
    );
    expect(review.processedEvents).toEqual({
      event: {
        processedAt: "2026-08-09T00:00:00.000Z",
        triggers: ["skill-candidate"],
        changeCount: 0,
        outcome: "nofinding",
      },
    });
    expect(review.reviewedSkillEpochs).toEqual({});
    expect(review.historicalKeywordAudits).toEqual({});
  });

  it("recovers only when the pending coverage marker still matches unchanged v5 bytes", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    const rawV5 = writeV5(reviewPath);
    fs.writeFileSync(
      keywordCoveragePath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-09T00:01:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        triggerKeywords: {
          successfulPattern: ["ship it"],
          behaviorFix: ["fix it"],
          entityContext: ["remember this"],
        },
        processedKeywordEvents: {},
        targets: {},
        coverageEpochs: {},
        migration: {
          sourceReviewSha256: createHash("sha256").update(rawV5).digest("hex"),
        },
      }),
    );

    await expect(
      migrateKeywordStateOnce({
        reviewPath,
        keywordCoveragePath,
        nowMs: Date.parse("2026-08-09T00:02:00.000Z"),
      }),
    ).resolves.toEqual({ status: "recovered" });
    expect(
      parseKeywordCoverageLog(
        JSON.parse(fs.readFileSync(keywordCoveragePath, "utf8")),
      ).migration?.completedAt,
    ).toBe("2026-08-09T00:02:00.000Z");
    expect(() =>
      parseReviewLogV6(JSON.parse(fs.readFileSync(reviewPath, "utf8"))),
    ).not.toThrow();
  });

  it("refuses recovery after v5 source drift and leaves it untouched", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    writeV5(reviewPath);
    const drifted = `${fs.readFileSync(reviewPath, "utf8")}\n`;
    fs.writeFileSync(reviewPath, drifted);
    fs.writeFileSync(
      keywordCoveragePath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-09T00:01:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        triggerKeywords: {
          successfulPattern: ["ship it"],
          behaviorFix: ["fix it"],
          entityContext: ["remember this"],
        },
        processedKeywordEvents: {},
        targets: {},
        coverageEpochs: {},
        migration: { sourceReviewSha256: "a".repeat(64) },
      }),
    );

    await expect(
      migrateKeywordStateOnce({ reviewPath, keywordCoveragePath }),
    ).resolves.toEqual({ status: "failed" });
    expect(fs.readFileSync(reviewPath, "utf8")).toBe(drifted);
  });

  it("partitions keyword-bearing v5 records into historical audits and keeps intent records mutable", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    const review = createReviewLog("2026-08-09T00:00:00.000Z");
    review.triggerKeywords = {
      successfulPattern: ["ship it"],
      behaviorFix: ["fix it"],
      entityContext: ["remember this"],
    };
    review.processedEvents["intent-event"] = {
      processedAt: "2026-08-09T00:00:00.000Z",
      triggers: ["skill-candidate"],
      changeCount: 0,
      outcome: "nofinding",
    };
    review.processedEvents["keyword-event"] = {
      processedAt: "2026-08-09T00:00:00.000Z",
      triggers: ["successful-pattern"],
      changeCount: 1,
      outcome: "applied",
      changes: [
        {
          trigger: "successful-pattern",
          targetKind: "trigger-keywords",
          operation: "adjust-trigger-keywords",
          targetIntentIds: [],
          targetTrigger: "successful-pattern",
          keywordChange: { add: ["ship it"], remove: [] },
          dedupeKey: "keyword-change",
          summary: "keyword change",
          evidence: ["evidence"],
          correctionGoal: "goal",
          suggestedChange: "change keyword",
        },
      ],
    };
    fs.writeFileSync(reviewPath, JSON.stringify(review));

    await expect(
      migrateKeywordStateOnce({
        reviewPath,
        keywordCoveragePath,
        nowMs: Date.parse("2026-08-09T00:01:00.000Z"),
      }),
    ).resolves.toEqual({ status: "migrated" });

    const migrated = parseReviewLogV6(
      JSON.parse(fs.readFileSync(reviewPath, "utf8")),
    );
    expect(Object.keys(migrated.processedEvents)).toEqual(["intent-event"]);
    expect(Object.keys(migrated.historicalKeywordAudits)).toEqual([
      "keyword-event",
    ]);
    expect(migrated.historicalKeywordAudits["keyword-event"]).toMatchObject({
      triggers: ["successful-pattern"],
      changes: [{ targetKind: "trigger-keywords" }],
    });
  });

  it("returns not-needed and leaves files untouched when valid coverage and v6 review already exist", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    const review = createReviewLog("2026-08-09T00:00:00.000Z");
    review.processedEvents.event = {
      processedAt: "2026-08-09T00:00:00.000Z",
      triggers: ["skill-candidate"],
      changeCount: 0,
      outcome: "nofinding",
    };
    const v6 = {
      schemaVersion: 6,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      processedEvents: review.processedEvents,
      reviewedSkillEpochs: review.reviewedSkillEpochs,
      historicalKeywordAudits: {},
    };
    fs.writeFileSync(reviewPath, JSON.stringify(v6));
    fs.writeFileSync(
      keywordCoveragePath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        triggerKeywords: {
          successfulPattern: ["ship it"],
          behaviorFix: ["fix it"],
          entityContext: ["remember this"],
        },
        processedKeywordEvents: {},
        targets: {},
        coverageEpochs: {},
        migration: {
          sourceReviewSha256: "a".repeat(64),
          completedAt: "2026-08-09T00:00:00.000Z",
        },
      }),
    );
    const beforeReview = fs.readFileSync(reviewPath, "utf8");
    const beforeCoverage = fs.readFileSync(keywordCoveragePath, "utf8");

    await expect(
      migrateKeywordStateOnce({ reviewPath, keywordCoveragePath }),
    ).resolves.toEqual({ status: "not-needed" });

    expect(fs.readFileSync(reviewPath, "utf8")).toBe(beforeReview);
    expect(fs.readFileSync(keywordCoveragePath, "utf8")).toBe(beforeCoverage);
  });

  it("refuses recovery when raw v5 bytes differ by whitespace even with a valid pending marker", async () => {
    const { reviewPath, keywordCoveragePath } = createPaths();
    const rawV5 = writeV5(reviewPath);
    const sha = createHash("sha256").update(rawV5).digest("hex");
    fs.writeFileSync(
      keywordCoveragePath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-08-09T00:01:00.000Z",
        updatedAt: "2026-08-09T00:01:00.000Z",
        triggerKeywords: {
          successfulPattern: ["ship it"],
          behaviorFix: ["fix it"],
          entityContext: ["remember this"],
        },
        processedKeywordEvents: {},
        targets: {},
        coverageEpochs: {},
        migration: { sourceReviewSha256: sha },
      }),
    );
    const drifted = `${rawV5}\n`;
    fs.writeFileSync(reviewPath, drifted);

    await expect(
      migrateKeywordStateOnce({ reviewPath, keywordCoveragePath }),
    ).resolves.toEqual({ status: "failed" });

    expect(fs.readFileSync(reviewPath, "utf8")).toBe(drifted);
    expect(
      JSON.parse(fs.readFileSync(keywordCoveragePath, "utf8")).migration,
    ).toEqual({ sourceReviewSha256: sha });
  });
});
