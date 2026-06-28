import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
  mergeEvolutionTriggerKeywordSeeds,
  normalizeEvolutionTriggerKeywords,
  normalizeKeywordList,
} from "./evolution-trigger-keywords.js";

describe("evolution trigger keyword normalization", () => {
  it("returns a fallback copy for missing or malformed keyword lists", () => {
    const fallback = ["fixed", "verified"];

    const missing = normalizeKeywordList(undefined, fallback);
    const malformed = normalizeKeywordList({ keyword: "fixed" }, fallback);

    expect(missing).toEqual(fallback);
    expect(missing).not.toBe(fallback);
    expect(malformed).toEqual(fallback);
    expect(malformed).not.toBe(fallback);
  });

  it("accepts a single string keyword", () => {
    expect(normalizeKeywordList(" ship it ", [])).toEqual(["ship it"]);
  });

  it("trims arrays, drops blank and non-string values, and deduplicates case-insensitively", () => {
    expect(
      normalizeKeywordList(
        [" Ship It ", "ship it", "SHIP IT", "", "  ", 42, "done"],
        [],
      ),
    ).toEqual(["SHIP IT", "done"]);
  });

  it("normalizes partial trigger keyword objects with per-field fallbacks", () => {
    const fallback = {
      behaviorFix: ["wrong"],
      successfulPattern: ["done"],
    };

    expect(
      normalizeEvolutionTriggerKeywords(
        { behaviorFix: [" retry ", "RETRY"] },
        fallback,
      ),
    ).toEqual({
      behaviorFix: ["RETRY"],
      successfulPattern: ["done"],
    });
  });

  it("keeps explicit empty trigger keyword arrays instead of falling back", () => {
    expect(
      normalizeEvolutionTriggerKeywords({
        behaviorFix: [],
        successfulPattern: [],
      }),
    ).toEqual({
      behaviorFix: [],
      successfulPattern: [],
    });
  });

  it("falls back to default trigger keywords for malformed root input", () => {
    expect(normalizeEvolutionTriggerKeywords("not an object")).toEqual(
      DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
    );
  });

  it("merges keyword seeds without replacing omitted fields", () => {
    expect(
      mergeEvolutionTriggerKeywordSeeds(
        {
          behaviorFix: ["wrong"],
          successfulPattern: ["done"],
        },
        { successfulPattern: "ship it" },
      ),
    ).toEqual({
      behaviorFix: ["wrong"],
      successfulPattern: ["ship it"],
    });
  });
});
