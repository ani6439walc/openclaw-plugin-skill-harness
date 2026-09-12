import { describe, expect, it } from "vitest";
import { formatReviewSnapshot } from "./snapshot-formatter.js";
import type { ReviewSnapshot } from "./types.js";

const snapshot: ReviewSnapshot = {
  sessionId: "session",
  eventId: "event",
  turnNumber: 1,
  current: {
    input: "Need a review",
    intent: {
      intent: "other",
      domain: "other",
      confidence: 0.2,
      reason: "fallback",
    },
    routeProvenance: { trigger: "qmd-keyword" },
    toolCalls: [{ name: "read", params: { path: "x" }, success: true }],
  },
  recent: [],
  intentCatalog: [
    {
      id: "other",
      domain: "other",
      triggers: ["unmatched"],
      examples: ["help"],
      keywords: ["help"],
    },
    {
      id: "code-review",
      domain: "development",
      triggers: ["review code"],
      examples: ["review this"],
      keywords: ["review"],
    },
  ],
};

describe("formatReviewSnapshot", () => {
  it("renders route provenance with current-turn evidence", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["routing-uncertainty"],
    });

    expect(output).toContain('"routeProvenance":"qmd-keyword"');
    expect(output).toContain('"intentConfidence":0.2');
  });

  it("renders the full catalog for boundary-aware review triggers", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["routing-uncertainty"],
    });

    expect(output).toContain("<intent_catalog>");
    expect(output).toContain('"id":"code-review"');
    expect(output).toContain('"intentCatalog":"full"');
  });

  it("renders the catalog for a health check", () => {
    const output = formatReviewSnapshot(snapshot, {
      requestedTriggers: ["intent-health-check"],
    });

    expect(output).toContain("<intent_catalog>");
    expect(output).toContain('"intentCatalog":"full"');
  });

  it("escapes user-controlled snapshot text", () => {
    const output = formatReviewSnapshot(
      {
        ...snapshot,
        current: { ...snapshot.current, input: "<unsafe & value>" },
      },
      { requestedTriggers: ["intent-health-check"] },
    );

    expect(output).toContain("&lt;unsafe &amp; value&gt;");
  });
});
