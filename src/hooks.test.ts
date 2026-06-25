import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import { createHookHandlers } from "./hooks.js";
import { defaultTracker } from "./session-tracker.js";
import { defaultStatsAggregator } from "./stats-aggregator.js";
import { defaultCatalog, filterIntentsForAgent } from "./intent-loader.js";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness";

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  emitAgentEvent: vi.fn(),
}));

const emitHostAgentEvent = vi.mocked(emitAgentEvent);

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
    emitHostAgentEvent.mockReset();
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
          intent: "version-control",
          reason: "test",
          confidence: 0.9,
          complexity: "low" as const,
        },
      },
      timestamps: { start: "2026-06-11T00:00:00.000Z" },
    };
    const definition = {
      id: "version-control",
      definition: {
        triggers: ["commit"],
        examples: [],
        domain: "git",
        fastpath: { keywords: [] },
        prompt: "skill: git-master",
      },
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
          intent: "other",
          reason: "test",
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
      id: "other",
      definition: {
        triggers: ["Unmatched requests"],
        examples: ["help"],
        domain: "other",
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\n- Ask for context.",
      },
    };
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const enqueue = vi.fn();
    const reviewer = vi.fn().mockResolvedValue([]);
    const backlogWriter = { record: vi.fn() };
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () =>
        resolveConfig({
          evolution: {
            enabled: true,
            model: "google/test-review",
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
              id: "other",
              triggers: ["Unmatched requests"],
              examples: ["help"],
              domain: "other",
              fastpath: { keywords: [], hint: undefined },
            },
          ],
        }),
        triggers: [
          "skill-candidate",
          "satisfaction-check",
          "missing-intent",
          "weak-intent",
          "behavior-fix",
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

describe("createHookHandlers topic switch flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const intent = {
    id: "social-casual",
    definition: {
      triggers: ["chat"],
      examples: ["hi"],
      domain: "chat",
      fastpath: {
        hint: "Reply warmly.",
        keywords: ["hi", "謝謝"],
      },
      prompt: "## Guidelines\n\n- Reply warmly.",
    },
  };
  const versionControlIntent = {
    id: "version-control",
    definition: {
      triggers: ["git"],
      examples: ["commit this"],
      domain: "git",
      fastpath: { keywords: ["commit"] },
      prompt: "## Guidelines\n\n- Use git carefully.",
    },
  };

  function createTopicFlowHarness(params: {
    historicalIntents: ReturnType<
      typeof defaultTracker.getHistoricalIntentRecords
    >;
    configRaw?: Parameters<typeof resolveConfig>[0];
    intents?: (typeof intent)[];
    classifier?: ReturnType<typeof vi.fn>;
    topicChecker?: ReturnType<typeof vi.fn>;
    instructionWriter?: ReturnType<typeof vi.fn>;
    api?: Partial<OpenClawPluginApi>;
  }) {
    emitHostAgentEvent.mockReset();
    const intents = params.intents ?? [intent];
    const record = vi.fn();
    const tracker = {
      getHistoricalIntentRecords: vi
        .fn()
        .mockReturnValue(params.historicalIntents),
      rotate: vi.fn(),
      record,
      write: vi.fn(),
    };
    const catalog = {
      count: intents.length,
      filterForAgent: vi.fn((config, agentId) =>
        filterIntentsForAgent(intents, config, agentId),
      ),
      get: vi.fn().mockReturnValue(intents),
    };
    const classifier =
      params.classifier ??
      vi.fn().mockResolvedValue({
        intent: "social-casual",
        reason: "User is chatting",
        keywords: ["topic", "flow"],
        topic: "User is chatting casually.",
        domain: "chat",
        topicChanged: false,
        topicChangeReason: "initial",
        confidence: 0.9,
        complexity: "medium" as const,
      });
    const topicChecker = params.topicChecker ?? vi.fn();
    const instructionWriter =
      params.instructionWriter ??
      vi.fn().mockResolvedValue("Follow the generated coding instructions.");
    const emitAgentEvent = emitHostAgentEvent;
    const handlers = createHookHandlers({
      api: {
        config: {},
        ...params.api,
      } as unknown as OpenClawPluginApi,
      config: () =>
        resolveConfig(params.configRaw ?? { model: "google/test-intent" }),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
      catalog: catalog as never,
      tracker: tracker as never,
      classifier,
      topicChecker,
      instructionWriter,
    });

    return {
      handlers,
      tracker,
      classifier,
      topicChecker,
      instructionWriter,
      record,
      emitAgentEvent,
    };
  }

  const event = {
    prompt: "implement topic checker",
    messages: [
      {
        role: "user",
        content: "implement topic checker",
        provenance: { kind: "external_user" },
      },
    ],
  } as never;
  const ctx = {
    trigger: "user",
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:direct:123",
    runId: "run-1",
  };

  function emittedPipelineEvents(emitAgentEvent: ReturnType<typeof vi.fn>) {
    return emitAgentEvent.mock.calls.map((call) => call[0]);
  }

  function emittedPhaseStates(emitAgentEvent: ReturnType<typeof vi.fn>) {
    return emittedPipelineEvents(emitAgentEvent).map(
      (event) => `${event.data.phase}:${event.data.state}`,
    );
  }

  it("uses exact keyword match to inject a prompt without subagent calls", async () => {
    const fastEvent = {
      prompt: " 謝 謝 ",
      messages: [
        {
          role: "user",
          content: " 謝 謝 ",
          provenance: { kind: "external_user" },
        },
      ],
    } as never;
    const {
      handlers,
      classifier,
      topicChecker,
      instructionWriter,
      record,
      emitAgentEvent,
    } = createTopicFlowHarness({ historicalIntents: [] });

    const result = await handlers.onBeforePromptBuild(fastEvent, ctx);

    expect(result?.prependContext).toContain("<intention_hint_plugin");
    expect(result?.prependContext).toContain("Reply warmly.");
    expect(result?.prependContext).not.toContain("## Guidelines");
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "topic-continuity-check:completed",
    );
    expect(JSON.stringify(emittedPipelineEvents(emitAgentEvent))).not.toMatch(
      /fastpath-a[12]/i,
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining({
              intent: "social-casual",
              keywords: ["謝謝"],
              domain: "chat",
              topicChangeReason: "initial",
            }),
            instructionText: "Reply warmly.",
          }),
        }),
      }),
    );
  });

  it("requires a fastpath hint for exact keyword injection", async () => {
    const exactOnlyIntent = {
      id: "social-casual",
      definition: {
        triggers: ["chat"],
        examples: ["hi"],
        domain: "chat",
        fastpath: { keywords: ["hi"] },
        prompt: "## Guidelines\n\n- Reply warmly.",
      },
    };
    const { handlers, topicChecker } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [exactOnlyIntent],
      topicChecker: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "hi",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      ctx,
    );

    expect(topicChecker).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "same-topic",
      history: {
        input: "hi",
        intent: "social-casual",
        topic: "User is chatting casually.",
        confidence: 1,
        complexity: "low" as const,
      },
      expected: {
        previousTopic: undefined,
        topicChangeReason: undefined,
      },
    },
    {
      name: "keyword-match",
      history: {
        input: "fix this",
        intent: "coding",
        topic: "User is fixing code.",
        confidence: 0.8,
        complexity: "medium" as const,
      },
      expected: {
        previousTopic: "User is fixing code.",
        topicChangeReason: "keyword-match",
      },
    },
  ])("marks exact keyword matches as $name", async ({ history, expected }) => {
    const { handlers, record } = createTopicFlowHarness({
      historicalIntents: [history],
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "hi",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      ctx,
    );

    expect(result?.prependContext).toContain("<intention_hint_plugin");
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining(expected),
          }),
        }),
      }),
    );
  });

  it("does not use exact keyword match for unmatched short confirmations", async () => {
    const { handlers, topicChecker } = createTopicFlowHarness({
      historicalIntents: [],
      topicChecker: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "OK",
        messages: [{ role: "user", content: "OK" }],
      } as never,
      ctx,
    );

    expect(topicChecker).toHaveBeenCalledOnce();
  });

  it("does not use exact keyword match when the matched intent is denied", async () => {
    const { handlers, topicChecker } = createTopicFlowHarness({
      historicalIntents: [],
      configRaw: {
        model: "google/test-intent",
        intentDeny: { main: ["social-casual"] },
      },
      topicChecker: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "hi",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      ctx,
    );

    expect(topicChecker).toHaveBeenCalledOnce();
  });

  it("uses topic keyword similarity to skip the intent classifier", async () => {
    const topicContext = {
      keywords: ["comit"],
      topic: "User wants a git commit.",
      domain: "git",
      topicChanged: false,
      topicChangeReason: undefined,
      complexity: "low" as const,
    };
    const {
      handlers,
      classifier,
      topicChecker,
      instructionWriter,
      record,
      emitAgentEvent,
    } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [intent, versionControlIntent],
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "please comit this",
        messages: [{ role: "user", content: "please comit this" }],
      } as never,
      ctx,
    );

    expect(result).toBeUndefined();
    expect(topicChecker).toHaveBeenCalledOnce();
    expect(topicChecker).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ["chat", "git"] }),
    );
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "topic-continuity-check:completed",
    );
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "intent-classification:completed",
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "intent-classification",
          state: "completed",
          intent: "version-control",
          domain: "git",
          confidence: expect.closeTo(0.833, 0.01),
          complexity: "low",
        }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining({
              intent: "version-control",
              reason: "Topic keyword similarity match: comit -> commit",
              keywords: ["comit", "commit"],
              topic: "User wants a git commit.",
              domain: "git",
              confidence: expect.closeTo(0.833, 0.01),
              topicChangeReason: undefined,
            }),
          }),
        }),
      }),
    );
  });

  it("uses topic keyword similarity to write an instruction on changed topics", async () => {
    const { handlers, classifier, instructionWriter } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [intent, versionControlIntent],
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["comit"],
        topic: "User wants a git commit.",
        domain: "git",
        topicChanged: true,
        topicChangeReason: "initial" as const,
        complexity: "low" as const,
      }),
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "please comit this",
        messages: [{ role: "user", content: "please comit this" }],
      } as never,
      ctx,
    );

    expect(result?.prependContext).toContain("<intention_hint_plugin");
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          intent: "version-control",
          domain: "git",
          topicChangeReason: "initial",
        }),
      }),
    );
  });

  it("falls back to the classifier when topic keyword similarity is ambiguous", async () => {
    const secondIntent = {
      id: "almost-version-control",
      definition: {
        triggers: ["git-ish"],
        examples: [],
        domain: "git",
        fastpath: { keywords: ["comitx"] },
        prompt: "## Guidelines\n\n- Handle the near match.",
      },
    };
    const { handlers, classifier } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [versionControlIntent, secondIntent],
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["comit"],
        topic: "Ambiguous git-ish request.",
        domain: "git",
        topicChanged: true,
        topicChangeReason: "initial" as const,
        complexity: "low" as const,
      }),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "please comit",
        messages: [{ role: "user", content: "please comit" }],
      } as never,
      ctx,
    );

    expect(classifier).toHaveBeenCalledOnce();
  });

  it("falls back to the classifier for high-risk topic keyword similarity matches", async () => {
    const deployIntent = {
      id: "deployment",
      definition: {
        triggers: ["deploy"],
        examples: [],
        domain: "infra",
        fastpath: { keywords: ["deploy"] },
        prompt: "## Guidelines\n\n- Be careful with deployment.",
      },
    };
    const { handlers, classifier } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [deployIntent],
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["deploy"],
        topic: "User wants deployment.",
        domain: "infra",
        topicChanged: true,
        topicChangeReason: "initial" as const,
        complexity: "high" as const,
      }),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "deploy production",
        messages: [{ role: "user", content: "deploy production" }],
      } as never,
      ctx,
    );

    expect(classifier).toHaveBeenCalledOnce();
  });

  it("does not compare keywords outside the selected topic domain", async () => {
    const docsIntent = {
      id: "docs-commit",
      definition: {
        triggers: ["docs"],
        examples: [],
        domain: "docs",
        fastpath: { keywords: ["documentation"] },
        prompt: "## Guidelines\n\n- Write docs.",
      },
    };
    const { handlers, classifier, instructionWriter } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [versionControlIntent, docsIntent],
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["commit"],
        topic: "User wants docs work.",
        domain: "docs",
        topicChanged: true,
        topicChangeReason: "initial" as const,
        complexity: "low" as const,
      }),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "commit this",
        messages: [{ role: "user", content: "commit this" }],
      } as never,
      ctx,
    );

    expect(classifier).toHaveBeenCalledOnce();
    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ intent: "social-casual" }),
      }),
    );
  });

  it("does not use topic keyword similarity when the matched intent is denied", async () => {
    const { handlers, classifier } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [versionControlIntent],
      configRaw: {
        model: "google/test-intent",
        intentDeny: { main: ["version-control"] },
      },
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["commit"],
        topic: "User wants a git commit.",
        domain: "git",
        topicChanged: true,
        topicChangeReason: "initial" as const,
        complexity: "low" as const,
      }),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "commit this",
        messages: [{ role: "user", content: "commit this" }],
      } as never,
      ctx,
    );

    expect(classifier).toHaveBeenCalledOnce();
  });

  it("keeps same-topic inheritance ahead of topic keyword similarity", async () => {
    const { handlers, classifier, instructionWriter } = createTopicFlowHarness({
      historicalIntents: [
        {
          input: "commit this",
          intent: "version-control",
          keywords: ["commit"],
          topic: "User wants a git commit.",
          confidence: 0.9,
          complexity: "medium",
        },
      ],
      intents: [versionControlIntent],
      topicChecker: vi.fn().mockResolvedValue({
        keywords: ["commit"],
        topic: "User is still discussing a git commit.",
        domain: "git",
        topicChanged: false,
        topicChangeReason: "same-topic" as const,
        complexity: "low" as const,
      }),
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "commit it",
        messages: [{ role: "user", content: "commit it" }],
      } as never,
      ctx,
    );

    expect(result).toBeUndefined();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
  });

  it("skips hint injection when confidence is undefined (treated as 0)", async () => {
    const classifier = vi.fn().mockResolvedValue({
      intent: "coding",
      reason: "User wants implementation",
      keywords: ["topic", "flow"],
      topic: "User wants implementation help for the topic flow.",
      topicChanged: true,
      topicChangeReason: "initial",
      // confidence intentionally omitted (undefined)
      complexity: "medium" as const,
    });
    const { handlers, instructionWriter, record, emitAgentEvent } =
      createTopicFlowHarness({
        historicalIntents: [],
        classifier,
      });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toBeUndefined();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).toEqual(
      expect.arrayContaining(["instruction-hint-generation:completed"]),
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "instruction-hint-generation",
          state: "completed",
          result: "skipped: confidence below 0.7",
        }),
      }),
    );
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "low-confidence-observation:completed",
        "prompt-prefix-injection:skipped",
      ]),
    );
    expect(record).toHaveBeenCalled();
  });

  it("skips hint injection when confidence is undefined (treated as 0)", async () => {
    const classifier = vi.fn().mockResolvedValue({
      intent: "coding",
      reason: "User wants implementation",
      keywords: ["topic", "flow"],
      topic: "User wants implementation help for the topic flow.",
      topicChanged: true,
      topicChangeReason: "initial",
      // confidence intentionally omitted (undefined)
      complexity: "medium" as const,
    });
    const { handlers, instructionWriter, record } = createTopicFlowHarness({
      historicalIntents: [],
      classifier,
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toBeUndefined();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
  });

  it("runs topic checker on the first tracked turn to seed topic metadata", async () => {
    const topicContext = {
      keywords: ["initial", "topic"],
      topic: "User is starting an initial topic.",
      domain: "chat",
      topicChanged: true,
      topicChangeReason: "initial" as const,
      complexity: "low" as const,
    };
    const {
      handlers,
      classifier,
      topicChecker,
      instructionWriter,
      record,
      emitAgentEvent,
    } = createTopicFlowHarness({
      historicalIntents: [],
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(topicChecker).toHaveBeenCalledWith(
      expect.objectContaining({
        latest: "implement topic checker",
        history: [],
        conversation: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            text: "implement topic checker",
          }),
        ]),
      }),
    );
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({ topicContext }),
    );
    expect(instructionWriter).toHaveBeenCalledOnce();
    expect(result?.prependContext).toContain("<intention_hint_plugin");
    expect(emittedPhaseStates(emitAgentEvent)).toEqual(
      expect.arrayContaining([
        "topic-continuity-check:started",
        "topic-continuity-check:completed",
        "intent-classification:started",
        "intent-classification:completed",
        "instruction-hint-generation:started",
        "instruction-hint-generation:completed",
      ]),
    );
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "session-record:completed",
        "prompt-prefix-injection:completed",
      ]),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining({
              keywords: ["initial", "topic"],
              topic: "User is starting an initial topic.",
              domain: "chat",
              topicChangeReason: "initial",
            }),
          }),
        }),
      }),
    );
  });

  it("runs topic checker before intent classifier on changed later turns", async () => {
    const topicContext = {
      keywords: ["new", "topic"],
      topic: "User is switching to a new topic.",
      domain: "chat",
      topicChanged: true,
      topicChangeReason: "transition-marker" as const,
      complexity: "high" as const,
    };
    const { handlers, classifier, topicChecker, instructionWriter } =
      createTopicFlowHarness({
        historicalIntents: [
          {
            input: "plan topic checker",
            intent: "coding",
            keywords: ["topic", "checker"],
            topic: "topic / checker",
            domain: "coding",
            confidence: 0.8,
            complexity: "medium",
          },
        ],
        topicChecker: vi.fn().mockResolvedValue(topicContext),
      });

    await handlers.onBeforePromptBuild(event, ctx);

    expect(topicChecker).toHaveBeenCalledWith(
      expect.objectContaining({
        latest: "implement topic checker",
        history: [
          expect.objectContaining({
            topic: "topic / checker",
            keywords: ["topic", "checker"],
          }),
        ],
      }),
    );
    expect(topicChecker.mock.invocationCallOrder[0]).toBeLessThan(
      classifier.mock.invocationCallOrder[0],
    );
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({ topicContext }),
    );
    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          complexity: "high",
          previousTopic: "topic / checker",
        }),
      }),
    );
  });

  it("falls back to classifier-only when topic checker returns no result", async () => {
    const { handlers, classifier, topicChecker } = createTopicFlowHarness({
      historicalIntents: [
        {
          input: "plan topic checker",
          intent: "coding",
          keywords: ["topic", "checker"],
          topic: "topic / checker",
          domain: "coding",
          confidence: 0.8,
          complexity: "medium",
        },
      ],
      topicChecker: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(event, ctx);

    expect(topicChecker).toHaveBeenCalledOnce();
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({ topicContext: undefined }),
    );
  });

  it("runs inherited intent classifier without subagent and records compact state on same-topic continuation", async () => {
    const topicContext = {
      keywords: ["topic", "checker"],
      topic: "User is continuing work on the topic checker.",
      topicChanged: false,
      topicChangeReason: "same-topic" as const,
      complexity: "low" as const,
    };
    const {
      handlers,
      classifier,
      topicChecker,
      instructionWriter,
      record,
      emitAgentEvent,
    } = createTopicFlowHarness({
      historicalIntents: [
        {
          input: "plan topic checker",
          intent: "coding",
          keywords: ["topic", "checker"],
          topic: "topic / checker",
          domain: "coding",
          confidence: 0.85,
          complexity: "high",
        },
      ],
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(topicChecker).toHaveBeenCalledOnce();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(result?.prependContext).toBeUndefined();
    expect(emittedPhaseStates(emitAgentEvent)).toEqual(
      expect.arrayContaining([
        "intent-classification:completed",
        "instruction-hint-generation:completed",
      ]),
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "intent-classification",
          state: "completed",
          intent: "coding",
          domain: "coding",
          confidence: 0.85,
          complexity: "low",
        }),
      }),
    );
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "same-topic-inheritance:completed",
        "prompt-prefix-injection:skipped",
      ]),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          input: "implement topic checker",
          intent: expect.objectContaining({
            result: expect.objectContaining({
              intent: "coding",
              domain: "coding",
              topicChangeReason: undefined,
            }),
          }),
        }),
      }),
    );
    expect(record.mock.calls[0][1].current.intent.input).toBeUndefined();
  });

  it("does not emit pipeline failure details when classification throws", async () => {
    const classifier = vi.fn().mockRejectedValue("classifier string failure");
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
      classifier,
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toBeUndefined();
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining(["pipeline-failed:failed"]),
    );
  });

  it("resolves the session key before fail-open classifier errors", async () => {
    const classifier = vi.fn().mockRejectedValue("classifier string failure");
    const resolvedSessionKey = "agent:main:discord:direct:resolved";
    const { handlers } = createTopicFlowHarness({
      historicalIntents: [],
      classifier,
      api: {
        runtime: {
          agent: {
            session: {
              resolveStorePath: vi.fn().mockReturnValue("store-path"),
              loadSessionStore: vi.fn().mockReturnValue({
                data: { entries: [{ key: resolvedSessionKey }] },
              }),
            },
          },
        } as never,
      },
    });

    const result = await handlers.onBeforePromptBuild(event, {
      ...ctx,
      messageProvider: "webchat",
      sessionKey: undefined,
    });

    expect(result).toBeUndefined();
  });

  it("uses the session key as the pipeline run id when runId is unavailable", async () => {
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "hi",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      {
        ...ctx,
        runId: undefined,
      },
    );

    expect(result?.prependContext).toContain("<intention_hint_plugin");
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "agent:main:direct:123",
        sessionKey: "agent:main:direct:123",
        stream: "plugin:intention-hint",
      }),
    );
  });
});
