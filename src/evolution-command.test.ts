import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleEvolutionCommand } from "./evolution-command.js";

function seedBacklog(root: string): void {
  fs.writeFileSync(
    path.join(root, "evolution.json"),
    JSON.stringify({
      schemaVersion: 3,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      triggerKeywords: {
        successfulPattern: [],
        behaviorFix: [],
        entityContext: [],
      },
      processedEvents: {},
      items: [
        {
          id: "one",
          type: "behavior-fix",
          targetKind: "intent-markdown",
          operation: "unknown",
          targetIntentIds: [],
          dedupeKey: "one",
          summary: "first item",
          correctionGoal: "goal",
          details: { evidence: [], suggestedChange: "change" },
          frequency: 2,
          sources: [],
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "old-version",
          status: "pending",
        },
      ],
    }),
  );
}

describe("evolution plugin command", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-command-"));
    fs.mkdirSync(root, { recursive: true });
    seedBacklog(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (args?: string) =>
    handleEvolutionCommand({ args, dataRoot: root });

  it("shows help for the command namespace", () => {
    expect(run().text).toContain("/intention-hint evolution list");
    expect(run("evolution help").text).toContain(
      "/intention-hint evolution mark-dismissed",
    );
  });

  it("lists pending backlog items", () => {
    expect(run("evolution list").text).toBe("one\t2\tunknown\tfirst item");
  });

  it("shows one pending backlog item as JSON", () => {
    expect(JSON.parse(run("evolution show --id one").text ?? "")).toMatchObject(
      {
        id: "one",
        summary: "first item",
      },
    );
  });

  it("validates runtime intents from positional IDs", () => {
    const intentsDir = path.join(root, "intents");
    fs.mkdirSync(intentsDir);
    fs.writeFileSync(
      path.join(intentsDir, "debugging.md"),
      `---
triggers: [debug]
examples: [debug]
domain: coding
---
## Guidelines
- Debug carefully.

## Response Strategy
- Respond.
`,
    );

    expect(
      JSON.parse(run("evolution validate-intents debugging").text ?? ""),
    ).toMatchObject({
      valid: true,
    });
  });

  it("does not let parameter-less flags swallow positional intent IDs", () => {
    const intentsDir = path.join(root, "intents");
    fs.mkdirSync(intentsDir);
    fs.writeFileSync(
      path.join(intentsDir, "debugging.md"),
      `---
triggers: [debug]
examples: [debug]
domain: coding
---
## Guidelines
- Debug carefully.

## Response Strategy
- Respond.
`,
    );

    expect(
      JSON.parse(run("evolution validate-intents --json debugging").text ?? ""),
    ).toMatchObject({
      valid: true,
    });
  });

  it("reports missing mutation arguments without stack traces", () => {
    expect(run("evolution mark-processed --id one").text).toBe(
      "missing required option: --expected-updated-at",
    );
  });

  it("sets targets and marks items dismissed", () => {
    const targeted = JSON.parse(
      run(
        "evolution set-target --id one --operation refine --target-intent debugging",
      ).text ?? "",
    );
    expect(targeted).toMatchObject({
      id: "one",
      operation: "refine",
      targetIntentIds: ["debugging"],
    });

    const dismissed = JSON.parse(
      run(
        `evolution mark-dismissed --id one --expected-updated-at ${targeted.updatedAt}`,
      ).text ?? "",
    );
    expect(dismissed).toMatchObject({ id: "one", status: "dismissed" });
  });
});
