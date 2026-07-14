import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  buildIntentionEmbeddedRunParams,
  getInstructionModelRef,
  getModelRef,
  getReviewModelRef,
  runIntentInstructionSubagent,
  runTopicSwitchSubagent,
} from "./subagent.js";

describe("model resolution", () => {
  const api = {
    config: {
      agents: { defaults: { model: { primary: "anthropic/agent-primary" } } },
    },
  } as unknown as OpenClawPluginApi;
  const currentRun = {
    modelProviderId: "openai",
    modelId: "session-model",
  };

  it("prefers the explicit scanner model", () => {
    expect(
      getModelRef(
        api,
        "main",
        resolveConfig({
          model: "bifrost/explicit",
          modelFallback: "google/fallback",
        }),
        currentRun,
      ),
    ).toEqual({ provider: "bifrost", model: "explicit" });
  });

  it("prefers the current session over the agent primary and scanner fallback", () => {
    expect(
      getModelRef(
        api,
        "main",
        resolveConfig({ modelFallback: "google/fallback" }),
        currentRun,
      ),
    ).toEqual({ provider: "openai", model: "session-model" });
  });

  it("prefers the agent primary over the scanner fallback", () => {
    expect(
      getModelRef(
        api,
        "main",
        resolveConfig({ modelFallback: "google/fallback" }),
        {},
      ),
    ).toEqual({ provider: "anthropic", model: "agent-primary" });
  });

  it("uses the scanner fallback only when no earlier model resolves", () => {
    expect(
      getModelRef(
        { config: {} } as OpenClawPluginApi,
        "main",
        resolveConfig({ modelFallback: "google/fallback" }),
        {},
      ),
    ).toEqual({ provider: "google", model: "fallback" });
  });

  it("applies the same priority to instruction model resolution", () => {
    expect(
      getInstructionModelRef(
        api,
        "main",
        resolveConfig({
          modelFallback: "google/scanner-fallback",
          instruction: { modelFallback: "google/instruction-fallback" },
        }),
        currentRun,
      ),
    ).toEqual({ provider: "openai", model: "session-model" });
  });

  it("applies the same priority to review model resolution", () => {
    expect(
      getReviewModelRef(
        api,
        "main",
        resolveConfig({
          review: {
            model: "bifrost/review-explicit",
            modelFallback: "google/review-fallback",
          },
        }),
        currentRun,
      ),
    ).toEqual({ provider: "bifrost", model: "review-explicit" });

    expect(
      getReviewModelRef(
        api,
        "main",
        resolveConfig({
          review: { modelFallback: "google/review-fallback" },
        }),
        currentRun,
      ),
    ).toEqual({ provider: "openai", model: "session-model" });

    expect(
      getReviewModelRef(
        api,
        "main",
        resolveConfig({
          review: { modelFallback: "google/review-fallback" },
        }),
        {},
      ),
    ).toEqual({ provider: "anthropic", model: "agent-primary" });

    expect(
      getReviewModelRef(
        { config: {} } as OpenClawPluginApi,
        "main",
        resolveConfig({
          review: { modelFallback: "google/review-fallback" },
        }),
        {},
      ),
    ).toEqual({ provider: "google", model: "review-fallback" });
  });
});

describe("buildIntentionEmbeddedRunParams", () => {
  it("uses a run-specific session file", () => {
    const result = buildIntentionEmbeddedRunParams({
      params: {
        api: { config: {} } as OpenClawPluginApi,
        config: resolveConfig({}),
        agentId: "main",
        modelRef: { provider: "google", model: "intent" },
      },
      subagentSessionId: "skill-harness-test-run",
      subagentSessionKey: "agent:main:skill-harness:test",
      prompt: "classify",
    });

    expect(result.sessionFile).toBe(
      "/tmp/skill-harness-test-run.session.jsonl",
    );
  });
});

describe("runTopicSwitchSubagent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a tool-free topic checker with classifier config", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            basis: "Latest message continues the topic checker implementation.",
            keywords: [" Topic ", "Checker"],
            topic: "User is continuing work on the topic checker.",
            domain: "coding",
            reason: "same-topic",
            confidence: 0.92,
            complexity: "medium",
          }),
        },
      ],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;

    const result = await runTopicSwitchSubagent({
      api,
      config: resolveConfig({
        model: "google/test-intent",
        thinking: "low",
        timeoutMs: 4321,
      }),
      agentId: "main",
      conversation: [
        {
          role: "user",
          text: "continue previous implementation",
          historicalIntent: {
            intent: "coding",
            domain: "coding",
            topic: "topic checker",
          },
        },
      ],
      latest: "continue topic checker",
      domains: ["coding", "chat"],
      history: [
        {
          input: "plan topic checker",
          intent: "coding",
          domain: "coding",
          keywords: ["topic", "checker"],
          topic: "topic / checker",
        },
      ],
      modelRef: { provider: "google", model: "test-intent" },
    });

    expect(result).toEqual({
      basis: "Latest message continues the topic checker implementation.",
      keywords: ["topic", "checker"],
      topic: "User is continuing work on the topic checker.",
      domain: "coding",
      changed: false,
      reason: "same-topic",
      confidence: 0.92,
      complexity: "medium",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "test-intent",
        timeoutMs: 4321,
        thinkLevel: "low",
        disableTools: true,
        prompt: expect.stringContaining(
          "You are a topic and routing-continuity checker.",
        ),
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      "<conversation_context>",
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      '<historical_intent>{"intent":"coding","domain":"coding","topic":"topic checker"}</historical_intent>',
    );
  });

  it("includes the configured user timezone offset in the prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T18:06:00.000Z"));

    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            basis: "Latest message asks about timezone context.",
            keywords: ["timezone"],
            topic: "User is checking timezone context.",
            domain: "coding",
            reason: "shift",
            confidence: 0.9,
            complexity: "low",
          }),
        },
      ],
    });
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        config: {
          current: () => ({
            agents: { defaults: { userTimezone: "Asia/Kolkata" } },
          }),
        },
      },
    } as unknown as OpenClawPluginApi;

    await runTopicSwitchSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      latest: "continue timezone work",
      domains: ["coding"],
      history: [],
      modelRef: { provider: "google", model: "test-intent" },
    });

    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      "[Wed 2026-06-10 23:36 GMT+5:30]",
    );
  });
});

