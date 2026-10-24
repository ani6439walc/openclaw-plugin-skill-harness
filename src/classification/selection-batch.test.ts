import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import {
  buildSelectionBatch,
  parseSelectionResult,
} from "./selection-batch.js";

const input = {
  latest: "Review the change",
  candidateSkills: [
    { name: "z", location: "/z", description: "Review changes" },
    { name: "A", location: "/a", description: "Check changes" },
  ],
};

describe("shared selection batch", () => {
  it("builds independent Boolean questions and preserves candidate evidence", () => {
    const batch = buildSelectionBatch(input);
    expect(Object.keys(batch.questions)).toEqual(["skill_z", "skill_A"]);
    expect(batch.questions.skill_z).toMatchObject({ type: "boolean" });
    expect(batch.state).toMatchObject({
      latest_message: input.latest,
      skill_candidates: [
        { name: "z", description: "Review changes", sources: [] },
        { name: "A", description: "Check changes", sources: [] },
      ],
    });
  });

  it("applies the existing threshold and UTF-16 tie break to canonical answers", () => {
    const result = parseSelectionResult(input, resolveConfig({}), {
      answers: {
        skill_z: { type: "boolean", probabilityTrue: 0.9 },
        skill_A: { type: "boolean", probabilityTrue: 0.9 },
      },
    });
    expect(result?.skills).toEqual(["A", "z"]);
    expect(result?.confidence).toBe(0.9);
  });

  it.each([
    {},
    { skill_z: { type: "boolean", probabilityTrue: 0.9 } },
    {
      skill_z: { type: "boolean", probabilityTrue: NaN },
      skill_A: { type: "boolean", probabilityTrue: 0.9 },
    },
    {
      skill_z: { type: "boolean", probabilityTrue: 1.1 },
      skill_A: { type: "boolean", probabilityTrue: 0.9 },
    },
    {
      skill_z: { type: "noul", noul: 0.9 },
      skill_A: { type: "boolean", probabilityTrue: 0.9 },
    },
    {
      skill_z: { type: "boolean", probabilityTrue: 0.9 },
      skill_A: { type: "boolean", probabilityTrue: 0.9 },
      invented: { type: "boolean", probabilityTrue: 1 },
    },
  ])(
    "rejects the entire selection for incomplete or invalid answers",
    (answers) => {
      expect(
        parseSelectionResult(input, resolveConfig({}), { answers }),
      ).toBeUndefined();
    },
  );
});
