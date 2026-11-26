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
    toolCalls: [{ name: "read", params: { path: "x" }, success: true }],
  },
  recent: [],
};

describe("formatReviewSnapshot", () => {
  it("renders the current turn and selected skills", () => {
    const output = formatReviewSnapshot(snapshot);

    expect(output).toContain('"matchedSkills":["git-tools"]');
    expect(output).not.toContain("<available_skills>");
    expect(output).toContain("<current_turn>");
  });

  it("renders manifest with turn counts", () => {
    const output = formatReviewSnapshot(snapshot);

    expect(output).toContain('"recentTurnCount":0');
    expect(output).toContain('"currentToolCallCount":1');
    expect(output).not.toContain("availableSkillCount");
  });

  it("escapes user-controlled snapshot text", () => {
    const output = formatReviewSnapshot({
      ...snapshot,
      current: { ...snapshot.current, input: "<unsafe & value>" },
    });

    expect(output).toContain("&lt;unsafe &amp; value&gt;");
  });
});
