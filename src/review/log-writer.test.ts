import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentReviewLogWriter } from "./log-writer.js";

describe("IntentReviewLogWriter", () => {
  let root: string;
  let writer: IntentReviewLogWriter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-review-writer-"));
    writer = new IntentReviewLogWriter(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes v7 intent audit records without active keyword state", async () => {
    const finding = {
      trigger: "skill-candidate" as const,
      targetKind: "intent-markdown" as const,
      operation: "refine" as const,
      targetIntentIds: ["productivity"],
      dedupeKey: "deploy-flow",
      summary: "Reusable deployment flow",
      evidence: ["Five related tool calls"],
      correctionGoal: "Preserve deployment workflow",
      suggestedChange: "Updated productivity.md",
    };
    const source = {
      sessionId: "session-1",
      agentId: "main",
      turnStart: "2026-06-11T00:00:00.000Z",
    };

    expect(
      await writer.record("session-1:turn-1", source, [finding], {
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
        changedExperienceIds: ["deployment/reusable-flow"],
      }),
    ).toBe(true);
    expect(await writer.record("session-1:turn-1", source, [finding])).toBe(
      false,
    );

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "review.json"), "utf8"),
    );
    expect(log).toMatchObject({
      schemaVersion: 7,
      historicalKeywordAudits: {},
      processedEvents: {
        "session-1:turn-1": {
          changeCount: 1,
          outcome: "applied",
          changedExperienceIds: ["deployment/reusable-flow"],
          changes: [{ targetKind: "intent-markdown" }],
        },
      },
    });
    expect(log).not.toHaveProperty("triggerKeywords");
  });

  it("records keyword-triggered nofinding audits outside intent processed events", async () => {
    const source = {
      sessionId: "session-1",
      agentId: "main",
      turnStart: "2026-06-11T00:00:00.000Z",
    };

    await expect(
      writer.recordHistoricalKeywordAudit("keyword-nofinding", source, [], {
        triggers: ["successful-pattern"],
        outcome: "nofinding",
      }),
    ).resolves.toBe(true);

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "review.json"), "utf8"),
    );
    expect(log.processedEvents).toEqual({});
    expect(log.historicalKeywordAudits).toMatchObject({
      "keyword-nofinding": {
        triggers: ["successful-pattern"],
        outcome: "nofinding",
        changeCount: 0,
      },
    });
  });

  it.each([
    ["malformed", "{ broken"],
    [
      "non-v7",
      JSON.stringify({
        schemaVersion: 5,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        triggerKeywords: {},
        processedEvents: {},
        reviewedSkillEpochs: {},
      }),
    ],
  ])("fails open without changing %s review.json", async (_name, original) => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(logPath, original);

    await expect(
      writer.record(
        "event-1",
        {
          sessionId: "session-1",
          turnStart: "2026-06-11T00:00:00.000Z",
        },
        [],
      ),
    ).resolves.toBe(false);
    expect(fs.readFileSync(logPath, "utf8")).toBe(original);
  });

  it("prunes expired intent and historical keyword audits before v7 writes", async () => {
    const source = {
      sessionId: "session-1",
      agentId: "main",
      turnStart: "2026-01-01T00:00:00.000Z",
    };
    const oldNowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const currentNowMs = Date.parse("2026-04-02T00:00:00.000Z");

    await writer.record("expired-intent", source, [], {
      triggers: ["skill-candidate"],
      outcome: "nofinding",
      nowMs: oldNowMs,
    });
    await writer.recordHistoricalKeywordAudit("expired-keyword", source, [], {
      triggers: ["successful-pattern"],
      outcome: "nofinding",
      nowMs: oldNowMs,
    });
    await writer.record("current-intent", source, [], {
      triggers: ["skill-candidate"],
      outcome: "nofinding",
      nowMs: currentNowMs,
    });

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "review.json"), "utf8"),
    );
    expect(log.processedEvents).toEqual({
      "current-intent": expect.any(Object),
    });
    expect(log.historicalKeywordAudits).toEqual({});
  });

  it("preserves v7 skill-placement epoch idempotency", async () => {
    const candidate = {
      epochKey: "a".repeat(64),
      agentId: "main",
      name: "unused-skill",
      source: "workspace" as const,
      reason: "zero-recommendation-usage" as const,
      observedTurns: 20,
      usageTurns: 0,
      recommendedTurns: 0,
    };
    const source = {
      sessionId: "session-1",
      agentId: "main",
      turnStart: "2026-06-11T00:00:00.000Z",
    };

    expect(
      await writer.record("placement-event", source, [], {
        outcome: "nofinding",
        skillPlacementCandidate: candidate,
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(writer.completedSkillEpochKeys()).toEqual(
      new Set([candidate.epochKey]),
    );
    expect(
      await writer.record("placement-event-retry", source, [], {
        outcome: "nofinding",
        skillPlacementCandidate: candidate,
        nowMs: Date.parse("2026-06-11T00:02:00.000Z"),
      }),
    ).toBe(false);

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "review.json"), "utf8"),
    );
    expect(log.reviewedSkillEpochs[candidate.epochKey].eventId).toBe(
      "placement-event",
    );
  });
});
