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
  activeExperiences: [
    {
      id: "git-merge-conflict",
      skills: ["git-tools"],
      summary: "Resolve complex 3-way merge conflicts.",
      keywords: ["git", "merge", "conflict"],
      body: "Resolution steps",
      path: "/experiences/git-merge-conflict",
    },
  ],
};

describe("formatReviewSnapshot", () => {
  it("renders active experiences in snapshot", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["routing-uncertainty"],
    });

    expect(output).toContain("<active_experiences>");
    expect(output).toContain('"id":"git-merge-conflict"');
    expect(output).toContain("Resolve complex 3-way merge conflicts.");
  });

  it("renders manifest with experience counts", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["experience-health-check"],
    });

    expect(output).toContain('"activeExperienceCount":1');
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
