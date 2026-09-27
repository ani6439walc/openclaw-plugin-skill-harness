import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { runJevUnifiedRouting } from "./jev-client.js";
import { runUnifiedRoutingSubagent } from "./subagent.js";
import type { AvailableSkill, IntentCatalogEntry } from "../types.js";

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

  const candidateIntents: IntentCatalogEntry[] = [
    {
      id: "code-review",
      definition: {
        triggers: ["review code"],
        examples: ["please review this pr"],
        guidance: "Review code thoroughly for bugs.",
      },
    },
    {
      id: "documentation",
      definition: {
        triggers: ["write docs"],
        examples: ["generate api documentation"],
        guidance: "Generate and format documentation.",
      },
    },
  ];

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

  it("handles Branch A (resolved intent with candidate skills)", async () => {
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
      resolvedIntent: { id: "code-review", guidance: "Review code thoroughly" },
      candidateSkills,
      client: mockClient,
    });

    expect(mockSystemOne).toHaveBeenCalledOnce();
    const callArgs = mockSystemOne.mock.calls[0][0];
    expect(callArgs.questions).toHaveProperty("skill_git-tools");
    expect(callArgs.questions).toHaveProperty("skill_markdown-formatter");
    expect(callArgs.questions).not.toHaveProperty("intent");

    expect(result).toEqual({
      intent: "code-review",
      skills: ["git-tools"],
      confidence: 1.0,
      reason: expect.stringContaining("code-review"),
    });
  });

  it("short-circuits Branch A when candidate skills are empty", async () => {
    const mockSystemOne = vi.fn();
    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "review my commit",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      resolvedIntent: { id: "code-review", guidance: "Review code thoroughly" },
      candidateSkills: [],
      client: mockClient,
    });

    expect(mockSystemOne).not.toHaveBeenCalled();
    expect(result).toEqual({
      intent: "code-review",
      skills: [],
      confidence: 1.0,
      reason: "Jev direct route: code-review",
    });
  });

  it("handles Branch B (unresolved intent + candidate skills)", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      usage: { input_tokens: 20, output_tokens: 10 },
      answers: {
        intent: {
          type: "choice",
          choice: "documentation",
          confidence: 0.92,
        },
        "skill_git-tools": {
          type: "noul",
          noul: 0.2,
        },
        "skill_markdown-formatter": {
          type: "noul",
          noul: 0.95,
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
      latest: "generate docs for the project",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateIntents,
      candidateSkills,
      client: mockClient,
    });

    expect(mockSystemOne).toHaveBeenCalledOnce();
    const callArgs = mockSystemOne.mock.calls[0][0];
    expect(callArgs.questions).toHaveProperty("intent");
    expect(callArgs.questions).toHaveProperty("skill_git-tools");
    expect(callArgs.questions).toHaveProperty("skill_markdown-formatter");

    expect(result).toEqual({
      intent: "documentation",
      skills: ["markdown-formatter"],
      confidence: 0.92,
      reason: expect.stringContaining("documentation"),
    });
  });

  it("handles Branch B when intent choice is 'none'", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "typesafe/jev-latest",
      usage: { input_tokens: 20, output_tokens: 10 },
      answers: {
        intent: {
          type: "choice",
          choice: "none",
          confidence: 0.88,
        },
        "skill_git-tools": {
          type: "noul",
          noul: 0.1,
        },
        "skill_markdown-formatter": {
          type: "noul",
          noul: 0.1,
        },
      },
    });

    const mockClient = {
      systemOne: mockSystemOne,
    } as unknown as TypeSafeClient;

    const result = await runJevUnifiedRouting({
      api: dummyApi,
      config: resolveConfig({}),
      agentId: "main",
      latest: "hello there",
      modelRef: { provider: "typesafe", model: "jev-latest" },
      candidateIntents,
      candidateSkills,
      client: mockClient,
    });

    expect(result?.intent).toBeUndefined();
    expect(result?.skills).toEqual([]);
    expect(result?.confidence).toBe(0.88);
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
      resolvedIntent: { id: "code-review", guidance: "Review" },
      candidateSkills: skills,
      client: mockClient,
    });

    expect(result?.skills).toEqual(["skill-2", "skill-3"]);
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
      candidateIntents: [],
      candidateSkills: [],
      client: mockClient,
    });

    expect(mockSystemOne).not.toHaveBeenCalled();
    expect(result).toEqual({
      intent: undefined,
      skills: [],
      confidence: 0.0,
      reason: "Jev: no candidate questions to evaluate",
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
      candidateIntents,
      client: mockClient,
    });

    expect(result).toBeUndefined();
  });

  it("routes through runJevUnifiedRouting when runUnifiedRoutingSubagent detects a Jev model", async () => {
    const runEmbeddedAgent = vi.fn();
    const api = {
      config: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "or-key",
            },
          },
        },
      },
      runtime: {
        agent: { runEmbeddedAgent },
        config: { current: () => ({}) },
      },
    } as unknown as OpenClawPluginApi;

    // Test with model string containing "jev"
    const result = await runUnifiedRoutingSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      latest: "test jev routing dispatch",
      modelRef: { provider: "openrouter", model: "typesafe/jev-latest" },
      candidateIntents: [],
      candidateSkills: [],
    });

    // runEmbeddedAgent should NOT have been called because it was intercepted by Jev routing
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    // And it returned the Jev empty evaluation result
    expect(result).toEqual({
      intent: undefined,
      skills: [],
      confidence: 0.0,
      reason: "Jev: no candidate questions to evaluate",
    });
  });
});
