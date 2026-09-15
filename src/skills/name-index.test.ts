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

  it("preserves technical punctuation before tokenization", () => {
    expect(extractEnglishSegments("請用 c++ 或 c#")).toBe("c++ c#");
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

  it("rejects empty tokens from non-English input", () => {
    expect(tokenizeNameText("")).toEqual([]);
    expect(tokenizeNameText(extractEnglishSegments("幫我看看這個"))).toEqual(
      [],
    );
    expect(
      matchAvailableSkillNames({
        skills: [{ name: "go", description: "Go", location: "" }],
        input: "幫我看看這個",
        options,
      }),
    ).toEqual([]);
  });

  it("keeps technical token characters meaningful during typo matching", () => {
    expect(
      matchAvailableSkillNames({
        skills: [{ name: "s3", description: "S3", location: "" }],
        input: "s2",
        options: { ...options, maxEditDistance: 0 },
      }),
    ).toEqual([]);
    expect(
      matchAvailableSkillNames({
        skills: [{ name: "c++", description: "C++", location: "" }],
        input: "c#",
        options: { ...options, maxEditDistance: 0 },
      }),
    ).toEqual([]);
  });

  it("requires exact matches for short technical tokens", () => {
    expect(
      matchAvailableSkillNames({
        skills: [{ name: "db", description: "Database", location: "" }],
        input: "ui",
        options,
      }),
    ).toEqual([]);
    expect(
      matchAvailableSkillNames({
        skills: [
          { name: "typescript", description: "TypeScript", location: "" },
        ],
        input: "typescrpt",
        options,
      }),
    ).toEqual([expect.objectContaining({ skillName: "typescript" })]);
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
