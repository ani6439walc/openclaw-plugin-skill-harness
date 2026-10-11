import { describe, expect, it } from "vitest";
import { collectRelationEvidence, expandRelatedCandidates } from "./related.js";
import type { AvailableSkill, RelatedSkillResult } from "./types.js";
const skill = (name: string): AvailableSkill => ({
  name,
  location: `/skills/${name}/SKILL.md`,
  description: name,
});
const edge = (
  name: string,
  extra: Partial<RelatedSkillResult> = {},
): RelatedSkillResult => ({
  name,
  reason: "Author reason",
  direction: "current-to-related",
  relation_type: "depends_on",
  verification_status: "unverified",
  source: "author-import",
  ...extra,
});

describe("declared relation candidates", () => {
  it("round robins the first eight seeds, with two per seed and eight total", () => {
    const seeds = Array.from({ length: 10 }, (_, i) => skill(`seed${i}`));
    const targets = Array.from({ length: 30 }, (_, i) =>
      skill(`target${String(i).padStart(2, "0")}`),
    );
    const graph = new Map(
      seeds.map((s, i) => [
        s.name,
        targets
          .slice(i * 3, i * 3 + 3)
          .reverse()
          .map((t) => edge(t.name)),
      ]),
    );
    const result = expandRelatedCandidates(
      seeds,
      [...seeds, ...targets],
      graph,
    );
    expect(result.candidateSkills.slice(0, 10)).toEqual(seeds);
    expect(result.added).toEqual([
      "target00",
      "target03",
      "target06",
      "target09",
      "target12",
      "target15",
      "target18",
      "target21",
    ]);
    const small = expandRelatedCandidates(
      seeds.slice(0, 2),
      [...seeds, ...targets],
      graph,
    );
    expect(small.added).toEqual([
      "target00",
      "target03",
      "target01",
      "target04",
    ]);
  });
  it("keeps duplicates free, bounds evidence by code point, and never traverses newly added targets", () => {
    const seeds = [skill("alpha"), skill("beta")];
    const graph = new Map([
      [
        "alpha",
        [
          edge("beta"),
          edge("gamma", { reason: "😀".repeat(600) }),
          edge("delta"),
        ],
      ],
      ["beta", [edge("gamma"), edge("epsilon")]],
      ["gamma", [edge("zeta")]],
    ]);
    const result = expandRelatedCandidates(
      seeds,
      [...seeds, ...["gamma", "delta", "epsilon", "zeta"].map(skill)],
      graph,
    );
    expect(result.added).toEqual(["delta", "epsilon", "gamma"]);
    expect(result.evidence.filter((e) => e.name === "gamma")).toHaveLength(2);
    expect(
      Array.from(
        result.evidence.find((e) => e.name === "gamma" && e.from === "alpha")!
          .reason,
      ),
    ).toHaveLength(500);
    expect(result.added).not.toContain("zeta");
  });
  it("excludes incoming, reasonless, invisible and self edges", () => {
    const graph = new Map([
      [
        "alpha",
        [
          edge("alpha"),
          edge("beta", { direction: "related-to-current" }),
          edge("gamma", { reason: " " }),
          edge("hidden"),
        ],
      ],
    ]);
    expect(
      expandRelatedCandidates(
        [skill("alpha")],
        ["alpha", "beta", "gamma"].map(skill),
        graph,
      ).added,
    ).toEqual([]);
  });
});

describe("relation relevance evidence", () => {
  it("includes visible noncandidate descriptions and preserves incoming and outgoing directions", () => {
    const candidates = [skill("B")];
    const visible = [skill("A"), ...candidates, skill("C")];
    const evidence = collectRelationEvidence(
      candidates,
      visible,
      new Map([
        [
          "b",
          [
            edge("A", { direction: "related-to-current" }),
            edge("C", { relation_type: "composes_with" }),
          ],
        ],
      ]),
    );
    expect(evidence).toEqual([
      expect.objectContaining({
        skill: "B",
        from: "A",
        to: "B",
        from_description: "A",
        to_description: "B",
        relation_type: "depends_on",
      }),
      expect.objectContaining({
        skill: "B",
        from: "B",
        to: "C",
        from_description: "B",
        to_description: "C",
        relation_type: "composes_with",
      }),
    ]);
    expect(candidates.map((item) => item.name)).toEqual(["B"]);
  });

  it("does not expose invisible, self, reasonless or repeated relations", () => {
    const evidence = collectRelationEvidence(
      [skill("B")],
      [skill("A"), skill("B")],
      new Map([
        [
          "b",
          [
            edge("hidden"),
            edge("B"),
            edge("A", { reason: " " }),
            edge("A"),
            edge("A"),
          ],
        ],
      ]),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ skill: "B", from: "B", to: "A" });
  });

  it("bounds per-anchor and overall evidence and truncates Unicode by code point", () => {
    const candidates = Array.from({ length: 12 }, (_, index) =>
      skill(`seed${index}`),
    );
    const targets = Array.from({ length: 3 }, (_, index) => ({
      ...skill(`target${index}`),
      description: "😀".repeat(1100),
    }));
    const graph = new Map(
      candidates.map((candidate) => [
        candidate.name.toLowerCase(),
        targets.map((target) =>
          edge(target.name, { reason: "😀".repeat(600) }),
        ),
      ]),
    );
    const evidence = collectRelationEvidence(
      candidates,
      [...candidates, ...targets],
      graph,
    );
    expect(evidence).toHaveLength(16);
    for (const candidate of candidates) {
      expect(
        evidence.filter((item) => item.skill === candidate.name).length,
      ).toBeLessThanOrEqual(2);
    }
    expect(Array.from(evidence[0].reason)).toHaveLength(500);
    expect(Array.from(evidence[0].to_description)).toHaveLength(1000);
  });
});
