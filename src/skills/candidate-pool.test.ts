import { describe, expect, it } from "vitest";
import {
  buildCandidateSkillsUnionPool,
  buildSkillCandidateSuperset,
  selectSkillCandidates,
} from "./candidate-pool.js";

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
      options: { maxInjectedSkills: 4 },
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
      options: { maxInjectedSkills: 1 },
    });
    expect(result.pool.map((candidate) => candidate.skillName)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.selectedSkills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("preserves collections and topCollection metadata on selected candidates", () => {
    const result = selectSkillCandidates({
      visibleSkills: skills,
      candidates: [
        {
          skillName: "alpha",
          score: 0.9,
          source: "direct-retrieval",
          collections: ["meta", "body"],
          topCollection: "meta",
        },
      ],
      options: { maxInjectedSkills: 1 },
    });
    expect(result.pool[0].collections).toEqual(["meta", "body"]);
    expect(result.pool[0].topCollection).toBe("meta");
  });
});

describe("buildCandidateSkillsUnionPool", () => {
  it("builds candidate skills from name, retrieval, and intent-matched sources without fallbackSkills", () => {
    const union = buildCandidateSkillsUnionPool({
      visibleSkills: skills,
      nameCandidates: [
        { skillName: "alpha", score: 0.9, source: "name-match" },
      ],
      retrievalCandidates: [
        { skillName: "beta", score: 0.8, source: "direct-retrieval" },
      ],
      intentMatchedSkillNames: ["alpha"],
    });

    expect(union.pool).toHaveLength(2);
    expect(union.candidateSkills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect((union as Record<string, unknown>).fallbackSkills).toBeUndefined();
  });
});

describe("buildSkillCandidateSuperset", () => {
  const gamma = { name: "gamma", description: "Gamma", location: "/gamma" };
  const delta = { name: "delta", description: "Delta", location: "/delta" };
  it("preserves ranked originals then visible related skills without fabricating scores", () => {
    const result = buildSkillCandidateSuperset({
      originals: [skills[1], skills[0]],
      nameCandidates: [
        { skillName: "ALPHA", score: 0.8, source: "name-match" },
      ],
      retrievalCandidates: [
        { skillName: "beta", score: 0.9, source: "direct-retrieval" },
        { skillName: "alpha", score: 0.7, source: "direct-retrieval" },
      ],
      expanded: [skills[0], gamma, delta],
      expandedNames: ["gamma", "delta"],
      visibleSkills: [...skills, gamma, delta],
      enabled: true,
    });
    expect(result.candidateSkills.map((skill) => skill.name)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "delta",
    ]);
    expect(result.candidateSources).toEqual({
      beta: ["direct-retrieval"],
      alpha: ["name-match", "direct-retrieval"],
      gamma: ["related-declared"],
      delta: ["related-declared"],
    });
    expect(result.candidateSkills).toEqual([
      skills[1],
      skills[0],
      gamma,
      delta,
    ]);
    expect(result.candidateSkills.every((skill) => !("score" in skill))).toBe(
      true,
    );
  });

  it("uses the winning visible skill for canonical expansion names and drops hidden endpoints", () => {
    const result = buildSkillCandidateSuperset({
      originals: [],
      nameCandidates: [],
      retrievalCandidates: [],
      expanded: [
        { ...gamma, name: "GAMMA", location: "/losing" },
        { ...delta, name: "hidden" },
      ],
      expandedNames: ["GAMMA", "hidden"],
      visibleSkills: [skills[0], gamma],
      enabled: true,
    });
    expect(result.candidateSkills).toEqual([gamma]);
    expect(result.candidateSources).toEqual({
      gamma: ["related-declared"],
    });
  });

  it("keeps the entire skill pool empty when skill discovery is disabled", () => {
    const result = buildSkillCandidateSuperset({
      originals: skills,
      nameCandidates: [{ skillName: "alpha", score: 1, source: "name-match" }],
      retrievalCandidates: [],
      expanded: [gamma],
      expandedNames: ["gamma"],
      visibleSkills: [...skills, gamma],
      enabled: false,
    });
    expect(result.candidateSkills).toEqual([]);
    expect(result.candidateSources).toEqual({});
  });
});
