import { describe, expect, it } from "vitest";
import { isRelationReviewDue } from "./triggers.js";

describe("relation review cadence", () => {
  it("selects positive multiples of the configured eligible-turn interval", () => {
    expect(
      [0, 1, 9, 10, 11, 20].filter((turn) => isRelationReviewDue(turn, 10)),
    ).toEqual([10, 20]);
    expect([1, 2, 3, 4].filter((turn) => isRelationReviewDue(turn, 2))).toEqual(
      [2, 4],
    );
  });
});
