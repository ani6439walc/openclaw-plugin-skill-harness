import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import { buildIntentionEmbeddedRunParams } from "./subagent.js";

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
