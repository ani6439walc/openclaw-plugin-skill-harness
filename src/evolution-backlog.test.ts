import { describe, expect, it } from "vitest";
import {
  markPendingProcessed,
  parseBacklog,
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
});
