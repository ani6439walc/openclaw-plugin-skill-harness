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

  it("evaluates candidate experiences and forms union of skills with experience-associated skills", async () => {
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
    expect(result?.skills).toContain("git-tools");
    expect(result?.confidence).toBe(0.95);
    expect(result?.reason).toContain("git-merge-conflict");
  });
});
