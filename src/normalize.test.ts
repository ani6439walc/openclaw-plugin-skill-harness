import { describe, expect, it } from "vitest";
import {
  canonicalIdentity,
  normalizeForComparison,
  normalizeForKeyword,
  roundToDecimals,
  roundToThreeDecimals,
  roundToTwoDecimals,
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

  it("rounds numeric values to specified decimal places (default: 2)", () => {
    expect(roundToDecimals(0.7688711881637573)).toBe(0.77);
    expect(roundToDecimals(0.7688711881637573, 1)).toBe(0.8);
    expect(roundToDecimals(0.7688711881637573, 3)).toBe(0.769);
    expect(roundToDecimals(0.7688711881637573, 4)).toBe(0.7689);
    expect(roundToDecimals(12.3456, 0)).toBe(12);
  });

  it("rounds numeric confidence to 2 decimal places via wrapper", () => {
    expect(roundToTwoDecimals(0.7688711881637573)).toBe(0.77);
    expect(roundToTwoDecimals(0.954)).toBe(0.95);
    expect(roundToTwoDecimals(0.955)).toBe(0.96);
    expect(roundToTwoDecimals(1)).toBe(1);
    expect(roundToTwoDecimals(0)).toBe(0);
  });
});
