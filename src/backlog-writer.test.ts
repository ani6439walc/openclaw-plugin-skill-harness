import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BacklogWriter } from "./backlog-writer.js";

describe("BacklogWriter", () => {
  let root: string;
  let writer: BacklogWriter;
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
    correctionGoal: "Create a deployment skill",
    suggestedChange: "Draft SKILL.md",
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "evolution-writer-"));
    writer = BacklogWriter.create(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readBacklog() {
    return JSON.parse(
      fs.readFileSync(path.join(root, "evolution.json"), "utf-8"),
    );
  }

  it("creates evolution.json and records findings", async () => {
    expect(
      await writer.record("session-1:turn-1", source, [finding], {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);

    expect(readBacklog()).toMatchObject({
      schemaVersion: 3,
      updatedAt: "2026-06-11T00:01:00.000Z",
      processedEvents: {
        "session-1:turn-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["skill-candidate"],
          findingCount: 1,
          outcome: "wrote-items",
        },
      },
      items: [
        {
          id: "IMP-20260611-001",
          type: "skill-candidate",
          operation: "refine",
          targetIntentIds: ["productivity"],
          dedupeKey: "deploy-flow",
          frequency: 1,
          status: "pending",
          summary: "Reusable deployment flow",
        },
      ],
    });
  });

  it("seeds legacy config keywords on first backlog write and refreshes cache", async () => {
    const onAfterWrite = vi.fn();
    writer = BacklogWriter.create(root, {
      triggerKeywordSeed: () => ({
        behaviorFix: [],
        successfulPattern: ["ship it"],
      }),
      onAfterWrite,
    });

    expect(await writer.record("event-1", source, [finding])).toBe(true);

    expect(readBacklog()).toMatchObject({
      triggerKeywords: {
        behaviorFix: [],
        successfulPattern: ["ship it"],
      },
    });
    expect(onAfterWrite).toHaveBeenCalledOnce();
  });

  it("merges matching pending findings and is event-idempotent", async () => {
    await writer.record("event-1", source, [finding]);
    await writer.record("event-2", { ...source, sessionId: "session-2" }, [
      finding,
    ]);
    expect(await writer.record("event-2", source, [finding])).toBe(false);

    const backlog = readBacklog();
    expect(backlog.items).toHaveLength(1);
    expect(backlog.items[0].frequency).toBe(2);
    expect(backlog.items[0].sources).toHaveLength(2);
  });

  it("records trigger keyword suggestions into evolution.json without applying them", async () => {
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
          {
            trigger: "entity-context",
            targetKind: "trigger-keywords",
            targetTrigger: "entity-context",
            addKeywords: ["看一下"],
            removeKeywords: [],
            dedupeKey: "entity-context:look-up",
            summary: "Learn entity-context keyword",
            evidence: ["User asked to check TOOLS.md for an entity record"],
            correctionGoal: "Add a precise entity-context trigger phrase",
            suggestedChange: "Add 看一下 to triggerKeywords.entityContext",
          },
        ],
        { nowMs: Date.parse("2026-06-11T00:01:00.000Z") },
      ),
    ).toBe(true);

    expect(readBacklog()).toMatchObject({
      schemaVersion: 3,
      triggerKeywords: expect.objectContaining({
        successfulPattern: expect.arrayContaining(["verified"]),
      }),
      items: [
        {
          type: "successful-pattern",
          targetKind: "trigger-keywords",
          operation: "adjust-trigger-keywords",
          targetTrigger: "successful-pattern",
          keywordChange: { add: ["ship it"], remove: [] },
          targetIntentIds: [],
          status: "pending",
        },
        {
          type: "entity-context",
          targetKind: "trigger-keywords",
          operation: "adjust-trigger-keywords",
          targetTrigger: "entity-context",
          keywordChange: { add: ["看一下"], remove: [] },
          targetIntentIds: [],
          status: "pending",
        },
      ],
    });
  });

  it("migrates v1 backlogs and updates operation and targets on merge", async () => {
    fs.mkdirSync(path.join(root, "sessions"));
    const backlogPath = path.join(root, "evolution.json");
    fs.writeFileSync(
      backlogPath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
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
    expect(readBacklog()).toMatchObject({
      schemaVersion: 3,
      items: [
        {
          frequency: 2,
          operation: "refine",
          targetIntentIds: ["productivity"],
        },
      ],
    });
  });

  it("preserves corrupt existing evolution.json", async () => {
    fs.mkdirSync(path.join(root, "sessions"));
    const backlogPath = path.join(root, "evolution.json");
    fs.writeFileSync(backlogPath, "{ broken");

    expect(await writer.record("event-1", source, [finding])).toBe(false);
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe("{ broken");
  });

  it("preserves valid JSON with an invalid backlog schema", async () => {
    fs.mkdirSync(path.join(root, "sessions"));
    const backlogPath = path.join(root, "evolution.json");
    fs.writeFileSync(backlogPath, '{"schemaVersion":1,"items":"invalid"}');

    expect(await writer.record("event-1", source, [finding])).toBe(false);
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe(
      '{"schemaVersion":1,"items":"invalid"}',
    );
  });

  it("records no-finding events for idempotency", async () => {
    expect(
      await writer.record("event-1", source, [], {
        triggers: ["behavior-fix"],
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(await writer.record("event-1", source, [])).toBe(false);
    expect(readBacklog()).toMatchObject({
      processedEvents: {
        "event-1": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["behavior-fix"],
          findingCount: 0,
          outcome: "nofinding",
        },
      },
      items: [],
    });
  });

  it("records parse-failed and subagent-error outcomes for observability", async () => {
    expect(
      await writer.record("event-parse", source, [], {
        triggers: ["successful-pattern"],
        outcome: "parse-failed",
      }),
    ).toBe(true);
    expect(
      await writer.record("event-error", source, [], {
        triggers: ["behavior-fix", "entity-context"],
        outcome: "subagent-error",
      }),
    ).toBe(true);

    expect(readBacklog()).toMatchObject({
      processedEvents: {
        "event-parse": {
          triggers: ["successful-pattern"],
          findingCount: 0,
          outcome: "parse-failed",
        },
        "event-error": {
          triggers: ["behavior-fix", "entity-context"],
          findingCount: 0,
          outcome: "subagent-error",
        },
      },
    });
  });
});
