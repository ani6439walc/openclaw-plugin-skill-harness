import { describe, expect, it } from "vitest";
import {
  markPendingProcessed,
  parseBacklog,
  pruneProcessedEvents,
  selectPendingItem,
  updatePendingTarget,
} from "./evolution-backlog.js";

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "IMP-1",
  type: "behavior_fix",
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
    schemaVersion: 2,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    processedEvents: {},
    items: [],
  });

describe("evolution backlog", () => {
  it("migrates v1 items with unknown operation and empty targets", () => {
    const migrated = parseBacklog({
      schemaVersion: 1,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: { event: "time" },
      items: [item({ operation: undefined, targetIntentIds: undefined })],
    });

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      processedEvents: { event: "time" },
      items: [{ operation: "unknown", targetIntentIds: [] }],
    });
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

    updatePendingTarget(value, "IMP-1", "refine", ["PRODUCTIVITY"], "targeted");

    expect(value.items[0]).toMatchObject({
      operation: "refine",
      targetIntentIds: ["PRODUCTIVITY"],
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
      "keep-event": keepTimestamp,
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
      "fresh-1": freshTimestamp,
      "fresh-2": freshTimestamp,
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
      "valid-event": "2026-06-14T00:00:00.000Z",
    });
  });
});
