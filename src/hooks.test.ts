import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { defaultTracker } from "./session-tracker.js";
import { defaultStatsAggregator } from "./stats-aggregator.js";
import { defaultCatalog } from "./intent-loader.js";

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

  it("aggregates the completed current turn on agent_end", async () => {
    const state = {
      input: "commit this",
      intent: {
        result: {
          intent: "VERSION_CONTROL (Version Control)",
          reason: "test",
          goal: "Commit changes",
          confidence: 0.9,
          complexity: "low" as const,
        },
      },
      timestamps: { start: "2026-06-11T00:00:00.000Z" },
    };
    const definition = {
      id: "VERSION_CONTROL",
      name: "Version Control",
      enabled: true,
      triggers: ["commit"],
      examples: [],
      prompt: "skill: git-master",
    };
    vi.spyOn(defaultTracker, "hasIntentData").mockReturnValue(true);
    vi.spyOn(defaultTracker, "record").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "getCurrentState").mockReturnValue(state);
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const recordStats = vi
      .spyOn(defaultStatsAggregator, "record")
      .mockReturnValue(true);

    await createHandlers().onAgentEnd(
      { messages: [{ role: "assistant", content: "done" }] } as never,
      { sessionId: "session-1" },
    );

    expect(recordStats).toHaveBeenCalledWith("session-1", state, definition);
  });

  it("does not aggregate agent_end without a tracked current turn", async () => {
    vi.spyOn(defaultTracker, "hasIntentData").mockReturnValue(false);
    const recordStats = vi.spyOn(defaultStatsAggregator, "record");

    await createHandlers().onAgentEnd({ messages: [] } as never, {});

    expect(recordStats).not.toHaveBeenCalled();
  });

  it("enqueues enabled multi-trigger evolution review without awaiting it", async () => {
    const snapshot = {
      sessionId: "session-1",
      agentId: "main",
      eventId: "session-1:2026-06-11T00:00:00.000Z",
      turnNumber: 10,
      current: {
        input: "不對，應該是別的做法",
        intent: {
          intent: "OTHER",
          reason: "test",
          goal: "Correct behavior",
          confidence: 0.2,
          complexity: "high" as const,
        },
        toolCalls: Array.from({ length: 5 }, () => ({
          name: "exec",
        })),
        timestamps: { start: "2026-06-11T00:00:00.000Z" },
      },
      recent: [],
      intentCatalog: [],
    };
    vi.spyOn(defaultTracker, "hasIntentData").mockReturnValue(true);
    vi.spyOn(defaultTracker, "record").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "getCurrentState").mockReturnValue({
      input: snapshot.current.input,
      intent: { result: snapshot.current.intent },
      toolCalls: snapshot.current.toolCalls?.map((call) => ({
        ...call,
        params: {},
      })),
      timestamps: snapshot.current.timestamps,
    });
    vi.spyOn(defaultTracker, "getReviewSnapshot").mockReturnValue(snapshot);
    vi.spyOn(defaultStatsAggregator, "record").mockReturnValue(true);
    const definition = {
      id: "OTHER",
      name: "Fallback",
      enabled: true,
      triggers: ["Unmatched requests"],
      examples: ["help"],
      prompt:
        "Detected fallback intent.\n\n## Guidelines\n\n- Ask for context.",
    };
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const enqueue = vi.fn();
    const reviewer = vi.fn().mockResolvedValue([]);
    const backlogWriter = { record: vi.fn() };
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () =>
        resolveConfig({
          selfEvolution: {
            enabled: true,
            reviewModel: "google/test-review",
          },
        }),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
      reviewQueue: { enqueue },
      reviewer,
      backlogWriter,
    });

    await handlers.onAgentEnd({ messages: [] } as never, {
      sessionId: "session-1",
      agentId: "main",
    });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(reviewer).not.toHaveBeenCalled();
    await enqueue.mock.calls[0][0]();
    expect(reviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          matchedIntent: definition,
          intentCatalog: [
            {
              id: "OTHER",
              name: "Fallback",
              triggers: ["Unmatched requests"],
              examples: ["help"],
            },
          ],
        }),
        triggers: [
          "skill_candidate",
          "satisfaction_check",
          "missing_intent",
          "weak_intent",
          "behavior_fix",
        ],
      }),
    );
    expect(backlogWriter.record).toHaveBeenCalledWith(
      snapshot.eventId,
      expect.objectContaining({ sessionId: "session-1" }),
      [],
    );
  });
});

describe("createHookHandlers session cleanup", () => {
  beforeEach(() => {
    vi.spyOn(defaultTracker, "cleanupExpired").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["new", "reset", "idle", "daily", "compaction", "deleted"] as const)(
    "deletes persisted session data when session_end reason is %s",
    async (reason) => {
      const cleanup = vi.spyOn(defaultTracker, "cleanup");

      await createHandlers().onSessionEnd(
        {
          sessionId: "ended-session",
          messageCount: 1,
          reason,
        },
        { sessionId: "ended-session" },
      );

      expect(cleanup).toHaveBeenCalledWith("ended-session", {
        deleteFile: true,
      });
    },
  );

  it.each(["shutdown", "restart", "unknown", undefined] as const)(
    "preserves persisted session data when session_end reason is %s",
    async (reason) => {
      const cleanup = vi.spyOn(defaultTracker, "cleanup");

      await createHandlers().onSessionEnd(
        {
          sessionId: "ended-session",
          messageCount: 1,
          reason,
        },
        { sessionId: "ended-session" },
      );

      expect(cleanup).toHaveBeenCalledWith("ended-session", {
        deleteFile: false,
      });
    },
  );

  it.each(["new", "shutdown", undefined] as const)(
    "runs expired session retention cleanup when session_end reason is %s",
    async (reason) => {
      const cleanupExpired = vi.spyOn(defaultTracker, "cleanupExpired");

      await createHandlers().onSessionEnd(
        {
          sessionId: "ended-session",
          messageCount: 1,
          reason,
        },
        { sessionId: "ended-session" },
      );

      expect(cleanupExpired).toHaveBeenCalledOnce();
    },
  );
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
    const getHistoricalIntentRecords = vi.spyOn(
      defaultTracker,
      "getHistoricalIntentRecords",
    );
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
        sessionId: "normal-session",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(refreshLiveConfigFromRuntime).toHaveBeenCalledOnce();
    expect(getHistoricalIntentRecords).toHaveBeenCalledWith("normal-session");
  });
});
