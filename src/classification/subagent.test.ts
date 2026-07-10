import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  buildIntentionEmbeddedRunParams,
  runIntentInstructionSubagent,
  runTopicSwitchSubagent,
} from "./subagent.js";

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
            keywords: [" Topic ", "Checker"],
            topic: "User is continuing work on the topic checker.",
            domain: "coding",
            changed: false,
            reason: "same-topic",
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
      keywords: ["topic", "checker"],
      topic: "User is continuing work on the topic checker.",
      domain: "coding",
      changed: false,
      reason: undefined,
      complexity: "medium",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "test-intent",
        timeoutMs: 4321,
        thinkLevel: "low",
        disableTools: true,
        prompt: expect.stringContaining("You are a topic checker."),
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
            keywords: ["timezone"],
            topic: "User is checking timezone context.",
            domain: "coding",
            changed: true,
            reason: "shift",
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
  it("runs a skill-tool-enabled instruction writer with classifier config", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "Use test-driven-development, then apply_patch." }],
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
      text: "Use test-driven-development, then apply_patch.",
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
        toolsAllow: ["skill_view"],
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

  it("reports no text when the instruction writer returns an empty payload", async () => {
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
      error: "instruction writer produced no text",
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
