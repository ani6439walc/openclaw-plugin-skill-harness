import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createEvolutionLog,
  parseEvolutionLog,
  pruneProcessedEvents,
  readEvolutionLog,
  readEvolutionTriggerKeywords,
} from "./evolution-log.js";
import { DEFAULT_EVOLUTION_TRIGGER_KEYWORDS } from "./evolution-trigger-keywords.js";

const tempRoots: string[] = [];

function createTempLogPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-log-"));
  tempRoots.push(root);
  return path.join(root, "evolution.json");
}

function writeLogFixture(logPath: string, value: unknown): void {
  fs.writeFileSync(logPath, JSON.stringify(value));
}

describe("evolution log", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a v4 evolution log without pending items", () => {
    expect(createEvolutionLog("2026-06-11T00:00:00.000Z")).toEqual({
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
      processedEvents: {},
    });
  });

  it("migrates legacy v1-v3 files by keeping processedEvents and dropping items", () => {
    const migrated = parseEvolutionLog({
      schemaVersion: 3,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: { successfulPattern: ["done"] },
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["behavior_fix"],
          findingCount: 1,
          outcome: "wrote-items",
        },
      },
      items: [{ id: "legacy" }],
    });

    expect(migrated).toMatchObject({
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: { successfulPattern: ["done"] },
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["behavior-fix"],
          changeCount: 1,
          outcome: "applied",
        },
      },
    });
    expect(migrated).not.toHaveProperty("items");
  });

  it("parses structured processed event records", () => {
    const parsed = parseEvolutionLog({
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
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

  it("parses sanitized reason counts on processed events", () => {
    const parsed = parseEvolutionLog({
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["successful-pattern"],
          changeCount: 0,
          outcome: "nofinding",
          noFindingReasonCounts: {
            "routine-tool-use": 2,
            "wrong-trigger": 1,
            "raw user text should not survive": 99,
            "privacy-sensitive": 0,
          },
          schemaRejectionReasonCounts: {
            "missing-target": 2,
            "raw zod message should not survive": 99,
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
      },
    });
  });

  it("seeds legacy config keywords while migrating legacy logs", () => {
    const parsed = parseEvolutionLog(
      {
        schemaVersion: 2,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        items: [],
      },
      {
        behaviorFix: ["my correction"],
        successfulPattern: [],
        entityContext: ["看看"],
      },
    );

    expect(parsed.triggerKeywords).toEqual({
      behaviorFix: ["my correction"],
      successfulPattern: [],
      entityContext: ["看看"],
    });
  });

  it("parses and normalizes root trigger keyword fields", () => {
    const parsed = parseEvolutionLog({
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        successfulPattern: [" ship it ", ""],
        behaviorFix: [" try again ", "try again"],
        entityContext: [" 看一下 "],
      },
      processedEvents: {},
    });

    expect(parsed.triggerKeywords).toEqual({
      successfulPattern: ["ship it"],
      behaviorFix: ["try again"],
      entityContext: ["看一下"],
    });
  });

  it("reads default trigger keywords when evolution.json is absent", () => {
    const logPath = createTempLogPath();

    expect(readEvolutionTriggerKeywords(logPath)).toEqual(
      DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
    );
  });

  it("reads trigger keywords from an existing evolution log", () => {
    const logPath = createTempLogPath();
    writeLogFixture(logPath, {
      schemaVersion: 4,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: { behaviorFix: ["fix it"] },
      processedEvents: {},
    });

    expect(readEvolutionTriggerKeywords(logPath)).toMatchObject({
      behaviorFix: ["fix it"],
    });
  });

  it("reads evolution logs from disk", () => {
    const logPath = createTempLogPath();
    writeLogFixture(logPath, createEvolutionLog("2026-06-11T00:00:00.000Z"));

    expect(readEvolutionLog(logPath)).toMatchObject({ schemaVersion: 4 });
  });

  it("prunes old or corrupt processed event records", () => {
    const log = createEvolutionLog("2026-06-11T00:00:00.000Z");
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
