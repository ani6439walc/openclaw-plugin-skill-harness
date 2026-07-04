import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBacklog,
  markPendingProcessed,
  parseBacklog,
  pruneProcessedEvents,
  readBacklog,
  readEvolutionTriggerKeywords,
  selectPendingItem,
  updatePendingTarget,
  type BacklogItem,
} from "./evolution-backlog.js";
import { DEFAULT_EVOLUTION_TRIGGER_KEYWORDS } from "./evolution-trigger-keywords.js";

const tempRoots: string[] = [];

function createTempBacklogPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-backlog-"));
  tempRoots.push(root);
  return path.join(root, "evolution.json");
}

function writeBacklogFixture(backlogPath: string, value: unknown): void {
  fs.writeFileSync(backlogPath, JSON.stringify(value));
}

const item = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: "IMP-1",
  type: "behavior-fix",
  targetKind: "intent-markdown",
  operation: "unknown",
  targetIntentIds: [],
  dedupeKey: "key",
  summary: "summary",
  correctionGoal: "goal",
  details: { evidence: [], suggestedChange: "change" },
  frequency: 1,
  sources: [],
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
  status: "pending",
  ...overrides,
});

const backlog = () =>
  parseBacklog({
    schemaVersion: 3,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
    processedEvents: {},
    items: [],
  });