describe("runIntentInstructionSubagent", () => {
  it("parses structured hints and enables both skill discovery tools", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            instruction_hint: "Use test-driven-development, then apply_patch.",
            additional_candinate_skills: ["test-driven-development"],
          }),
        },
      ],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;

    const result = await runIntentInstructionSubagent({
      api,
      config: resolveConfig({
        model: "google/test-intent",
        thinking: "high",
        timeoutMs: 9999,
        instruction: {
          enabled: true,
          model: "google/test-instruction",
          thinking: "low",
          timeoutMs: 4321,
        },
      }),
      agentId: "main",
      conversation: [
        {
          role: "user",
          text: "continue previous implementation",
          historicalIntent: { intent: "coding", topic: "continuation" },
        },
      ],
      latest: "implement continuation",
      result: {
        intent: "coding",
        reason: "User wants implementation",
        keywords: ["continuation"],
        topic: "continuation",
        topicChanged: true,
        topicChangeReason: "shift",
        confidence: 0.9,
        complexity: "medium",
      },
      intentBody:
        "## Concrete Workflow\n\n- Use test-driven-development.\n\n## Tools\n\n- apply_patch",
      modelRef: { provider: "google", model: "test-instruction" },
    });

    expect(result).toEqual({
      instructionHint: "Use test-driven-development, then apply_patch.",
      additionalCandidateSkills: ["test-driven-development"],
    });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "test-instruction",
        timeoutMs: 4321,
        thinkLevel: "low",
        promptMode: "minimal",
        modelRun: false,
        disableTools: false,
        toolsAllow: ["skill_view", "skill_search"],
        prompt: expect.stringContaining("You are a hint writer."),
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      "Use test-driven-development",
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      "Classify the latest message turn-locally",
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      "<conversation_context>",
    );
    expect(runEmbeddedAgent.mock.calls[0][0].prompt).toContain(
      '<historical_intent>{"intent":"coding","topic":"continuation"}</historical_intent>',
    );
  });

  it("reports invalid JSON when the instruction writer returns an empty payload", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "   " }],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;

    const result = await runIntentInstructionSubagent({
      api,
      config: resolveConfig({ model: "google/test-intent" }),
      agentId: "main",
      latest: "implement continuation",
      result: {
        intent: "coding",
        reason: "User wants implementation",
        keywords: ["continuation"],
        topic: "continuation",
        topicChangeReason: "shift",
        confidence: 0.9,
        complexity: "medium",
      },
      intentBody: "## Concrete Workflow\n\n- Use test-driven-development.",
      modelRef: { provider: "google", model: "test-intent" },
    });

    expect(result).toEqual({
      error: "instruction writer produced invalid JSON",
    });
  });

  it("reports embedded agent error payloads instead of treating them as instructions", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "Model timed out", isError: true }],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;

    const result = await runIntentInstructionSubagent({
      api,
      config: resolveConfig({ model: "google/test-intent" }),
      agentId: "main",
      latest: "implement continuation",
      result: {
        intent: "coding",
        reason: "User wants implementation",
        keywords: ["continuation"],
        topic: "continuation",
        topicChangeReason: "shift",
        confidence: 0.9,
        complexity: "medium",
      },
      intentBody: "## Concrete Workflow\n\n- Use test-driven-development.",
      modelRef: { provider: "google", model: "test-intent" },
    });

    expect(result).toEqual({ error: "Model timed out" });
  });
});

describe("buildIntentionEmbeddedRunParams", () => {
  it("uses raw model mode with no built-in prompt sections or tools", () => {
    const result = buildIntentionEmbeddedRunParams({
      params: {
        api: { config: { plugins: {} } } as unknown as OpenClawPluginApi,
        config: resolveConfig({ timeoutMs: 4321, thinking: "low" }),
        agentId: "main",
        messageProvider: "telegram",
        modelRef: { provider: "openai", model: "gpt-5-mini" },
      },
      subagentSessionId: "subagent-1",
      subagentSessionKey: "main:skill-harness:abc",
      prompt: "Classify this intent",
    });

    expect(result.modelRun).toBe(true);
    expect(result.promptMode).toBe("none");
    expect(result.disableTools).toBe(true);
    expect(result.toolsAllow).toEqual([]);
    expect(result.disableMessageTool).toBe(true);
    expect(result.allowGatewaySubagentBinding).toBe(true);
    expect(result.bootstrapContextMode).toBe("lightweight");
    expect(result.verboseLevel).toBe("off");
    expect(result.reasoningLevel).toBe("off");
    expect(result.silentExpected).toBe(true);
    expect(result.authProfileFailurePolicy).toBe("local");
    expect(result.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(result.thinkLevel).toBe("low");
    expect(result.sessionFile).toBe("/tmp/subagent-1.session.jsonl");
    expect(result.workspaceDir).toBe("/tmp");
    expect(result.agentDir).toBe("/tmp");
  });
});
