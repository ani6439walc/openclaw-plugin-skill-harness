import { describe, expect, it } from "vitest";
import {
  canonicalIdentity,
  normalizeForComparison,
  normalizeForKeyword,
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
});