describe("evolution backlog", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates v1 items with unknown operation and empty targets", () => {
    const migrated = parseBacklog({
      schemaVersion: 1,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: { event: "time" },
      items: [item({ operation: undefined, targetIntentIds: undefined })],
    });

    expect(migrated).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
      processedEvents: {
        event: {
          processedAt: "time",
          triggers: [],
          findingCount: 0,
          outcome: "unknown",
        },
      },
      items: [
        {
          targetKind: "intent-markdown",
          operation: "unknown",
          targetIntentIds: [],
        },
      ],
    });
  });

  it("parses structured processed event observability records", () => {
    const parsed = parseBacklog({
      schemaVersion: 3,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["behavior-fix", "entity-context"],
          findingCount: 0,
          outcome: "parse-failed",
        },
      },
      items: [],
    });

    expect(parsed.processedEvents["session-1:turn-1"]).toEqual({
      processedAt: "2026-06-11T00:01:00.000Z",
      triggers: ["behavior-fix", "entity-context"],
      findingCount: 0,
      outcome: "parse-failed",
    });
  });

  it("normalizes legacy underscore trigger types to hyphenated names", () => {
    const parsed = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {},
      items: [
        item({ id: "legacy", type: "successful_pattern" }),
        item({ id: "current", type: "behavior-fix" }),
      ],
    });

    expect(parsed.items.map((value) => value.type)).toEqual([
      "successful-pattern",
      "behavior-fix",
    ]);
  });

  it("migrates v2 backlogs with default runtime trigger keywords", () => {
    const parsed = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {},
      items: [item({ targetKind: undefined })],
    });

    expect(parsed).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
      items: [{ targetKind: "intent-markdown" }],
    });
  });

  it("seeds legacy config keywords while migrating v2 backlogs", () => {
    const parsed = parseBacklog(
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

  it("parses trigger keyword backlog items and root keyword fields", () => {
    const parsed = parseBacklog({
      schemaVersion: 3,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        successfulPattern: [" ship it ", ""],
        behaviorFix: [" try again ", "try again"],
        entityContext: [" 看一下 "],
      },
      processedEvents: {},
      items: [
        item({
          targetKind: "trigger-keywords",
          operation: "adjust-trigger-keywords",
          targetIntentIds: [],
          targetTrigger: "successful-pattern",
          keywordChange: { add: ["ship it"], remove: [] },
        }),
        item({
          id: "entity-keyword",
          type: "entity-context",
          targetKind: "trigger-keywords",
          operation: "adjust-trigger-keywords",
          targetIntentIds: [],
          targetTrigger: "entity-context",
          keywordChange: { add: ["看下"], remove: [] },
        }),
      ],
    });

    expect(parsed.triggerKeywords).toEqual({
      successfulPattern: ["ship it"],
      behaviorFix: ["try again"],
      entityContext: ["看一下"],
    });
    expect(parsed.items[0]).toMatchObject({
      targetKind: "trigger-keywords",
      operation: "adjust-trigger-keywords",
      targetTrigger: "successful-pattern",
      keywordChange: { add: ["ship it"], remove: [] },
    });
    expect(parsed.items[1]).toMatchObject({
      type: "entity-context",
      targetKind: "trigger-keywords",
      operation: "adjust-trigger-keywords",
      targetTrigger: "entity-context",
      keywordChange: { add: ["看下"], remove: [] },
    });
  });

  it("creates new backlogs with default trigger keywords", () => {
    expect(createBacklog("now")).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
    });
  });

  it("creates new backlogs with legacy config keyword seeds", () => {
    expect(
      createBacklog("now", {
        behaviorFix: [],
        successfulPattern: ["ship it"],
        entityContext: ["看下"],
      }),
    ).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: {
        behaviorFix: [],
        successfulPattern: ["ship it"],
        entityContext: ["看下"],
      },
    });
  });

  it("reads seeded trigger keywords when the backlog file is absent", () => {
    const backlogPath = createTempBacklogPath();

    expect(
      readEvolutionTriggerKeywords(backlogPath, {
        successfulPattern: ["ship it"],
        entityContext: ["看一下"],
      }),
    ).toEqual({
      behaviorFix: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS.behaviorFix,
      successfulPattern: ["ship it"],
      entityContext: ["看一下"],
    });
  });

  it("reads normalized trigger keywords from v3 backlog files", () => {
    const backlogPath = createTempBacklogPath();
    writeBacklogFixture(backlogPath, {
      schemaVersion: 3,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        behaviorFix: [" try again ", "TRY AGAIN"],
        successfulPattern: [" ship it "],
        entityContext: [" 看下 "],
      },
      processedEvents: {},
      items: [],
    });

    expect(readEvolutionTriggerKeywords(backlogPath)).toEqual({
      behaviorFix: ["TRY AGAIN"],
      successfulPattern: ["ship it"],
      entityContext: ["看下"],
    });
  });

  it("uses seed keywords while reading and migrating legacy backlog files", () => {
    const backlogPath = createTempBacklogPath();
    writeBacklogFixture(backlogPath, {
      schemaVersion: 2,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {},
      items: [],
    });

    const migrated = readBacklog(backlogPath, {
      behaviorFix: ["my correction"],
      successfulPattern: [],
      entityContext: ["看看"],
    });

    expect(migrated).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: {
        behaviorFix: ["my correction"],
        successfulPattern: [],
        entityContext: ["看看"],
      },
    });
    expect(
      readEvolutionTriggerKeywords(backlogPath, {
        behaviorFix: ["my correction"],
        successfulPattern: [],
        entityContext: ["看看"],
      }),
    ).toEqual({
      behaviorFix: ["my correction"],
      successfulPattern: [],
      entityContext: ["看看"],
    });
  });

  it("normalizes malformed trigger keyword fields while reading v3 backlog files", () => {
    const backlogPath = createTempBacklogPath();
    writeBacklogFixture(backlogPath, {
      schemaVersion: 3,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      triggerKeywords: {
        behaviorFix: [" retry "],
        successfulPattern: 123,
        entityContext: 123,
      },
      processedEvents: {},
      items: [],
    });

    expect(readBacklog(backlogPath).triggerKeywords).toEqual({
      behaviorFix: ["retry"],
      successfulPattern: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS.successfulPattern,
      entityContext: DEFAULT_EVOLUTION_TRIGGER_KEYWORDS.entityContext,
    });
  });

  it("keeps trigger keyword suggestions pending until an apply workflow exists", () => {
    const value = backlog();
    value.items = [
      item({
        targetKind: "trigger-keywords",
        operation: "adjust-trigger-keywords",
        targetTrigger: "behavior-fix",
        keywordChange: { add: ["try again"], remove: [] },
      }),
    ];

    expect(() =>
      markPendingProcessed(
        value,
        "IMP-1",
        value.items[0].updatedAt,
        "processed",
      ),
    ).toThrow("target metadata is unresolved");
  });

  it("selects highest frequency pending item then oldest", () => {
    const value = backlog();
    value.items = [
      item({ id: "new", frequency: 3, createdAt: "2026-06-12T00:00:00.000Z" }),
      item({ id: "old", frequency: 3, createdAt: "2026-06-10T00:00:00.000Z" }),
      item({ id: "processed", frequency: 9, status: "processed" }),
    ];

    expect(selectPendingItem(value)?.id).toBe("old");
    expect(selectPendingItem(value, "new")?.id).toBe("new");
  });

  it("sets legacy targets and enforces optimistic concurrency on processing", () => {
    const value = backlog();
    value.items = [item()];
    expect(() =>
      markPendingProcessed(
        value,
        "IMP-1",
        value.items[0].updatedAt,
        "processed",
      ),
    ).toThrow("target metadata is unresolved");

    updatePendingTarget(value, "IMP-1", "refine", ["productivity"], "targeted");

    expect(value.items[0]).toMatchObject({
      operation: "refine",
      targetIntentIds: ["productivity"],
      updatedAt: "targeted",
    });
    expect(() =>
      markPendingProcessed(value, "IMP-1", "stale", "processed"),
    ).toThrow("changed since it was selected");

    markPendingProcessed(value, "IMP-1", "targeted", "processed");
    expect(value.items[0]).toMatchObject({
      status: "processed",
      updatedAt: "processed",
    });
  });

  it("prunes processedEvents older than retention period", () => {
    const now = Date.parse("2026-06-15T12:00:00.000Z");
    const retentionDays = 90;
    const cutoffMs = retentionDays * 86_400_000;

    const keepTimestamp = new Date(now - cutoffMs + 1000).toISOString();
    const pruneTimestamp = new Date(now - cutoffMs - 1000).toISOString();

    const value = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      processedEvents: {
        "keep-event": keepTimestamp,
        "prune-event": pruneTimestamp,
      },
      items: [],
    });

    pruneProcessedEvents(value, now);

    expect(value.processedEvents).toEqual({
      "keep-event": {
        processedAt: keepTimestamp,
        triggers: [],
        findingCount: 0,
        outcome: "unknown",
      },
    });
  });

  it("prunes all events when all are older than retention", () => {
    const now = Date.parse("2026-06-15T12:00:00.000Z");
    const oldTimestamp = "2025-01-01T00:00:00.000Z";

    const value = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      processedEvents: {
        "old-1": oldTimestamp,
        "old-2": oldTimestamp,
      },
      items: [],
    });

    pruneProcessedEvents(value, now);
    expect(value.processedEvents).toEqual({});
  });

  it("keeps all events when none exceed retention", () => {
    const now = Date.parse("2026-06-15T12:00:00.000Z");
    const freshTimestamp = "2026-06-14T00:00:00.000Z";

    const value = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      processedEvents: {
        "fresh-1": freshTimestamp,
        "fresh-2": freshTimestamp,
      },
      items: [],
    });

    pruneProcessedEvents(value, now);
    expect(value.processedEvents).toEqual({
      "fresh-1": {
        processedAt: freshTimestamp,
        triggers: [],
        findingCount: 0,
        outcome: "unknown",
      },
      "fresh-2": {
        processedAt: freshTimestamp,
        triggers: [],
        findingCount: 0,
        outcome: "unknown",
      },
    });
  });

  it("handles empty processedEvents without error", () => {
    const value = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      processedEvents: {},
      items: [],
    });

    pruneProcessedEvents(value);
    expect(value.processedEvents).toEqual({});
  });

  it("prunes entries with invalid/corrupt date strings", () => {
    const value = parseBacklog({
      schemaVersion: 2,
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      processedEvents: {
        "valid-event": "2026-06-14T00:00:00.000Z",
        "invalid-event-1": "not-a-date",
        "invalid-event-2": "",
        "invalid-event-3": "2026-13-45T99:99:99",
      },
      items: [],
    });

    pruneProcessedEvents(value, Date.parse("2026-06-15T12:00:00.000Z"));

    expect(value.processedEvents).toEqual({
      "valid-event": {
        processedAt: "2026-06-14T00:00:00.000Z",
        triggers: [],
        findingCount: 0,
        outcome: "unknown",
      },
    });
  });
});
