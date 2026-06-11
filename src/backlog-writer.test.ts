import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    trigger: "skill_candidate" as const,
    operation: "refine" as const,
    targetIntentIds: ["PRODUCTIVITY"],
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
      fs.readFileSync(path.join(root, "sessions", "evolution.json"), "utf-8"),
    );
  }

  it("creates sessions/evolution.json and records findings", () => {
    expect(
      writer.record("session-1:turn-1", source, [finding], {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);

    expect(readBacklog()).toMatchObject({
      schemaVersion: 2,
      updatedAt: "2026-06-11T00:01:00.000Z",
      processedEvents: {
        "session-1:turn-1": "2026-06-11T00:01:00.000Z",
      },
      items: [
        {
          id: "IMP-20260611-001",
          type: "skill_candidate",
          operation: "refine",
          targetIntentIds: ["PRODUCTIVITY"],
          dedupeKey: "deploy-flow",
          frequency: 1,
          status: "pending",
          summary: "Reusable deployment flow",
        },
      ],
    });
  });

  it("merges matching pending findings and is event-idempotent", () => {
    writer.record("event-1", source, [finding]);
    writer.record("event-2", { ...source, sessionId: "session-2" }, [finding]);
    expect(writer.record("event-2", source, [finding])).toBe(false);

    const backlog = readBacklog();
    expect(backlog.items).toHaveLength(1);
    expect(backlog.items[0].frequency).toBe(2);
    expect(backlog.items[0].sources).toHaveLength(2);
  });

  it("migrates v1 backlogs and updates operation and targets on merge", () => {
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions);
    const backlogPath = path.join(sessions, "evolution.json");
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

    expect(writer.record("event-2", source, [finding])).toBe(true);
    expect(readBacklog()).toMatchObject({
      schemaVersion: 2,
      items: [
        {
          frequency: 2,
          operation: "refine",
          targetIntentIds: ["PRODUCTIVITY"],
        },
      ],
    });
  });

  it("preserves corrupt existing evolution.json", () => {
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions);
    const backlogPath = path.join(sessions, "evolution.json");
    fs.writeFileSync(backlogPath, "{ broken");

    expect(writer.record("event-1", source, [finding])).toBe(false);
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe("{ broken");
  });

  it("preserves valid JSON with an invalid backlog schema", () => {
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(sessions);
    const backlogPath = path.join(sessions, "evolution.json");
    fs.writeFileSync(backlogPath, '{"schemaVersion":1,"items":"invalid"}');

    expect(writer.record("event-1", source, [finding])).toBe(false);
    expect(fs.readFileSync(backlogPath, "utf-8")).toBe(
      '{"schemaVersion":1,"items":"invalid"}',
    );
  });

  it("records no-finding events for idempotency", () => {
    expect(writer.record("event-1", source, [])).toBe(true);
    expect(writer.record("event-1", source, [])).toBe(false);
    expect(readBacklog().items).toEqual([]);
  });
});
