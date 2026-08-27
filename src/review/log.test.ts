import { describe, expect, it } from "vitest";
import { parseReviewLogV7 } from "./log.js";

describe("review log", () => {
  it("keeps a strict v7 audit contract", () => {
    expect(
      parseReviewLogV7({
        schemaVersion: 7,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
      }),
    ).toMatchObject({ schemaVersion: 7, historicalKeywordAudits: {} });
    expect(() =>
      parseReviewLogV7({
        schemaVersion: 7,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        processedEvents: {},
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
        triggerKeywords: {},
      }),
    ).toThrow();
  });

  it("rejects keyword changes from mutable v7 processed events", () => {
    expect(() =>
      parseReviewLogV7({
        schemaVersion: 7,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
        processedEvents: {
          event: {
            processedAt: "2026-06-11T00:01:00.000Z",
            triggers: ["successful-pattern"],
            changeCount: 1,
            outcome: "applied",
            changes: [
              {
                trigger: "successful-pattern",
                targetKind: "trigger-keywords",
                operation: "adjust-trigger-keywords",
                targetIntentIds: [],
                targetTrigger: "successful-pattern",
                keywordChange: { add: ["ship it"], remove: [] },
                dedupeKey: "keyword-change",
                summary: "keyword change",
                evidence: ["evidence"],
                correctionGoal: "goal",
                suggestedChange: "change keyword",
              },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it("records create-only skill experiences in mutable v7 events", () => {
    const parsed = parseReviewLogV7({
      schemaVersion: 7,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      reviewedSkillEpochs: {},
      historicalKeywordAudits: {},
      processedEvents: {
        event: {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["successful-pattern"],
          changeCount: 1,
          outcome: "applied",
          changedExperienceIds: ["gitea/comment-contract"],
          changes: [
            {
              trigger: "successful-pattern",
              targetKind: "skill-experience",
              operation: "create",
              targetIntentIds: [],
              targetExperienceIds: ["gitea/comment-contract"],
              dedupeKey: "gitea-comment-contract",
              summary: "Capture the comment command contract",
              evidence: ["The current turn successfully used the skill."],
              correctionGoal: "Preserve the reusable workflow",
              suggestedChange: "Create the experience.",
            },
          ],
        },
      },
    });

    expect(parsed.processedEvents.event?.changedExperienceIds).toEqual([
      "gitea/comment-contract",
    ]);
  });

  it("rejects keyword operations disguised as intent changes in mutable v7 events", () => {
    expect(() =>
      parseReviewLogV7({
        schemaVersion: 7,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        reviewedSkillEpochs: {},
        historicalKeywordAudits: {},
        processedEvents: {
          event: {
            processedAt: "2026-06-11T00:01:00.000Z",
            triggers: ["skill-candidate"],
            changeCount: 1,
            outcome: "applied",
            changes: [
              {
                trigger: "skill-candidate",
                targetKind: "intent-markdown",
                operation: "adjust-trigger-keywords",
                targetIntentIds: ["intent-a"],
                dedupeKey: "disguised-keyword-change",
                summary: "invalid operation",
                evidence: ["evidence"],
                correctionGoal: "goal",
                suggestedChange: "invalid keyword operation",
              },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it("preserves migrated keyword audit records outside mutable v7 events", () => {
    const parsed = parseReviewLogV7({
      schemaVersion: 7,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      processedEvents: {},
      reviewedSkillEpochs: {},
      historicalKeywordAudits: {
        "v5:event": {
          processedAt: "2026-06-11T00:01:00.000Z",
          triggers: ["successful-pattern"],
          changeCount: 1,
          outcome: "applied",
          changes: [
            {
              trigger: "successful-pattern",
              targetKind: "trigger-keywords",
              operation: "adjust-trigger-keywords",
              targetIntentIds: [],
              targetTrigger: "successful-pattern",
              keywordChange: { add: ["ship it"], remove: [] },
              dedupeKey: "keyword-change",
              summary: "keyword change",
              evidence: ["evidence"],
              correctionGoal: "goal",
              suggestedChange: "change keyword",
            },
          ],
        },
      },
    });

    expect(parsed.historicalKeywordAudits["v5:event"]).toMatchObject({
      changes: [{ targetKind: "trigger-keywords" }],
    });
  });

  it("keeps keyword-only evidence out of mutable v7 events and in history", () => {
    const base = {
      schemaVersion: 7,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      reviewedSkillEpochs: {},
    };
    const noFindingKeywordEvent = {
      processedAt: "2026-06-11T00:01:00.000Z",
      triggers: ["successful-pattern"],
      changeCount: 0,
      outcome: "nofinding",
    };
    const intentEvent = {
      processedAt: "2026-06-11T00:01:00.000Z",
      triggers: ["skill-candidate"],
      changeCount: 0,
      outcome: "nofinding",
    };

    expect(() =>
      parseReviewLogV7({
        ...base,
        processedEvents: { event: noFindingKeywordEvent },
        historicalKeywordAudits: {},
      }),
    ).toThrow();
    expect(() =>
      parseReviewLogV7({
        ...base,
        processedEvents: {},
        historicalKeywordAudits: { event: intentEvent },
      }),
    ).toThrow();
  });
});
