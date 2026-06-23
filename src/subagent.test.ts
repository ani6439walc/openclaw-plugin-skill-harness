import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
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
      subagentSessionId: "intention-hint-test-run",
      subagentSessionKey: "agent:main:intention-hint:test",
      prompt: "classify",
    });

    expect(result.sessionFile).toBe(
      "/tmp/intention-hint-test-run.session.jsonl",
    );
  });
});

describe("runTopicSwitchSubagent", () => {
  it("runs a tool-free topic checker with classifier config", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            keywords: [" Topic ", "Checker"],
            topic: "User is continuing work on the topic checker.",
            domain: "coding",
            topicChanged: false,
            topicChangeReason: "same-topic",
            complexity: "medium",
          }),
        },
      ],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedPiAgent } },
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
          historicalIntent: { intent: "coding", topic: "topic checker" },
        },
      ],
      latest: "continue topic checker",
      domains: ["coding", "chat"],
      history: [
        {
          input: "plan topic checker",
          intent: "coding",
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
      topicChanged: false,
      topicChangeReason: "same-topic",
      complexity: "medium",
    });
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "test-intent",
        timeoutMs: 4321,
        thinkLevel: "low",
        disableTools: true,
        prompt: expect.stringContaining("topic continuity checker"),
      }),
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "<conversation_context>",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "topic: topic checker",
    );
  });
});

describe("runIntentInstructionSubagent", () => {
  it("runs a tool-free instruction writer with classifier config", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "Use test-driven-development, then apply_patch." }],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedPiAgent } },
    } as unknown as OpenClawPluginApi;

    const result = await runIntentInstructionSubagent({
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
        topicChangeReason: "keyword-delta",
        confidence: 0.9,
        complexity: "medium",
      },
      intentBody:
        "## Concrete Workflow\n\n- Use test-driven-development.\n\n## Tools\n\n- apply_patch",
      modelRef: { provider: "google", model: "test-intent" },
    });

    expect(result).toBe("Use test-driven-development, then apply_patch.");
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "test-intent",
        timeoutMs: 4321,
        thinkLevel: "low",
        disableTools: true,
        prompt: expect.stringContaining("intention-hint writer"),
      }),
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "Use test-driven-development",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "Classify the latest message turn-locally",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "<conversation_context>",
    );
    expect(runEmbeddedPiAgent.mock.calls[0][0].prompt).toContain(
      "topic: continuation",
    );
  });
});
