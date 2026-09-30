import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { checkReviewTriggers } from "./triggers.js";

describe("checkReviewTriggers", () => {
  const triggers = resolveConfig({}).review.triggers;

  it("runs the health check only at its configured cadence", () => {
    expect(checkReviewTriggers({}, 9, triggers)).not.toContain(
      "experience-health-check",
    );
    expect(checkReviewTriggers({}, 10, triggers)).toContain(
      "experience-health-check",
    );
    expect(checkReviewTriggers({}, 20, triggers)).toContain(
      "experience-health-check",
    );
  });

  it("treats below-threshold confidence as routing uncertainty", () => {
    expect(checkReviewTriggers({ confidence: 0.49 }, 1, triggers)).toContain(
      "routing-uncertainty",
    );

    expect(checkReviewTriggers({ confidence: 0.5 }, 1, triggers)).not.toContain(
      "routing-uncertainty",
    );
  });

  it("selects capability fit from either tool-volume or tool-failure evidence", () => {
    expect(
      checkReviewTriggers(
        {
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
          })),
        },
        1,
        triggers,
      ),
    ).toContain("capability-fit");

    expect(
      checkReviewTriggers(
        {
          toolCalls: [
            { name: "first", error: "failed" },
            { name: "second", error: "failed" },
          ],
        },
        1,
        triggers,
      ),
    ).toContain("capability-fit");
  });

  it("keeps trigger decisions deterministic and independently configurable", () => {
    const custom = resolveConfig({
      review: {
        triggers: {
          experienceHealthCheck: { everyTurns: 3 },
          routingUncertainty: { confidenceBelow: 0.95 },
          capabilityFit: { toolCalls: 2, toolFailures: 1 },
        },
      },
    }).review.triggers;

    expect(
      checkReviewTriggers(
        {
          confidence: 0.5,
          toolCalls: [{ name: "first" }, { name: "second", error: "failed" }],
        },
        3,
        custom,
      ),
    ).toEqual([
      "experience-health-check",
      "routing-uncertainty",
      "capability-fit",
    ]);
  });

  it("does not schedule disabled trigger classes", () => {
    const disabled = resolveConfig({
      review: {
        triggers: {
          experienceHealthCheck: { enabled: false },
          routingUncertainty: { enabled: false },
          capabilityFit: { enabled: false },
        },
      },
    }).review.triggers;

    expect(
      checkReviewTriggers(
        {
          confidence: 0.1,
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
          })),
        },
        10,
        disabled,
      ),
    ).toEqual([]);
  });
});
