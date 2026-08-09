import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentReviewLogWriter, ReviewLogWriter } from "./log-writer.js";

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
  const skillPlacementCandidate = {
    epochKey: "a".repeat(64),
    agentId: "main",
    name: "unused-skill",
    source: "workspace" as const,
    reason: "zero-recommendation-usage" as const,
    observedTurns: 20,
    usageTurns: 0,
    recommendedTurns: 0,
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
      schemaVersion: 5,
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
      schemaVersion: 5,
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

  it("preserves legacy review files without migration", async () => {
    const logPath = path.join(root, "review.json");
    const original = JSON.stringify({
      schemaVersion: 3,
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
      triggerKeywords: { successfulPattern: ["done"] },
      processedEvents: {},
      items: [],
    });
    fs.writeFileSync(logPath, original);

    expect(await writer.record("event-2", source, [finding])).toBe(false);
    expect(writer.completedSkillEpochKeys()).toBeUndefined();
    expect(fs.readFileSync(logPath, "utf-8")).toBe(original);
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

  it("completes skill epochs only for applied or no-finding outcomes", async () => {
    expect(writer.completedSkillEpochKeys()).toEqual(new Set());
    expect(
      await writer.record("event-1", source, [finding], {
        outcome: "applied",
        skillPlacementCandidate,
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(writer.completedSkillEpochKeys()).toEqual(
      new Set([skillPlacementCandidate.epochKey]),
    );
    expect(
      readLog().reviewedSkillEpochs[skillPlacementCandidate.epochKey],
    ).toMatchObject({
      agentId: "main",
      skillName: "unused-skill",
      source: "workspace",
      reason: "zero-recommendation-usage",
      completedAt: "2026-06-11T00:01:00.000Z",
      outcome: "applied",
      eventId: "event-1",
    });

    const failedCandidate = {
      ...skillPlacementCandidate,
      epochKey: "b".repeat(64),
    };
    expect(
      await writer.record("event-2", source, [], {
        outcome: "validation-failed",
        skillPlacementCandidate: failedCandidate,
      }),
    ).toBe(true);
    expect(writer.completedSkillEpochKeys()).toEqual(
      new Set([skillPlacementCandidate.epochKey]),
    );
  });

  it("writes the processed event and completed skill epoch atomically", async () => {
    expect(
      await writer.record("seed-event", source, [], {
        outcome: "validation-failed",
      }),
    ).toBe(true);
    const before = readLog();

    fs.chmodSync(root, 0o500);
    try {
      expect(
        await writer.record("placement-event", source, [], {
          outcome: "nofinding",
          skillPlacementCandidate,
        }),
      ).toBe(false);
    } finally {
      fs.chmodSync(root, 0o700);
    }

    expect(readLog()).toEqual(before);
    expect(readLog().processedEvents).not.toHaveProperty("placement-event");
    expect(readLog().reviewedSkillEpochs).not.toHaveProperty(
      skillPlacementCandidate.epochKey,
    );

    expect(
      await writer.record("placement-event", source, [], {
        outcome: "nofinding",
        skillPlacementCandidate,
      }),
    ).toBe(true);
    expect(readLog().processedEvents).toHaveProperty("placement-event");
    expect(readLog().reviewedSkillEpochs).toHaveProperty(
      skillPlacementCandidate.epochKey,
    );
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
          "missing-trigger-decision": 1,
          nope: 4,
        } as never,
      }),
    ).toBe(true);

    expect(readLog().processedEvents["event-1"]).toMatchObject({
      outcome: "schema-rejected",
      validationErrors: ["bad.md: missing ## Guidelines"],
      noFindingReasonCounts: { "routine-tool-use": 2 },
      schemaRejectionReasonCounts: {
        "missing-required-field": 1,
        "missing-trigger-decision": 1,
      },
    });
  });
});

describe("IntentReviewLogWriter", () => {
  let root: string;
  let writer: IntentReviewLogWriter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-review-writer-"));
    writer = IntentReviewLogWriter.create(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes v6 intent audit records without active keyword state", async () => {
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
      }),
    ).toBe(true);
    expect(await writer.record("session-1:turn-1", source, [finding])).toBe(
      false,
    );

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "review.json"), "utf8"),
    );
    expect(log).toMatchObject({
      schemaVersion: 6,
      historicalKeywordAudits: {},
      processedEvents: {
        "session-1:turn-1": {
          changeCount: 1,
          outcome: "applied",
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

  it("prunes expired intent and historical keyword audits before v6 writes", async () => {
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

  it("preserves v6 skill-placement epoch idempotency", async () => {
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
