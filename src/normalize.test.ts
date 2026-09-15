import { describe, expect, it } from "vitest";
import {
  canonicalIdentity,
  normalizeForComparison,
  normalizeForKeyword,
  roundToDecimals,
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

  it("rounds threshold comparisons to two decimal places", () => {
    expect(roundToDecimals(0.1234, 2)).toBe(0.12);
    expect(roundToDecimals(0.1236, 2)).toBe(0.12);

    // IEEE 754 precision issue: 0.94 - 0.86 === 0.07999999999999996
    const diff = 0.94 - 0.86;
    expect(diff).toBeLessThan(0.08);
    expect(roundToDecimals(diff, 2)).toBe(0.08);
    expect(roundToDecimals(diff, 2) >= roundToDecimals(0.08, 2)).toBe(true);

    // A value below the two-decimal threshold stays below it.
    const smallDiff = 0.94 - 0.866;
    expect(roundToDecimals(smallDiff, 2)).toBe(0.07);
    expect(roundToDecimals(smallDiff, 2) >= roundToDecimals(0.08, 2)).toBe(
      false,
    );
  });

  it("rounds numeric values to specified decimal places (default: 2)", () => {
    expect(roundToDecimals(0.7688711881637573, 2)).toBe(0.77);
    expect(roundToDecimals(0.7688711881637573, 1)).toBe(0.8);
    expect(roundToDecimals(0.7688711881637573, 3)).toBe(0.769);
    expect(roundToDecimals(0.7688711881637573, 4)).toBe(0.7689);
    expect(roundToDecimals(12.3456, 0)).toBe(12);
  });

  it("rounds numeric confidence to 2 decimal places", () => {
    expect(roundToDecimals(0.7688711881637573, 2)).toBe(0.77);
    expect(roundToDecimals(0.954, 2)).toBe(0.95);
    expect(roundToDecimals(0.955, 2)).toBe(0.96);
    expect(roundToDecimals(1, 2)).toBe(1);
    expect(roundToDecimals(0, 2)).toBe(0);
  });
});
