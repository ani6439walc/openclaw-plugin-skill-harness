import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { defaultTracker } from "./session-tracker.js";

function createHandlers() {
  return createHookHandlers({
    api: {} as OpenClawPluginApi,
    config: () => resolveConfig({}),
    refreshLiveConfigFromRuntime: () => undefined,
    refreshIntents: () => undefined,
  });
}

describe("createHookHandlers tracking guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not record tool calls without a session id", async () => {
    const hasIntentData = vi.spyOn(defaultTracker, "hasIntentData");
    const record = vi.spyOn(defaultTracker, "record");
    const write = vi.spyOn(defaultTracker, "write");

    await createHandlers().onAfterToolCall(
      {
        toolName: "read",
        params: {},
        result: "ok",
        durationMs: 1,
      } as never,
      {},
    );

    expect(hasIntentData).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not record tool calls before intent data exists", async () => {
    vi.spyOn(defaultTracker, "hasIntentData").mockReturnValue(false);
    const record = vi.spyOn(defaultTracker, "record");
    const write = vi.spyOn(defaultTracker, "write");

    await createHandlers().onAfterToolCall(
      {
        toolName: "read",
        params: {},
        result: "ok",
        durationMs: 1,
      } as never,
      { sessionId: "session-without-intent" },
    );

    expect(defaultTracker.hasIntentData).toHaveBeenCalledWith(
      "session-without-intent",
    );
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("createHookHandlers internal turn guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips inter-session turns before refreshing config or intents", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const refreshIntents = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents,
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "subagent completion payload",
        messages: [
          {
            role: "user",
            content: "subagent completion payload",
            provenance: {
              kind: "inter_session",
              sourceTool: "subagent_announce",
            },
          },
        ],
      },
      {
        trigger: "user",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toBeUndefined();
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
    expect(refreshIntents).not.toHaveBeenCalled();
  });

  it("skips legacy inter-session marker turns before refreshing config", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents: vi.fn(),
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt:
          "[Inter-session message] sourceTool=subagent_announce isUser=false\nThis content was routed by OpenClaw from another session or internal tool.",
        messages: [],
      },
      {
        trigger: "user",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toBeUndefined();
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
  });

  it("skips the protected subagent completion envelope before refreshing config", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents: vi.fn(),
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored. Keep internal details private.\n\n[Internal task completion event]\nsource: subagent\nstatus: completed\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        messages: [
          { role: "user", content: "original question" },
          { role: "assistant", content: "waiting for the subagent" },
        ],
      },
      {
        trigger: "user",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toBeUndefined();
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
  });

  it("does not skip a normal external-user turn", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents: vi.fn(),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "normal question",
        messages: [
          {
            role: "user",
            content: "normal question",
            provenance: { kind: "external_user" },
          },
        ],
      },
      {
        trigger: "user",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(refreshLiveConfigFromRuntime).toHaveBeenCalledOnce();
  });
});
