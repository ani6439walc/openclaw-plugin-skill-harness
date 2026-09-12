import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";

import {
  buildIntentionEmbeddedRunParams,
  getModelRef,
  getReviewModelRef,
  runIntentionSubagent,
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
          routing: {
            classifier: {
              model: "bifrost/explicit",
              modelFallback: "google/fallback",
            },
          },
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
        resolveConfig({
          routing: { classifier: { modelFallback: "google/fallback" } },
        }),
        currentRun,
      ),
    ).toEqual({ provider: "openai", model: "session-model" });
  });

  it("prefers the agent primary over the scanner fallback", () => {
    expect(
      getModelRef(
        api,
        "main",
        resolveConfig({
          routing: { classifier: { modelFallback: "google/fallback" } },
        }),
        {},
      ),
    ).toEqual({ provider: "anthropic", model: "agent-primary" });
  });

  it("uses the scanner fallback only when no earlier model resolves", () => {
    expect(
      getModelRef(
        { config: {} } as OpenClawPluginApi,
        "main",
        resolveConfig({
          routing: { classifier: { modelFallback: "google/fallback" } },
        }),
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
  it("does not claim a persisted transcript for transient classification", () => {
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

    expect(result).not.toHaveProperty("sessionFile");
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
    expect(result).not.toHaveProperty("sessionFile");
  });

  it("keeps transient classification identity independent of dataRoot", () => {
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
      prompt: "intent classification",
    });

    expect(result).not.toHaveProperty("sessionFile");
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
        keywords: [],
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
            domain: "development",
            confidence: 0.9,
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
    const { result, runEmbeddedAgent } = await runWithIntent("unknown");

    expect(result?.intent).toBe("unknown");
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });
});

describe("buildIntentionEmbeddedRunParams", () => {
  it("uses raw model mode with no built-in prompt sections or tools", () => {
    const result = buildIntentionEmbeddedRunParams({
      params: {
        api: { config: { plugins: {} } } as unknown as OpenClawPluginApi,
        config: resolveConfig({
          routing: { classifier: { timeoutMs: 4321, thinking: "low" } },
        }),
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
    expect(result).not.toHaveProperty("sessionFile");
    expect(result.workspaceDir).toBe("/tmp");
    expect(result.agentDir).toBe("/tmp");
  });
});
