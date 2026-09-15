import { describe, expect, it } from "vitest";
import { selectSkillCandidates } from "./candidate-pool.js";

const skills = [
  { name: "alpha", description: "Alpha", location: "" },
  { name: "beta", description: "Beta", location: "" },
];

describe("selectSkillCandidates", () => {
  it("keeps the strongest visible evidence and sorts ties canonically", () => {
    const result = selectSkillCandidates({
      visibleSkills: skills,
      candidates: [
        { skillName: "BETA", score: 0.6, source: "name-match" },
        { skillName: "alpha", score: 0.6, source: "direct-retrieval" },
        { skillName: "beta", score: 0.8, source: "direct-retrieval" },
        { skillName: "hidden", score: 1, source: "name-match" },
      ],
      options: {
        maxInjectedSkills: 4,
        minInjectionScore: 0.3,
      },
    });
    expect(result.pool).toEqual([
      expect.objectContaining({ skillName: "beta", score: 0.8 }),
      expect.objectContaining({ skillName: "alpha", score: 0.6 }),
    ]);
    expect(result.selectedSkills.map((skill) => skill.name)).toEqual([
      "beta",
      "alpha",
    ]);
  });

  it("sorts canonical identity ties without re-normalizing candidate names", () => {
    const result = selectSkillCandidates({
      visibleSkills: skills,
      candidates: [
        { skillName: "BETA", score: 0.6, source: "name-match" },
        { skillName: "ALPHA", score: 0.6, source: "name-match" },
      ],
      options: { maxInjectedSkills: 4, minInjectionScore: 0 },
    });

    expect(result.pool.map((candidate) => candidate.skillName)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("preserves all deduplicated candidates while limiting injected skills", () => {
    const result = selectSkillCandidates({
      visibleSkills: skills,
      candidates: [
        { skillName: "alpha", score: 0.9, source: "name-match" },
        { skillName: "beta", score: 0.2, source: "direct-retrieval" },
      ],
      options: { maxInjectedSkills: 1, minInjectionScore: 0.1 },
    });
    expect(result.pool.map((candidate) => candidate.skillName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.selectedSkills.map((skill) => skill.name)).toEqual(["alpha"]);
  });
});
