import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { checkReviewTriggers } from "./triggers.js";
import type { SessionState } from "../session/index.js";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    input: "Please do this",
    intent: {
      result: {
        intent: "CODE_REVIEW",
        reason: "test",
        confidence: 0.9,
        complexity: "medium",
      },
    },
    ...overrides,
  };
}

describe("checkReviewTriggers", () => {
  const triggers = resolveConfig({}).review.triggers;

  it("runs the health check only at its configured cadence", () => {
    expect(checkReviewTriggers(state(), 9, triggers)).not.toContain(
      "intent-health-check",
    );
    expect(checkReviewTriggers(state(), 10, triggers)).toContain(
      "intent-health-check",
    );
    expect(checkReviewTriggers(state(), 20, triggers)).toContain(
      "intent-health-check",
    );
  });

  it("treats fallback and below-threshold confidence as routing uncertainty", () => {
    expect(
      checkReviewTriggers(
        state({
          intent: {
            result: {
              intent: "other",
              reason: "unclear",
              confidence: 0.9,
              complexity: "high",
            },
          },
        }),
        1,
        triggers,
      ),
    ).toContain("routing-uncertainty");

    expect(
      checkReviewTriggers(
        state({
          intent: {
            result: {
              intent: "CODE_REVIEW",
              reason: "weak match",
              confidence: 0.49,
              complexity: "medium",
            },
          },
        }),
        1,
        triggers,
      ),
    ).toContain("routing-uncertainty");

    expect(
      checkReviewTriggers(
        state({
          intent: {
            result: {
              intent: "CODE_REVIEW",
              reason: "threshold match",
              confidence: 0.5,
              complexity: "medium",
            },
          },
        }),
        1,
        triggers,
      ),
    ).not.toContain("routing-uncertainty");
  });

  it("selects capability fit from either tool-volume or tool-failure evidence", () => {
    expect(
      checkReviewTriggers(
        state({
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
        }),
        1,
        triggers,
      ),
    ).toContain("capability-fit");

    expect(
      checkReviewTriggers(
        state({
          toolCalls: [
            { name: "first", params: {}, error: "failed" },
            { name: "second", params: {}, error: "failed" },
          ],
        }),
        1,
        triggers,
      ),
    ).toContain("capability-fit");
  });

  it("keeps trigger decisions deterministic and independently configurable", () => {
    const custom = resolveConfig({
      review: {
        triggers: {
          intentHealthCheck: { everyTurns: 3 },
          routingUncertainty: { confidenceBelow: 0.95 },
          capabilityFit: { toolCalls: 2, toolFailures: 1 },
        },
      },
    }).review.triggers;

    expect(
      checkReviewTriggers(
        state({
          toolCalls: [
            { name: "first", params: {} },
            { name: "second", params: {}, error: "failed" },
          ],
        }),
        3,
        custom,
      ),
    ).toEqual(["intent-health-check", "routing-uncertainty", "capability-fit"]);
  });

  it("does not schedule disabled trigger classes", () => {
    const disabled = resolveConfig({
      review: {
        triggers: {
          intentHealthCheck: { enabled: false },
          routingUncertainty: { enabled: false },
          capabilityFit: { enabled: false },
        },
      },
    }).review.triggers;

    expect(
      checkReviewTriggers(
        state({
          intent: {
            result: {
              intent: "other",
              reason: "unclear",
              confidence: 0.1,
              complexity: "medium",
            },
          },
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
        }),
        10,
        disabled,
      ),
    ).toEqual([]);
  });
});
