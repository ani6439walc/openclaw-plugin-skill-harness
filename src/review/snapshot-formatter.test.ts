import { describe, expect, it } from "vitest";
import { formatReviewSnapshot } from "./snapshot-formatter.js";
import type { ReviewSnapshot } from "./types.js";

const snapshot: ReviewSnapshot = {
  sessionId: "session",
  eventId: "event",
  turnNumber: 1,
  current: {
    input: "Need a review",
    matchedSkills: ["git-tools"],
    matchedExperiences: ["git-merge-conflict"],
    toolCalls: [{ name: "read", params: { path: "x" }, success: true }],
  },
  recent: [],
};

describe("formatReviewSnapshot", () => {
  it("omits active_experiences and available_skills blocks from snapshot", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["routing-uncertainty"],
    });

    expect(output).not.toContain("<active_experiences>");
    expect(output).not.toContain("<available_skills>");
    expect(output).toContain("<current_turn>");
  });

  it("renders manifest with trigger and turn counts", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["experience-health-check"],
    });

    expect(output).toContain('"requestedTriggers":["experience-health-check"]');
    expect(output).toContain('"recentTurnCount":0');
    expect(output).toContain('"currentToolCallCount":1');
    expect(output).not.toContain("activeExperienceCount");
    expect(output).not.toContain("availableSkillCount");
  });

  it("escapes user-controlled snapshot text", () => {
    const output = formatReviewSnapshot(
      {
        ...snapshot,
        current: { ...snapshot.current, input: "<unsafe & value>" },
      },
      { requestedTriggers: ["experience-health-check"] },
    );

    expect(output).toContain("&lt;unsafe &amp; value&gt;");
  });
});
