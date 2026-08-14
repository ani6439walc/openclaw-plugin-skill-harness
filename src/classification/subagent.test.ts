import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";

import {
  buildIntentionEmbeddedRunParams,
  getModelRef,
  getReviewModelRef,
  runIntentionSubagent,
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

  it("uses dataRoot paths when provided", () => {
    const dataRoot = "/tmp/test-data-root";
    const result = buildIntentionEmbeddedRunParams({
      params: {
        api: { config: {} } as OpenClawPluginApi,
        config: resolveConfig({}),
        agentId: "main",
        modelRef: { provider: "google", model: "intent" },
        dataRoot,
      },
      subagentSessionId: "skill-harness-test-run",
      subagentSessionKey: "agent:main:skill-harness:test",
      prompt: "classify",
    });

    expect(result.workspaceDir).toBe(`${dataRoot}/workspace`);
    expect(result.agentDir).toBe(`${dataRoot}/workspace`);
    expect(result.sessionFile).toBe(
      `${dataRoot}/agents/intention/sessions/skill-harness-test-run.session.jsonl`,
    );
  });

  it("uses topic-switch agent name in session path", () => {
    const dataRoot = "/tmp/test-data-root";
    const result = buildIntentionEmbeddedRunParams({
      params: {
        api: { config: {} } as OpenClawPluginApi,
        config: resolveConfig({}),
        agentId: "main",
        modelRef: { provider: "google", model: "intent" },
        dataRoot,
      },
      subagentSessionId: "skill-harness-test-run",
      subagentSessionKey: "agent:main:skill-harness:test",
      prompt: "topic switch",
      agentName: "topic-switch",
    });

    expect(result.sessionFile).toBe(
      `${dataRoot}/agents/topic-switch/sessions/skill-harness-test-run.session.jsonl`,
    );
  });
});

describe("runIntentionSubagent", () => {
  const intents = [
    {
      id: "allowed",
      definition: {
        triggers: ["allowed work"],
        examples: ["do allowed work"],
        domain: "development",
        skills: [],
        fastpath: { keywords: [] },
        guidance: "Do allowed work.",
      },
    },
  ];

  async function runWithIntent(intent: string) {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [
        {
          text: JSON.stringify({
            intent,
            reason: "The request matches the selected intent.",
            keywords: ["allowed"],
            topic: "Allowed work",
            domain: "development",
            confidence: 0.9,
            complexity: "low",
          }),
        },
      ],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;
    const result = await runIntentionSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      latest: "do allowed work",
      modelRef: { provider: "google", model: "intent" },
      intents,
    });
    return { result, runEmbeddedAgent };
  }

  it("rejects an intent excluded from the supplied classifier catalog", async () => {
    const { result, runEmbeddedAgent } = await runWithIntent("excluded");

    expect(result).toBeUndefined();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it("keeps the explicit fallback intent valid", async () => {
    const { result, runEmbeddedAgent } = await runWithIntent("other");

    expect(result?.intent).toBe("other");
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
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
