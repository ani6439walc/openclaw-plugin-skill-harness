import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewLogWriter } from "./log-writer.js";

describe("ReviewLogWriter", () => {
  let root: string;
  let writer: ReviewLogWriter;
  const source = {
    sessionId: "session-1",
    agentId: "main",
    turnStart: "2026-06-11T00:00:00.000Z",
  };
  const finding = {
    trigger: "skill-candidate" as const,
    targetKind: "intent-markdown" as const,
    operation: "refine" as const,
    targetIntentIds: ["productivity"],
    dedupeKey: "deploy-flow",
    summary: "Reusable deployment flow",
    evidence: ["Five related tool calls"],
    correctionGoal: "Preserve deployment workflow",
    suggestedChange: "Updated productivity.md Experience with deployment flow",
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "review-writer-"));
    writer = ReviewLogWriter.create(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readLog() {
    return JSON.parse(fs.readFileSync(path.join(root, "review.json"), "utf-8"));
  }

  it("creates review.json and records applied direct changes without pending items", async () => {
    expect(
      await writer.record("session-1:turn-1", source, [finding], {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
        changedIntentIds: ["productivity"],
      }),
    ).toBe(true);

    expect(readLog()).toMatchObject({
      schemaVersion: 4,
      updatedAt: "2026-06-11T00:01:00.000Z",
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          source,
          triggers: ["skill-candidate"],
          changeCount: 1,
          outcome: "applied",
          changedIntentIds: ["productivity"],
          changes: [
            {
              trigger: "skill-candidate",
              targetKind: "intent-markdown",
              operation: "refine",
              targetIntentIds: ["productivity"],
              dedupeKey: "deploy-flow",
              summary: "Reusable deployment flow",
            },
          ],
        },
      },
    });
    expect(readLog()).not.toHaveProperty("items");
  });

  it("seeds legacy config keywords on first review log write and refreshes cache", async () => {
    const onAfterWrite = vi.fn();
    writer = ReviewLogWriter.create(root, {
      triggerKeywordSeed: () => ({
        behaviorFix: [],
        successfulPattern: ["ship it"],
      }),
      onAfterWrite,
    });

    expect(await writer.record("event-1", source, [finding])).toBe(true);

    expect(readLog()).toMatchObject({
      triggerKeywords: {
        behaviorFix: [],
        successfulPattern: ["ship it"],
      },
    });
    expect(onAfterWrite).toHaveBeenCalledOnce();
  });

  it("is event-idempotent without merging repeated pending items", async () => {
    await writer.record("event-1", source, [finding]);
    expect(await writer.record("event-1", source, [finding])).toBe(false);

    const log = readLog();
    expect(Object.keys(log.processedEvents)).toEqual(["event-1"]);
    expect(log).not.toHaveProperty("items");
  });

  it("applies trigger keyword findings directly to review.json", async () => {
    expect(
      await writer.record(
        "session-1:turn-1",
        source,
        [
          {
            trigger: "successful-pattern",
            targetKind: "trigger-keywords",
            targetTrigger: "successful-pattern",
            addKeywords: ["ship it"],
            removeKeywords: [],
            dedupeKey: "successful-pattern:ship-it",
            summary: "Learn successful-pattern keyword",
            evidence: ["User confirmed the workflow was done"],
            correctionGoal: "Add a precise successful-pattern trigger phrase",
            suggestedChange: "Add ship it to triggerKeywords.successfulPattern",
          },
        ],
        { nowMs: Date.parse("2026-06-11T00:01:00.000Z") },
      ),
    ).toBe(true);

    expect(readLog()).toMatchObject({
      schemaVersion: 4,
      triggerKeywords: expect.objectContaining({
        successfulPattern: expect.arrayContaining(["verified", "ship it"]),
      }),
      processedEvents: {
        "session-1:turn-1": {
          outcome: "applied",
          changes: [
            {
              targetKind: "trigger-keywords",
              operation: "adjust-trigger-keywords",
              targetTrigger: "successful-pattern",
              keywordChange: { add: ["ship it"], remove: [] },
            },
          ],
        },
      },
    });
  });

  it("lets explicit trigger keyword removals win over duplicate additions", async () => {
    expect(
      await writer.record("session-1:turn-1", source, [
        {
          trigger: "successful-pattern",
          targetKind: "trigger-keywords",
          targetTrigger: "successful-pattern",
          addKeywords: ["verified", "ship it"],
          removeKeywords: ["verified"],
          dedupeKey: "successful-pattern:keyword-conflict",
          summary: "Update successful-pattern keywords",
          evidence: ["The reviewer returned conflicting keyword edits"],
          correctionGoal: "Remove stale trigger wording while adding a new one",
          suggestedChange: "Remove verified and add ship it.",
        },
      ]),
    ).toBe(true);

    expect(readLog().triggerKeywords.successfulPattern).toContain("ship it");
    expect(readLog().triggerKeywords.successfulPattern).not.toContain(
      "verified",
    );
  });

  it("migrates legacy v3 review files by dropping legacy items", async () => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        schemaVersion: 3,
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        triggerKeywords: { successfulPattern: ["done"] },
        processedEvents: {},
        items: [
          {
            id: "IMP-20260610-001",
            type: finding.trigger,
            dedupeKey: finding.dedupeKey,
            summary: "old",
            correctionGoal: "old",
            details: { evidence: [], suggestedChange: "old" },
            frequency: 1,
            sources: [source],
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:00.000Z",
            status: "pending",
          },
        ],
      }),
    );

    expect(await writer.record("event-2", source, [finding])).toBe(true);
    expect(readLog()).toMatchObject({
      schemaVersion: 4,
      triggerKeywords: { successfulPattern: ["done"] },
      processedEvents: { "event-2": { outcome: "applied" } },
    });
    expect(readLog()).not.toHaveProperty("items");
  });

  it("preserves corrupt existing review.json", async () => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(logPath, "{ broken");

    expect(await writer.record("event-1", source, [finding])).toBe(false);
    expect(fs.readFileSync(logPath, "utf-8")).toBe("{ broken");
  });

  it("records no-finding events for idempotency", async () => {
    expect(
      await writer.record("event-1", source, [], {
        triggers: ["behavior-fix"],
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(await writer.record("event-1", source, [])).toBe(false);
    expect(readLog()).toMatchObject({
      processedEvents: {
        "event-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["behavior-fix"],
          changeCount: 0,
          outcome: "nofinding",
        },
      },
    });
    expect(readLog()).not.toHaveProperty("items");
  });

  it("records sanitized review metadata on processed events", async () => {
    expect(
      await writer.record("event-1", source, [], {
        triggers: ["successful-pattern", "behavior-fix"],
        outcome: "schema-rejected",
        validationErrors: ["bad.md: missing ## Guidelines"],
        noFindingReasonCounts: {
          "routine-tool-use": 2,
          unknown: 1,
        } as never,
        schemaRejectionReasonCounts: {
          "missing-required-field": 1,
          nope: 4,
        } as never,
      }),
    ).toBe(true);

    expect(readLog().processedEvents["event-1"]).toMatchObject({
      outcome: "schema-rejected",
      validationErrors: ["bad.md: missing ## Guidelines"],
      noFindingReasonCounts: { "routine-tool-use": 2 },
      schemaRejectionReasonCounts: { "missing-required-field": 1 },
    });
  });
});
