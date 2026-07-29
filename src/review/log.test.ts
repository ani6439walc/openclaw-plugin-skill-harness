import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReviewLog,
  parseReviewLog,
  pruneProcessedEvents,
  readReviewLog,
  readReviewTriggerKeywords,
} from "./log.js";
import { DEFAULT_REVIEW_TRIGGER_KEYWORDS } from "./trigger-keywords.js";

const tempRoots: string[] = [];

function createTempLogPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-log-"));
  tempRoots.push(root);
  return path.join(root, "review.json");
}

function writeLogFixture(logPath: string, value: unknown): void {
  fs.writeFileSync(logPath, JSON.stringify(value));
}

describe("review log", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a v5 review log with an empty skill epoch ledger", () => {
    expect(createReviewLog("2026-06-11T00:00:00.000Z")).toEqual({
      schemaVersion: 5,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_REVIEW_TRIGGER_KEYWORDS,
      processedEvents: {},
      reviewedSkillEpochs: {},
    });
  });

  it.each([1, 2, 3, 4])("rejects legacy v%s review logs", (schemaVersion) => {
    expect(() =>
      parseReviewLog({
        schemaVersion,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        triggerKeywords: DEFAULT_REVIEW_TRIGGER_KEYWORDS,
        processedEvents: {},
      }),
    ).toThrow();
  });

  it("parses structured processed event records", () => {
    const parsed = parseReviewLog({
      schemaVersion: 5,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_REVIEW_TRIGGER_KEYWORDS,
      reviewedSkillEpochs: {},
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          source: {
            sessionId: "session-1",
            sessionKey: "agent:main:direct:one",
            agentId: "main",
            turnStart: "2026-06-11T00:00:00.000Z",
          },
          triggers: ["behavior-fix", "entity-context"],
          changeCount: 1,
          outcome: "applied",
          changedIntentIds: ["coding"],
          changes: [
            {
              trigger: "behavior-fix",
              targetKind: "intent-markdown",
              operation: "refine",
              targetIntentIds: ["coding"],
              dedupeKey: "key",
              summary: "summary",
              evidence: ["evidence"],
              correctionGoal: "goal",
              suggestedChange: "changed coding.md",
            },
          ],
        },
      },
    });

    expect(parsed.processedEvents["session-1:turn-1"]).toMatchObject({
      triggers: ["behavior-fix", "entity-context"],
      changeCount: 1,
      outcome: "applied",
      changedIntentIds: ["coding"],
    });
  });

  it("parses allowlisted reason counts on processed events", () => {
    const parsed = parseReviewLog({
      schemaVersion: 5,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_REVIEW_TRIGGER_KEYWORDS,
      reviewedSkillEpochs: {},
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["successful-pattern"],
          changeCount: 0,
          outcome: "nofinding",
          noFindingReasonCounts: {
            "routine-tool-use": 2,
            "wrong-trigger": 1,
          },
          schemaRejectionReasonCounts: {
            "missing-target": 2,
            "missing-trigger-decision": 1,
          },
        },
      },
    });

    expect(parsed.processedEvents["session-1:turn-1"]).toMatchObject({
      noFindingReasonCounts: {
        "routine-tool-use": 2,
        "wrong-trigger": 1,
      },
      schemaRejectionReasonCounts: {
        "missing-target": 2,
        "missing-trigger-decision": 1,
      },
    });
  });

  it("rejects unknown legacy fields in v5 logs", () => {
    expect(() =>
      parseReviewLog({
        ...createReviewLog("2026-06-11T00:00:00.000Z"),
        items: [],
      }),
    ).toThrow();
  });

  it.each([
    {
      name: "wrong trigger keyword field type",
      mutate: (log: Record<string, unknown>) => {
        log.triggerKeywords = {
          ...DEFAULT_REVIEW_TRIGGER_KEYWORDS,
          successfulPattern: "ship it",
        };
      },
    },
    {
      name: "unknown processed record field",
      mutate: (log: Record<string, unknown>) => {
        log.processedEvents = {
          event: {
            processedAt: "2026-06-11T00:01:00.000Z",
            triggers: [],
            changeCount: 0,
            outcome: "nofinding",
            legacy: true,
          },
        };
      },
    },
    {
      name: "legacy string processed event",
      mutate: (log: Record<string, unknown>) => {
        log.processedEvents = { event: "2026-06-11T00:01:00.000Z" };
      },
    },
    ...["wrote-items", "unknown"].map((outcome) => ({
      name: `${outcome} outcome`,
      mutate: (log: Record<string, unknown>) => {
        log.processedEvents = {
          event: {
            processedAt: "2026-06-11T00:01:00.000Z",
            triggers: [],
            changeCount: 0,
            outcome,
          },
        };
      },
    })),
  ])("rejects $name in current v5 logs", ({ mutate }) => {
    const log = createReviewLog(
      "2026-06-11T00:00:00.000Z",
    ) as unknown as Record<string, unknown>;
    mutate(log);
    expect(() => parseReviewLog(log)).toThrow();
  });

  it("parses and normalizes root trigger keyword fields", () => {
    const parsed = parseReviewLog({
      schemaVersion: 5,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        successfulPattern: [" ship it ", ""],
        behaviorFix: [" try again ", "try again"],
        entityContext: [" 看一下 "],
      },
      processedEvents: {},
      reviewedSkillEpochs: {},
    });

    expect(parsed.triggerKeywords).toEqual({
      successfulPattern: ["ship it"],
      behaviorFix: ["try again"],
      entityContext: ["看一下"],
    });
  });

  it("reads default trigger keywords when review.json is absent", () => {
    const logPath = createTempLogPath();

    expect(readReviewTriggerKeywords(logPath)).toEqual(
      DEFAULT_REVIEW_TRIGGER_KEYWORDS,
    );
  });

  it("reads trigger keywords from an existing review log", () => {
    const logPath = createTempLogPath();
    writeLogFixture(logPath, {
      schemaVersion: 5,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        ...DEFAULT_REVIEW_TRIGGER_KEYWORDS,
        behaviorFix: ["fix it"],
      },
      processedEvents: {},
      reviewedSkillEpochs: {},
    });

    expect(readReviewTriggerKeywords(logPath)).toMatchObject({
      behaviorFix: ["fix it"],
    });
  });

  it("reads review logs from disk", () => {
    const logPath = createTempLogPath();
    writeLogFixture(logPath, createReviewLog("2026-06-11T00:00:00.000Z"));

    expect(readReviewLog(logPath)).toMatchObject({ schemaVersion: 5 });
  });

  it("prunes old or corrupt processed event records", () => {
    const log = createReviewLog("2026-06-11T00:00:00.000Z");
    log.processedEvents.old = {
      processedAt: "2026-01-01T00:00:00.000Z",
      triggers: [],
      changeCount: 0,
      outcome: "nofinding",
    };
    log.processedEvents.invalid = {
      processedAt: "not a date",
      triggers: [],
      changeCount: 0,
      outcome: "nofinding",
    };
    log.processedEvents.recent = {
      processedAt: "2026-06-10T00:00:00.000Z",
      triggers: [],
      changeCount: 0,
      outcome: "nofinding",
    };

    pruneProcessedEvents(log, Date.parse("2026-06-11T00:00:00.000Z"));

    expect(Object.keys(log.processedEvents)).toEqual(["recent"]);
  });
});
