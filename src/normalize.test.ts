import { describe, expect, it } from "vitest";
import {
  canonicalIdentity,
  normalizeForComparison,
  normalizeForKeyword,
  roundToThreeDecimals,
} from "./normalize.js";

describe("normalization helpers", () => {
  it("normalizes compatibility forms and casing for identities", () => {
    expect(canonicalIdentity("  Ｓｋｉｌｌ　Name  ")).toBe("skill name");
  });

  it("collapses Unicode whitespace for comparison", () => {
    expect(normalizeForComparison("\u2003Skill\n\u00a0Harness\t")).toBe(
      "skill harness",
    );
  });

  it("removes Unicode whitespace for keyword matching", () => {
    expect(normalizeForKeyword("Ｓｋｉｌｌ\u2003Harness")).toBe("skillharness");
  });

  it("rounds numeric scores and differences to 3 decimal places to mitigate floating-point inaccuracies", () => {
    expect(roundToThreeDecimals(0.1234)).toBe(0.123);
    expect(roundToThreeDecimals(0.1236)).toBe(0.124);
    // IEEE 754 precision issue: 0.94 - 0.86 === 0.07999999999999996
    const diff = 0.94 - 0.86;
    expect(diff).toBeLessThan(0.08);
    expect(roundToThreeDecimals(diff)).toBe(0.08);
    expect(roundToThreeDecimals(diff) >= roundToThreeDecimals(0.08)).toBe(true);

    // Legitimate difference below threshold remains below threshold
    const smallDiff = 0.94 - 0.861; // 0.07899999999999996
    expect(roundToThreeDecimals(smallDiff)).toBe(0.079);
    expect(roundToThreeDecimals(smallDiff) >= roundToThreeDecimals(0.08)).toBe(
      false,
    );
  });
});
