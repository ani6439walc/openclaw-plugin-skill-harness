import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveDefaultEvolutionBacklogRoot,
  runEvolutionBacklogCommand,
} from "./evolution-backlog-command.js";

describe("evolution-backlog command", () => {
  let root: string;
  let output: string[];
  let errors: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-backlog-"));
    fs.mkdirSync(path.join(root, "sessions"));
    output = [];
    errors = [];
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
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (args: string[]) =>
    runEvolutionBacklogCommand(args, root, {
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
    });

  it("resolves the direct CLI root from OpenClaw state dir", () => {
    expect(
      resolveDefaultEvolutionBacklogRoot({ OPENCLAW_STATE_DIR: root }),
    ).toBe(path.join(root, "plugins", "intention-hint"));
  });

  it("shows the highest-frequency pending item by default", () => {
    expect(run(["show"])).toBe(0);
    expect(JSON.parse(output[0]).id).toBe("old");
  });

  it("accepts pnpm's leading argument separator", () => {
    expect(run(["--", "show"])).toBe(0);
    expect(JSON.parse(output[0]).id).toBe("old");
  });

  it("lists pending items in processing order", () => {
    expect(run(["list", "--json"])).toBe(0);
    expect(
      JSON.parse(output[0]).map((item: { id: string }) => item.id),
    ).toEqual(["old", "new"]);
  });

  it("sets targets while migrating v1 and rejects stale processing", () => {
    expect(
      run([
        "mark-processed",
        "--id",
        "old",
        "--expected-updated-at",
        "old-version",
      ]),
    ).toBe(1);
    expect(errors.at(-1)).toContain("target metadata is unresolved");

    expect(
      run([
        "set-target",
        "--id",
        "old",
        "--operation",
        "refine",
        "--target-intent",
        "productivity",
      ]),
    ).toBe(0);
    const targeted = JSON.parse(output.at(-1)!);
    expect(targeted).toMatchObject({
      operation: "refine",
      targetIntentIds: ["productivity"],
    });

    expect(
      run([
        "mark-processed",
        "--id",
        "old",
        "--expected-updated-at",
        "old-version",
      ]),
    ).toBe(1);
    expect(errors.at(-1)).toContain("changed since it was selected");
  });

  it("marks the selected item processed with optimistic concurrency", () => {
    expect(
      run([
        "set-target",
        "--id",
        "old",
        "--operation",
        "refine",
        "--target-intent",
        "productivity",
      ]),
    ).toBe(0);
    const targeted = JSON.parse(output.at(-1)!);

    expect(
      run([
        "mark-processed",
        "--id",
        "old",
        "--expected-updated-at",
        targeted.updatedAt,
      ]),
    ).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      id: "old",
      status: "processed",
    });
    expect(run(["show", "--id", "old"])).toBe(1);
  });

  it("marks the selected item dismissed with optimistic concurrency", () => {
    expect(run(["show", "--id", "old"])).toBe(0);
    const selected = JSON.parse(output.at(-1)!);

    expect(
      run([
        "mark-dismissed",
        "--id",
        "old",
        "--expected-updated-at",
        selected.updatedAt,
      ]),
    ).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      id: "old",
      status: "dismissed",
    });
    expect(run(["show", "--id", "old"])).toBe(1);
  });

  it("preserves a corrupt backlog when a mutation is requested", () => {
    const backlogPath = path.join(root, "evolution.json");
    fs.writeFileSync(backlogPath, "{ broken");

    expect(
      run([
        "set-target",
        "--id",
        "old",
        "--operation",
        "refine",
        "--target-intent",
        "productivity",
      ]),
    ).toBe(1);
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

    expect(run(["validate-intents", "--id", "one"])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      valid: true,
      errors: [],
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
          },
          rejected: {
            processedAt: "2026-07-04T11:00:00.000Z",
            triggers: ["behavior-fix"],
            findingCount: 0,
            outcome: "schema-rejected",
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
      run([
        "review-health",
        "--days",
        "2",
        "--now",
        "2026-07-04T12:00:00.000Z",
      ]),
    ).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
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
    });
  });

  it("rejects invalid review-health --now values", () => {
    expect(run(["review-health", "--now", "not-a-date"])).toBe(1);
    expect(errors.at(-1)).toContain("--now must be a valid date/time");
  });
});
