import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { runJevUnifiedRouting } from "./jev-client.js";
import type { AvailableSkill } from "../types.js";
import type { SkillExperienceEntry } from "../experiences/types.js";

describe("runJevUnifiedRouting", () => {
  const dummyApi = {
    config: {
      models: {
        providers: {
          typesafe: {
            baseUrl: "https://api.typesafe.ai/v1",
            apiKey: "test-key",
          },
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  const candidateSkills: AvailableSkill[] = [
    {
      name: "git-tools",
      location: "/skills/git-tools",
      description: "Git commands and repository management",
    },
    {
      name: "markdown-formatter",
      location: "/skills/markdown-formatter",
      description: "Format markdown files",
    },
  ];

  it("evaluates candidate skills with noul questions and selects qualifying skills", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      usage: { input_tokens: 10, output_tokens: 5 },
      answers: {
        "skill_git-tools": {
          type: "noul",
          noul: 0.85,
        },
        "skill_markdown-formatter": {
          type: "noul",
          noul: 0.3,
        },
      },
    });

    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({
        routing: {
          skills: { maxInjectedSkills: 2 },
        },
      }),
      agentId: "main",
      latest: "review my commit",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      client: mockClient,
    });

    expect(mockSystemOne).toHaveBeenCalledOnce();
    const callArgs = mockSystemOne.mock.calls[0][0];
    expect(callArgs.questions).toHaveProperty("skill_git-tools");
    expect(callArgs.questions).toHaveProperty("skill_markdown-formatter");
    expect(callArgs.questions).not.toHaveProperty("intent");

    expect(result).toEqual({
      skills: ["git-tools"],
      experiences: [],
      confidence: 0.85,
      reason: "jev → 1 skill: [git-tools]",
    });
  });

  it("passes unverified expansion evidence without forcing dependency selection", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { "skill_git-tools": { type: "noul", noul: 0.1 } },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "unrelated task",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: candidateSkills.slice(0, 1),
      relatedEvidence: [
        {
          name: "git-tools",
          from: "source",
          relation_type: "depends_on",
          verification_status: "unverified",
          reason: "conditional reason",
        },
      ],
      client: { systemOne } as unknown as TypeSafeClient,
    });
    expect(systemOne).toHaveBeenCalledOnce();
    expect(systemOne.mock.calls[0][0].state.skill_relations[0]).toMatchObject({
      relation_type: "depends_on",
      verification_status: "unverified",
    });
    expect(systemOne.mock.calls[0][0].state.skill_relation_guidance).toContain(
      "not instructions",
    );
    expect(systemOne.mock.calls[0][0].questions).not.toHaveProperty(
      "relation_0",
    );
    expect(result?.skills).toEqual([]);
    expect(result?.relationDecisions).toBeUndefined();
  });

  const relationEvidence = {
    skill: "git-tools",
    from: "outside-candidate-pool",
    to: "git-tools",
    from_description: "Noncandidate source description",
    to_description: "Git commands and repository management",
    relation_type: "depends_on" as const,
    verification_status: "unverified" as const,
    reason: "Author reason about repository preparation",
  };

  it("scores relation relevance in the same call without promoting skills or changing confidence", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.1 },
        relation_0: { type: "noul", noul: 0.99 },
      },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "unrelated task",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: candidateSkills.slice(0, 1),
      relationEvidence: [relationEvidence],
      client: { systemOne } as unknown as TypeSafeClient,
    });
    expect(systemOne).toHaveBeenCalledOnce();
    const input = systemOne.mock.calls[0][0];
    expect(input.questions).toHaveProperty("relation_0");
    expect(input.questions).not.toHaveProperty("skill_outside-candidate-pool");
    expect(input.state.skill_relation_evidence).toEqual([
      { id: "relation_0", ...relationEvidence },
    ]);
    expect(result?.skills).toEqual([]);
    expect(result?.confidence).toBe(0.1);
    expect(result?.relationDecisions).toEqual([
      { ...relationEvidence, score: 0.99, injected: false },
    ]);
  });

  it.each([
    undefined,
    { type: "noul", noul: NaN },
    { type: "noul", noul: 1.1 },
    { type: "noul", noul: -0.1 },
    { type: "noul", noul: "0.9" },
    { type: "bool", noul: 0.9 },
  ])(
    "rejects the entire selection for an invalid relation answer: %j",
    async (answer) => {
      const systemOne = vi.fn().mockResolvedValue({
        answers: {
          "skill_git-tools": { type: "noul", noul: 0.9 },
          relation_0: answer,
        },
      });
      const result = await runJevUnifiedRouting({
        api: dummyApi,
        config: resolveConfig({}),
        agentId: "main",
        latest: "review commit",
        modelRef: { provider: "typesafe", model: "jev-latest" },
        candidateSkills: candidateSkills.slice(0, 1),
        relationEvidence: [relationEvidence],
        client: { systemOne } as unknown as TypeSafeClient,
      });
      expect(result).toBeUndefined();
    },
  );

  it("scores all six relation types independently without using relation scores for ordering or caps", async () => {
    const labels = [
      "related",
      "depends_on",
      "composes_with",
      "similar_to",
      "conflicts_with",
      "specializes",
    ] as const;
    const evidence = labels.map((relation_type) => ({
      ...relationEvidence,
      relation_type,
    }));
    const answers = Object.fromEntries(
      evidence.map((_, index) => [
        `relation_${index}`,
        { type: "noul", noul: 1 },
      ]),
    );
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        ...answers,
        "skill_git-tools": { type: "noul", noul: 0.7 },
        "skill_markdown-formatter": { type: "noul", noul: 0.9 },
      },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({ routing: { skills: { maxInjectedSkills: 1 } } }),
      agentId: "main",
      latest: "format documentation",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      relationEvidence: evidence,
      client: { systemOne } as unknown as TypeSafeClient,
    });
    expect(result?.skills).toEqual(["markdown-formatter"]);
    expect(result?.confidence).toBe(0.9);
    expect(result?.relationDecisions).toHaveLength(6);
    expect(systemOne).toHaveBeenCalledOnce();
  });

  it("indexes candidate discovery sources, experience IDs and relations without exposing hidden associations", async () => {
    const experience: SkillExperienceEntry = {
      id: "git-review",
      skills: ["git-tools", "hidden"],
      summary: "Review repository state",
      keywords: ["review"],
      body: "Private full body",
      path: "/private/experience",
    };
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.2 },
        "skill_markdown-formatter": { type: "noul", noul: 0.9 },
        "exp_git-review": { type: "noul", noul: 0.95 },
        relation_0: { type: "noul", noul: 0.9 },
      },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "format repository documentation",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      candidateSources: {
        "git-tools": ["experience-associated"],
        "markdown-formatter": ["qmd", "name"],
      },
      candidateExperiences: [experience],
      relationEvidence: [relationEvidence],
      client: { systemOne } as unknown as TypeSafeClient,
    });
    const input = systemOne.mock.calls[0][0];
    expect(systemOne).toHaveBeenCalledOnce();
    expect(input.state.skill_candidates).toEqual([
      {
        name: "git-tools",
        description: candidateSkills[0].description,
        sources: ["experience-associated"],
        experience_ids: ["git-review"],
        relation_ids: ["relation_0"],
      },
      {
        name: "markdown-formatter",
        description: candidateSkills[1].description,
        sources: ["qmd", "name"],
        experience_ids: [],
        relation_ids: [],
      },
    ]);
    expect(input.state.experience_candidates).toEqual([
      {
        id: "git-review",
        summary: experience.summary,
        visible_associated_skills: ["git-tools"],
      },
    ]);
    expect(input.state.skill_relation_evidence).toEqual([
      { id: "relation_0", ...relationEvidence },
    ]);
    expect(JSON.stringify(input.state)).not.toContain("Private full body");
    expect(input.questions).not.toHaveProperty("skill_hidden");
    expect(result?.skills).toEqual(["markdown-formatter"]);
    expect(result?.experiences).toEqual(["git-review"]);
  });

  it("preserves visible experience associations in experiences-only routing without creating skill questions", async () => {
    const experience: SkillExperienceEntry = {
      id: "git-review",
      skills: ["git-tools", "hidden"],
      summary: "Review repository state",
      keywords: ["review"],
      body: "Private body",
      path: "/private/experience",
    };
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        "exp_git-review": { type: "noul", noul: 0.95 },
      },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({ routing: { skills: { maxInjectedSkills: 0 } } }),
      agentId: "main",
      latest: "review repository",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: [],
      visibleSkillNames: ["git-tools"],
      candidateExperiences: [experience],
      client: { systemOne } as unknown as TypeSafeClient,
    });
    const input = systemOne.mock.calls[0][0];
    expect(input.state.experience_candidates).toEqual([
      {
        id: "git-review",
        summary: experience.summary,
        visible_associated_skills: ["git-tools"],
      },
    ]);
    expect(Object.keys(input.questions)).toEqual(["exp_git-review"]);
    expect(result?.skills).toEqual([]);
    expect(result?.experiences).toEqual(["git-review"]);
  });

  it("uses canonical name as the stable tie break for equal directly scored skills", async () => {
    const tiedCandidates = [...candidateSkills].reverse();
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.9 },
        "skill_markdown-formatter": { type: "noul", noul: 0.9 },
      },
    });
    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "review documentation",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: tiedCandidates,
      client: { systemOne } as unknown as TypeSafeClient,
    });
    expect(result?.skills).toEqual(["git-tools", "markdown-formatter"]);
  });

  it("breaks equal skill and experience scores by locale-independent string order", async () => {
    for (const names of [
      ["ä", "z", "Z"],
      ["Z", "z", "ä"],
    ]) {
      const skills = names.map((name) => ({
        name,
        description: name,
        location: `/${name}`,
      }));
      const experiences: SkillExperienceEntry[] = names.map((id) => ({
        id,
        summary: id,
        skills: [],
        keywords: [],
        body: "",
        path: `/experiences/${id}`,
      }));
      const answers = Object.fromEntries(
        names.flatMap((name) => [
          [`skill_${name}`, { type: "noul", noul: 0.9 }],
          [`exp_${name}`, { type: "noul", noul: 0.9 }],
        ]),
      );
      const result = await runJevUnifiedRouting({
        api: dummyApi,
        config: resolveConfig({
          routing: {
            skills: { maxInjectedSkills: 2 },
            experiences: { maxInjectedExperiences: 2 },
          },
        }),
        agentId: "main",
        latest: "review documentation",
        modelRef: { provider: "typesafe", model: "jev-latest" },
        candidateSkills: skills,
        candidateExperiences: experiences,
        client: {
          systemOne: vi.fn().mockResolvedValue({ answers }),
        } as unknown as TypeSafeClient,
      });
      expect(result?.skills).toEqual(["Z", "z"]);
      expect(result?.experiences).toEqual(["Z", "z"]);
    }
  });

  it("respects maxInjectedSkills and sorts descending by probability", async () => {
    const skills: AvailableSkill[] = [
      { name: "skill-1", location: "/1", description: "Skill 1" },
      { name: "skill-2", location: "/2", description: "Skill 2" },
      { name: "skill-3", location: "/3", description: "Skill 3" },
    ];

    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      usage: { input_tokens: 20, output_tokens: 10 },
      answers: {
        "skill_skill-1": { type: "noul", noul: 0.6 },
        "skill_skill-2": { type: "noul", noul: 0.95 },
        "skill_skill-3": { type: "noul", noul: 0.8 },
      },
    });

    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({
        routing: {
          skills: { maxInjectedSkills: 2 },
        },
      }),
      agentId: "main",
      latest: "do something",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: skills,
      client: mockClient,
    });

    expect(result?.skills).toEqual(["skill-2", "skill-3"]);
    expect(result?.confidence).toBe(0.95);
    expect(result?.reason).toBe("jev → 2 skills: [skill-2, skill-3]");
  });

  it("returns early when no candidate questions exist", async () => {
    const mockSystemOne = vi.fn();
    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "empty candidates",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills: [],
      candidateExperiences: [],
      client: mockClient,
    });

    expect(mockSystemOne).not.toHaveBeenCalled();
    expect(result).toEqual({
      skills: [],
      experiences: [],
      confidence: 0.0,
      reason: "jev → no candidate questions to evaluate",
    });
  });

  it("fails open and returns undefined on client error", async () => {
    const mockSystemOne = vi
      .fn()
      .mockRejectedValue(new Error("API rate limit exceeded"));
    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "trigger error",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      client: mockClient,
    });

    expect(result).toBeUndefined();
  });

  it("fails closed when a skill answer is missing or malformed", async () => {
    const mockMissingSkill = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.8 },
        // skill_markdown-formatter is missing
      },
    });

    const resultMissing = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "review code",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      client: { systemOne: mockMissingSkill } as unknown as TypeSafeClient,
    });
    expect(resultMissing).toBeUndefined();

    // Invalid skill probability values
    const invalidProbCases = [NaN, Infinity, -0.1, 1.5, "high" as never];
    for (const badProb of invalidProbCases) {
      const mockBadProb = vi.fn().mockResolvedValue({
        model: "typesafe/jev-latest",
        answers: {
          "skill_git-tools": { type: "noul", noul: badProb },
          "skill_markdown-formatter": { type: "noul", noul: 0.1 },
        },
      });

      const res = await runJevUnifiedRouting({
        api: dummyApi,
        config: resolveConfig({}),
        agentId: "main",
        latest: "review code",
        modelRef: { provider: "typesafe", model: "jev-latest" },
        candidateSkills,
        client: { systemOne: mockBadProb } as unknown as TypeSafeClient,
      });
      expect(res).toBeUndefined();
    }
  });

  it("fails closed when response structure is invalid", async () => {
    const invalidResponses = [
      null,
      undefined,
      {},
      { answers: null },
      { answers: "invalid" },
    ];

    for (const badResponse of invalidResponses) {
      const mockBad = vi.fn().mockResolvedValue(badResponse);
      const res = await runJevUnifiedRouting({
        api: dummyApi,
        config: resolveConfig({}),
        agentId: "main",
        latest: "review code",
        modelRef: { provider: "typesafe", model: "jev-latest" },
        candidateSkills,
        client: { systemOne: mockBad } as unknown as TypeSafeClient,
      });
      expect(res).toBeUndefined();
    }
  });

  it("respects plugin-level qmd.jev overrides (e.g. baseUrl, apiKey, model)", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-custom",
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.8 },
        "skill_markdown-formatter": { type: "noul", noul: 0.2 },
      },
    });

    const config = resolveConfig({
      qmd: {
        jev: {
          baseUrl: "https://custom-proxy.internal/v1",
          apiKey: "custom-proxy-key",
          model: "typesafe/jev-custom",
        },
      },
    });

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config,
      agentId: "main",
      latest: "review code",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      client: { systemOne: mockSystemOne } as unknown as TypeSafeClient,
    });

    expect(result).toBeDefined();
    expect(result?.skills).toEqual(["git-tools"]);
  });

  it("scores associated skills independently instead of automatically selecting them with an experience", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      usage: { input_tokens: 30, output_tokens: 15 },
      answers: {
        "skill_git-tools": { type: "noul", noul: 0.2 },
        "skill_markdown-formatter": { type: "noul", noul: 0.8 },
        "exp_git-merge-conflict": { type: "noul", noul: 0.95 },
        "exp_unused-exp": { type: "noul", noul: 0.1 },
      },
    });

    const candidateExperiences: SkillExperienceEntry[] = [
      {
        id: "git-merge-conflict",
        skills: ["git-tools"],
        summary: "Resolve complex 3-way git merge conflicts.",
        keywords: ["merge", "conflict"],
        body: "Merge conflict steps",
        path: "/mock/exp1",
      },
      {
        id: "unused-exp",
        skills: ["other-skill"],
        summary: "Unused procedure",
        keywords: ["unused"],
        body: "Unused",
        path: "/mock/exp2",
      },
    ];

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "fix my merge conflict and format docs",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateSkills,
      candidateExperiences,
      client: { systemOne: mockSystemOne } as unknown as TypeSafeClient,
    });

    expect(result).toBeDefined();
    expect(result?.experiences).toEqual(["git-merge-conflict"]);
    expect(result?.skills).toContain("markdown-formatter");
    expect(result?.skills).not.toContain("git-tools");
    expect(result?.confidence).toBe(0.95);
    expect(result?.reason).toContain("git-merge-conflict");
  });
});
