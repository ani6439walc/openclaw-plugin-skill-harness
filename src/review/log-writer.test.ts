import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentReviewLogWriter } from "./log-writer.js";

describe("IntentReviewLogWriter", () => {
  let root: string;
  let writer: IntentReviewLogWriter;
  const source = {
    sessionId: "session-1",
    agentId: "main",
    turnStart: "2026-06-11T00:00:00.000Z",
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-review-writer-"));
    writer = new IntentReviewLogWriter(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes one v8 record for an applied review", async () => {
    const finding = {
      trigger: "capability-fit" as const,
      targetKind: "intent-markdown" as const,
      operation: "refine" as const,
      targetIntentIds: ["productivity"],
      dedupeKey: "deploy-flow",
      summary: "Reusable deployment flow",
      evidence: ["Five related tool calls"],
      correctionGoal: "Preserve deployment workflow",
      suggestedChange: "Updated productivity.md",
    };

    expect(
      await writer.record("session-1:turn-1", source, [finding], {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(await writer.record("session-1:turn-1", source, [finding])).toBe(
      false,
    );

    expect(
      JSON.parse(fs.readFileSync(path.join(root, "review.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 8,
      processedEvents: {
        "session-1:turn-1": {
          triggers: ["capability-fit"],
          changeCount: 1,
          outcome: "applied",
          changes: [{ targetKind: "intent-markdown" }],
        },
      },
    });
  });

  it("migrates a v7 log before recording a new event", async () => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        schemaVersion: 7,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        processedEvents: {
          prior: {
            processedAt: "2026-06-01T00:00:00.000Z",
            triggers: ["weak-intent"],
            changeCount: 0,
            outcome: "nofinding",
          },
        },
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
      }),
    );

    expect(
      await writer.record("next", source, [], {
        triggers: ["intent-health-check"],
      }),
    ).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8"));
    expect(persisted).toMatchObject({ schemaVersion: 8 });
    expect(persisted.processedEvents.prior.triggers).toEqual([
      "routing-uncertainty",
    ]);
    expect(persisted.processedEvents.next.triggers).toEqual([
      "intent-health-check",
    ]);
    expect(persisted).not.toHaveProperty("historicalKeywordAudits");
  });

  it.each(["{ broken", JSON.stringify({ schemaVersion: 5 })])(
    "fails open without changing invalid review.json",
    async (original) => {
      const logPath = path.join(root, "review.json");
      fs.writeFileSync(logPath, original);
      await expect(writer.record("event-1", source, [])).resolves.toBe(false);
      expect(fs.readFileSync(logPath, "utf8")).toBe(original);
    },
  );

  it("preserves skill-placement epoch idempotency", async () => {
    const candidate = {
      epochKey: "a".repeat(64),
      agentId: "main",
      name: "unused-skill",
      source: "workspace" as const,
      reason: "zero-intent-match-usage" as const,
      observedTurns: 20,
      usageTurns: 0,
      intentMatchedTurns: 0,
    };
    expect(
      await writer.record("placement-event", source, [], {
        outcome: "nofinding",
        skillPlacementCandidate: candidate,
      }),
    ).toBe(true);
    expect(writer.completedSkillEpochKeys()).toEqual(
      new Set([candidate.epochKey]),
    );
    expect(
      await writer.record("placement-event-retry", source, [], {
        outcome: "nofinding",
        skillPlacementCandidate: candidate,
      }),
    ).toBe(false);
  });
});
