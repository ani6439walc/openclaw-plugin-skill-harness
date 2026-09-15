import { describe, expect, it } from "vitest";
import {
  extractEnglishSegments,
  matchAvailableSkillNames,
  tokenizeNameText,
} from "./name-index.js";

const skills = [
  { name: "code-review-and-quality", description: "Review code", location: "" },
  { name: "skill-harness", description: "Harness", location: "" },
];
const options = { maxEditDistance: 2, minJaccardScore: 0.5, genericTokens: [] };

describe("skill name matching", () => {
  it("extracts English segments from mixed input", () => {
    expect(extractEnglishSegments("幫我 code 的 review")).toBe("code review");
  });

  it("normalizes stop words while retaining short technical tokens", () => {
    expect(tokenizeNameText("code-review-and-quality")).toEqual([
      "code",
      "review",
      "quality",
    ]);
    expect(tokenizeNameText("js-ui-s3-and-db")).toEqual([
      "js",
      "ui",
      "s3",
      "db",
    ]);
  });

  it("matches skills made only of short technical tokens", () => {
    expect(
      matchAvailableSkillNames({
        skills: [{ name: "js-ui", description: "JavaScript UI", location: "" }],
        input: "js ui",
        options,
      }),
    ).toEqual([expect.objectContaining({ skillName: "js-ui", score: 1 })]);
  });

  it("matches token typos using classic Levenshtein", () => {
    const candidates = matchAvailableSkillNames({
      skills,
      input: "code rewiev",
      options,
    });
    expect(candidates).toEqual([
      expect.objectContaining({
        skillName: "code-review-and-quality",
        score: 2 / 3,
      }),
    ]);
  });

  it("rejects configured generic single-token input but permits multi-token input", () => {
    expect(
      matchAvailableSkillNames({
        skills,
        input: "review",
        options: { ...options, genericTokens: ["review"] },
      }),
    ).toEqual([]);
    expect(
      matchAvailableSkillNames({
        skills,
        input: "code review",
        options: { ...options, genericTokens: ["review"] },
      }),
    ).toHaveLength(1);
  });
});
