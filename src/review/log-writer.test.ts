import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentReviewLogWriter } from "./log-writer.js";
import { parseReviewLog } from "./log.js";
import type { ReviewFinding, SkillRelationReviewFinding } from "./types.js";
import { logger } from "../../api.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relationFinding: SkillRelationReviewFinding = {
    trigger: "capability-fit",
    targetKind: "skill-relation",
    operation: "create",
    fromSkillId: "collection:first",
    toSkillId: "collection:second",
    relationType: "composes_with",
    reason: "These procedures compose at the documented handoff.",
    relationEvidence: [
      {
        skillId: "collection:first",
        filePath: "SKILL.md",
        startLine: 1,
        endLine: 2,
        quote: "First procedure",
      },
      {
        skillId: "collection:second",
        filePath: "SKILL.md",
        startLine: 3,
        endLine: 4,
        quote: "Second procedure",
      },
    ],
    dedupeKey: "relation",
    summary: "Connect the complementary procedures",
    evidence: ["Both skill documents were read"],
    correctionGoal: "Preserve a useful handoff",
    suggestedChange: "Create this relation",
  };

  it.each(["create", "update", "delete"] as const)(
    "persists a relation %s and graph receipt",
    async (operation) => {
      const finding = { ...relationFinding, operation };
      expect(
        await writer.record("relation", source, [finding], {
          changedRelationCount: 1,
          relationBatchId: "graph-batch-1",
          relationOutcome: "applied",
        }),
      ).toBe(true);
      const log = parseReviewLog(
        JSON.parse(fs.readFileSync(path.join(root, "review.json"), "utf8")),
      );
      expect(log.processedEvents.relation).toMatchObject({
        changeCount: 1,
        changes: [finding],
        changedRelationCount: 1,
        relationBatchId: "graph-batch-1",
        relationOutcome: "applied",
      });
      expect(log.processedEvents.relation?.changes?.[0]).not.toHaveProperty(
        "targetExperienceIds",
      );
    },
  );

  it("records only completed findings while preserving partial experience state and graph receipt", async () => {
    const completedExperience: ReviewFinding = {
      trigger: "capability-fit",
      targetKind: "skill-experience",
      operation: "refine",
      targetExperienceIds: ["complete-entry"],
      dedupeKey: "completed",
      summary: "Refine the completed entry",
      evidence: ["The completed file was reread"],
      correctionGoal: "Keep the completed refinement",
      suggestedChange: "Updated the experience",
    };
    expect(
      await writer.record(
        "partial",
        source,
        [relationFinding, completedExperience],
        {
          outcome: "partially-applied",
          changedRelationCount: 1,
          relationBatchId: "graph-batch-1",
          relationOutcome: "applied",
          experienceOutcome: "partial",
          changedExperienceIds: ["complete-entry", "incomplete-entry"],
          partialExperienceIds: ["incomplete-entry"],
          validationErrors: ["experience-write-failed"],
        },
      ),
    ).toBe(true);
    const log = parseReviewLog(
      JSON.parse(fs.readFileSync(path.join(root, "review.json"), "utf8")),
    );
    expect(log.processedEvents.partial).toMatchObject({
      outcome: "partially-applied",
      changeCount: 2,
      changes: [relationFinding, completedExperience],
      changedRelationCount: 1,
      relationBatchId: "graph-batch-1",
      experienceOutcome: "partial",
      changedExperienceIds: ["complete-entry", "incomplete-entry"],
      partialExperienceIds: ["incomplete-entry"],
    });
  });

  it("rejects malformed relation receipts without logging rejected evidence or values", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(
      await writer.record("invalid", source, [relationFinding], {
        changedRelationCount: 1,
        relationBatchId: "private-evidence-marker",
        relationOutcome: "aborted",
      }),
    ).toBe(false);
    expect(fs.existsSync(path.join(root, "review.json"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=operation-failed"),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private-evidence-marker",
    );
  });

  it("redacts write failures while retaining the atomic JSON writer", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const privateRoot = path.join(root, "private-write-error-marker");
    fs.mkdirSync(path.join(privateRoot, "review.json"), { recursive: true });
    expect(
      await new IntentReviewLogWriter(privateRoot).record(
        "write-failure",
        source,
        [],
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=invalid-file-type code=EISDIR"),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private-write-error-marker",
    );
    expect(fs.readdirSync(privateRoot)).toEqual(["review.json"]);
  });

  it("writes one v8 record for an applied review", async () => {
    const finding = {
      trigger: "capability-fit" as const,
      targetKind: "skill-experience" as const,
      operation: "refine" as const,
      targetExperienceIds: ["productivity"] as [string],
      dedupeKey: "deploy-flow",
      summary: "Reusable deployment flow",
      evidence: ["Five related tool calls"],
      correctionGoal: "Preserve deployment workflow",
      suggestedChange: "Updated productivity",
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
          changes: [{ targetKind: "skill-experience", operation: "refine" }],
        },
      },
    });
  });

  it.each(["create", "refine", "merge", "delete"] as const)(
    "persists %s metadata and preserves unclassified v8 history",
    async (operation) => {
      const finding: ReviewFinding = {
        trigger: "capability-fit",
        targetKind: "skill-experience",
        targetExperienceIds:
          operation === "merge" ? ["kept-entry", "old-entry"] : ["old-entry"],
        dedupeKey: "change",
        summary: "Reviewed experience",
        evidence: ["Verified file changes"],
        correctionGoal: "Keep useful guidance",
        suggestedChange: "Applied the declared operation",
        ...(operation === "merge"
          ? {
              operation,
              sourceExperienceIds: ["old-entry"],
              retainedExperienceId: "kept-entry",
            }
          : { operation }),
      };
      const oldChange = {
        trigger: finding.trigger,
        targetKind: finding.targetKind,
        targetExperienceIds: ["historical-entry"],
        dedupeKey: "historical",
        summary: finding.summary,
        evidence: finding.evidence,
        correctionGoal: finding.correctionGoal,
        suggestedChange: finding.suggestedChange,
      };
      const oldEvent = {
        processedAt: "2026-06-11T00:00:00.000Z",
        triggers: ["capability-fit"],
        changeCount: 1,
        outcome: "applied",
        changes: [oldChange],
      };
      const logPath = path.join(root, "review.json");
      fs.writeFileSync(
        logPath,
        JSON.stringify({
          schemaVersion: 8,
          createdAt: oldEvent.processedAt,
          updatedAt: oldEvent.processedAt,
          processedEvents: { old: oldEvent },
          reviewedSkillEpochs: {},
        }),
      );
      expect(
        await writer.record("new", source, [finding], {
          nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
          changedExperienceIds: finding.targetExperienceIds,
        }),
      ).toBe(true);
      const log = parseReviewLog(JSON.parse(fs.readFileSync(logPath, "utf8")));
      expect(log.processedEvents.old).toEqual(oldEvent);
      expect(log.processedEvents.new?.changes?.[0]).toEqual(finding);
      expect(log.processedEvents.new?.changedExperienceIds).toEqual(
        finding.targetExperienceIds,
      );
    },
  );

  it("preserves legacy v8 audit history and epoch deduplication when recording a new event", async () => {
    const prior = {
      processedAt: "2026-06-11T00:00:00.000Z",
      triggers: ["intent-health-check"],
      changeCount: 1,
      outcome: "applied",
      changedIntentIds: ["build"],
      changes: [
        {
          trigger: "intent-health-check",
          targetKind: "intent-markdown",
          operation: "refine",
          targetIntentIds: ["build"],
          dedupeKey: "refine-build",
          summary: "Refine build workflow",
          evidence: ["Verified command"],
          correctionGoal: "Use current command",
          suggestedChange: "Update body",
        },
      ],
    };
    const epochKey = "a".repeat(64);
    const reviewedSkillEpochs = {
      [epochKey]: {
        agentId: "main",
        skillName: "writer",
        source: "workspace",
        reason: "low-adoption",
        completedAt: "2026-06-11T00:00:00.000Z",
        outcome: "nofinding",
        eventId: "prior",
      },
    };
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        schemaVersion: 8,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: { prior },
        reviewedSkillEpochs,
      }),
    );
    expect(writer.completedSkillEpochKeys()).toEqual(new Set([epochKey]));
    expect(
      await writer.record("next", source, [], {
        triggers: ["experience-health-check"],
        nowMs: Date.parse("2026-06-11T00:01:00.000Z"),
      }),
    ).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8"));
    expect(persisted.processedEvents.prior).toEqual(prior);
    expect(persisted.reviewedSkillEpochs).toEqual(reviewedSkillEpochs);
    expect(persisted.processedEvents.next).toBeDefined();
  });

  it("replaces a legacy review log before recording a new event", async () => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        schemaVersion: 7,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        processedEvents: { prior: {} },
        reviewedSkillEpochs: {},
      }),
    );

    expect(
      await writer.record("next", source, [], {
        triggers: ["experience-health-check"],
      }),
    ).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(logPath, "utf8"));
    expect(persisted).toMatchObject({ schemaVersion: 8 });
    expect(persisted.processedEvents).not.toHaveProperty("prior");
    expect(persisted.processedEvents.next.triggers).toEqual([
      "experience-health-check",
    ]);
  });

  it.each([
    ["malformed", "{ broken"],
    ["unsupported schema", JSON.stringify({ schemaVersion: 5 })],
  ])("replaces %s review.json with a fresh v8 log", async (_name, original) => {
    const logPath = path.join(root, "review.json");
    fs.writeFileSync(logPath, original);
    await expect(writer.record("event-1", source, [])).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(logPath, "utf8"))).toMatchObject({
      schemaVersion: 8,
      processedEvents: { "event-1": expect.any(Object) },
    });
  });
});
