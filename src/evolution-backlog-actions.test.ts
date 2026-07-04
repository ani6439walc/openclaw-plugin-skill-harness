import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runEvolutionBacklogAction } from "./evolution-backlog-actions.js";

function writeSeedBacklog(root: string): void {
  fs.writeFileSync(
    path.join(root, "evolution.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAt: "created",
      updatedAt: "updated",
      processedEvents: {},
      items: [
        {
          id: "old",
          type: "behavior-fix",
          dedupeKey: "old",
          summary: "old",
          correctionGoal: "goal",
          details: { evidence: [], suggestedChange: "change" },
          frequency: 2,
          sources: [],
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "old-version",
          status: "pending",
        },
        {
          id: "new",
          type: "behavior-fix",
          dedupeKey: "new",
          summary: "new",
          correctionGoal: "goal",
          details: { evidence: [], suggestedChange: "change" },
          frequency: 1,
          sources: [],
          createdAt: "2026-06-11T00:00:00.000Z",
          updatedAt: "new-version",
          status: "pending",
        },
      ],
    }),
  );
}

describe("evolution backlog actions", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-actions-"));
    fs.mkdirSync(path.join(root, "sessions"));
    writeSeedBacklog(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (
    action: Parameters<typeof runEvolutionBacklogAction>[0]["action"],
  ) => runEvolutionBacklogAction({ action, dataRoot: root });

  it("shows the highest-frequency pending item by default", () => {
    expect(run({ action: "show" })).toMatchObject({
      ok: true,
      result: { id: "old" },
    });
  });

  it("lists pending items in processing order", () => {
    const result = run({ action: "list" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("sets targets while migrating v1 and rejects stale processing", () => {
    expect(
      run({
        action: "mark-processed",
        id: "old",
        expectedUpdatedAt: "old-version",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("target metadata is unresolved"),
    });

    expect(
      run({
        action: "set-target",
        id: "old",
        operation: "refine",
        targetIntentIds: ["productivity"],
      }),
    ).toMatchObject({
      ok: true,
      result: {
        operation: "refine",
        targetIntentIds: ["productivity"],
      },
    });

    expect(
      run({
        action: "mark-processed",
        id: "old",
        expectedUpdatedAt: "old-version",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed since it was selected"),
    });
  });

  it("marks the selected item processed with optimistic concurrency", () => {
    const targeted = run({
      action: "set-target",
      id: "old",
      operation: "refine",
      targetIntentIds: ["productivity"],
    });
    expect(targeted.ok).toBe(true);
    if (!targeted.ok) return;

    expect(
      run({
        action: "mark-processed",
        id: "old",
        expectedUpdatedAt: targeted.result.updatedAt,
      }),
    ).toMatchObject({
      ok: true,
      result: { id: "old", status: "processed" },
    });
    expect(run({ action: "show", id: "old" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pending backlog item not found"),
    });
  });

  it("marks the selected item dismissed with optimistic concurrency", () => {
    const selected = run({ action: "show", id: "old" });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(
      run({
        action: "mark-dismissed",
        id: "old",
        expectedUpdatedAt: selected.result.updatedAt,
      }),
    ).toMatchObject({
      ok: true,
      result: { id: "old", status: "dismissed" },
    });
    expect(run({ action: "show", id: "old" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("pending backlog item not found"),
    });
  });

  it("preserves a corrupt backlog when a mutation is requested", () => {
    const backlogPath = path.join(root, "evolution.json");
    fs.writeFileSync(backlogPath, "{ broken");

    expect(
      run({
        action: "set-target",
        id: "old",
        operation: "refine",
        targetIntentIds: ["productivity"],
      }),
    ).toMatchObject({ ok: false });
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe("{ broken");
  });

  it("returns clean JSON from intent validation", () => {
    const intentsDir = path.join(root, "intents");
    fs.mkdirSync(intentsDir);
    fs.writeFileSync(
      path.join(intentsDir, "one.md"),
      `---
triggers: [one]
examples: [one]
domain: test
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );

    expect(run({ action: "validate-intents", ids: ["one"] })).toMatchObject({
      ok: true,
      result: { valid: true, errors: [] },
    });
  });

  it("summarizes recent review health by outcome", () => {
    fs.writeFileSync(
      path.join(root, "evolution.json"),
      JSON.stringify({
        schemaVersion: 3,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-04T12:00:00.000Z",
        triggerKeywords: {
          successfulPattern: [],
          behaviorFix: [],
          entityContext: [],
        },
        processedEvents: {
          old: {
            processedAt: "2026-07-01T00:00:00.000Z",
            triggers: ["successful-pattern"],
            findingCount: 1,
            outcome: "wrote-items",
          },
          nofinding: {
            processedAt: "2026-07-04T10:00:00.000Z",
            triggers: ["successful-pattern"],
            findingCount: 0,
            outcome: "nofinding",
            noFindingReasonCounts: {
              "routine-tool-use": 2,
              "insufficient-evidence": 1,
            },
          },
          rejected: {
            processedAt: "2026-07-04T11:00:00.000Z",
            triggers: ["behavior-fix"],
            findingCount: 0,
            outcome: "schema-rejected",
            schemaRejectionReasonCounts: {
              "missing-target": 2,
              "invalid-operation": 1,
            },
          },
        },
        items: [
          {
            id: "processed",
            type: "successful-pattern",
            targetKind: "intent-markdown",
            operation: "refine",
            targetIntentIds: ["debugging"],
            dedupeKey: "processed",
            summary: "processed",
            correctionGoal: "goal",
            details: { evidence: [], suggestedChange: "change" },
            frequency: 1,
            sources: [],
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
            status: "processed",
          },
          {
            id: "pending",
            type: "behavior-fix",
            targetKind: "intent-markdown",
            operation: "refine",
            targetIntentIds: ["social-casual"],
            dedupeKey: "pending",
            summary: "pending",
            correctionGoal: "goal",
            details: { evidence: [], suggestedChange: "change" },
            frequency: 1,
            sources: [],
            createdAt: "2026-07-04T09:00:00.000Z",
            updatedAt: "2026-07-04T09:00:00.000Z",
            status: "pending",
          },
        ],
      }),
    );

    expect(
      run({
        action: "review-health",
        days: 2,
        now: "2026-07-04T12:00:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        processedEvents: {
          total: 3,
          recent: 2,
          recentByOutcome: {
            nofinding: 1,
            "schema-rejected": 1,
          },
          recentByTrigger: {
            "successful-pattern": 1,
            "behavior-fix": 1,
          },
          totalNoFindingReasonCounts: {
            "routine-tool-use": 2,
            "insufficient-evidence": 1,
          },
          recentNoFindingReasonCounts: {
            "routine-tool-use": 2,
            "insufficient-evidence": 1,
          },
          totalSchemaRejectionReasonCounts: {
            "missing-target": 2,
            "invalid-operation": 1,
          },
          recentSchemaRejectionReasonCounts: {
            "missing-target": 2,
            "invalid-operation": 1,
          },
        },
        items: {
          total: 2,
          pending: 1,
          recentCreated: 1,
          recentUpdated: 1,
        },
        rates: {
          recentNoFindingRate: 0.5,
          recentNoNewItemRate: 0.5,
        },
      },
    });
  });

  it("rejects invalid review-health now values", () => {
    expect(run({ action: "review-health", now: "not-a-date" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("now must be a valid date/time"),
    });
  });
});
