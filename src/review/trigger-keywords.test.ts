import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_TRIGGER_KEYWORDS,
  mergeReviewTriggerKeywordSeeds,
  normalizeReviewTriggerKeywords,
  normalizeKeywordList,
} from "./trigger-keywords.js";

describe("review trigger keyword normalization", () => {
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
      entityContext: ["先看"],
    };

    expect(
      normalizeReviewTriggerKeywords(
        { behaviorFix: [" retry ", "RETRY"] },
        fallback,
      ),
    ).toEqual({
      behaviorFix: ["RETRY"],
      successfulPattern: ["done"],
      entityContext: ["先看"],
    });
  });

  it("keeps explicit empty trigger keyword arrays instead of falling back", () => {
    expect(
      normalizeReviewTriggerKeywords({
        behaviorFix: [],
        successfulPattern: [],
        entityContext: [],
      }),
    ).toEqual({
      behaviorFix: [],
      successfulPattern: [],
      entityContext: [],
    });
  });

  it("includes default entity-context learning keywords", () => {
    expect(DEFAULT_REVIEW_TRIGGER_KEYWORDS.entityContext).toEqual(
      expect.arrayContaining(["看看", "看一下", "看下"]),
    );
  });

  it("falls back to default trigger keywords for malformed root input", () => {
    expect(normalizeReviewTriggerKeywords("not an object")).toEqual(
      DEFAULT_REVIEW_TRIGGER_KEYWORDS,
    );
  });

  it("merges keyword seeds without replacing omitted fields", () => {
    expect(
      mergeReviewTriggerKeywordSeeds(
        {
          behaviorFix: ["wrong"],
          successfulPattern: ["done"],
          entityContext: ["先看"],
        },
        { successfulPattern: "ship it", entityContext: ["看看"] },
      ),
    ).toEqual({
      behaviorFix: ["wrong"],
      successfulPattern: ["ship it"],
      entityContext: ["看看"],
    });
  });
});
