import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { createHookHandlers } from "./index.js";
import { SKILL_HARNESS_SYSTEM_CONTEXT } from "./system-context.js";
import { defaultTracker } from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { defaultCatalog, filterIntentsForAgent } from "../intents/index.js";
import type { IntentCatalogEntry } from "../types.js";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness";

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  emitAgentEvent: vi.fn(),
}));

const emitHostAgentEvent = vi.mocked(emitAgentEvent);

function createHandlers(api: Partial<OpenClawPluginApi> = {}) {
  return createHookHandlers({
    api: api as OpenClawPluginApi,
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
    const resolveCurrentSessionId = vi.spyOn(
      defaultTracker,
      "resolveCurrentSessionId",
    );
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

    expect(resolveCurrentSessionId).toHaveBeenCalledWith({});
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not record tool calls before intent data exists", async () => {
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      undefined,
    );
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

    expect(defaultTracker.resolveCurrentSessionId).toHaveBeenCalledWith({
      sessionId: "session-without-intent",
    });
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("records skill metadata from full read output while storing truncated tool output", async () => {
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "session-1",
    );
    const record = vi.spyOn(defaultTracker, "record");
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    const longSkillOutput = `---
name: skill-harness
description: "Design, inventory, evolve, or extract intent definitions for the skill-harness plugin. Use when creating/refining a single intent (design), bootstrapping or re-auditing the full catalog (inventory), processing a review finding (review), or analyzing intent complexity and extracting oversized intents into skills (extract)."
---

# Skill Harness`;

    await createHandlers().onAfterToolCall(
      {
        toolName: "read",
        params: { path: "/skills/skill-harness/SKILL.md" },
        result: longSkillOutput,
        durationMs: 1,
      } as never,
      { sessionKey: "agent:main:discord:channel:1490722656197152878" },
    );

    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          skillsUsed: [
            expect.objectContaining({
              name: "skill-harness",
              path: "/skills/skill-harness/SKILL.md",
            }),
          ],
          toolCalls: [
            expect.objectContaining({
              result: longSkillOutput.slice(0, 200),
            }),
          ],
        }),
      }),
    );
  });

  it("records skill metadata from successful skill_view output", async () => {
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "session-1",
    );
    const record = vi.spyOn(defaultTracker, "record");
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    const skillViewOutput = JSON.stringify({
      success: true,
      name: "skill-harness",
      description: "Harness skills.",
      path: "/skills/skill-harness/SKILL.md",
      skill_dir: "/skills/skill-harness",
    });

    await createHandlers().onAfterToolCall(
      {
        toolName: "skill_view",
        params: { name: "skill-harness" },
        result: skillViewOutput,
        durationMs: 1,
      } as never,
      { sessionKey: "agent:main:discord:channel:1490722656197152878" },
    );

    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          skillsUsed: [
            expect.objectContaining({
              name: "skill-harness",
              path: "/skills/skill-harness/SKILL.md",
              description: "Harness skills.",
            }),
          ],
        }),
      }),
    );
  });

  it("records skill metadata from persisted tool results when after_tool_call is unavailable", async () => {
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "session-1",
    );
    const record = vi.spyOn(defaultTracker, "record");
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    const skillOutput = `---
name: tokyo
description: Navigate Tokyo.
---

# Tokyo`;
    const handlers = createHandlers();

    await handlers.onBeforeToolCall(
      {
        toolName: "read",
        params: { path: "/home/ani/.openclaw/skills/tokyo/SKILL.md" },
        toolCallId: "call-read-tokyo",
      } as never,
      {
        sessionKey: "agent:main:discord:direct:529296776637972480",
        toolName: "read",
        toolCallId: "call-read-tokyo",
      } as never,
    );
    handlers.onToolResultPersist(
      {
        toolName: "read",
        toolCallId: "call-read-tokyo",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: skillOutput }],
        },
      } as never,
      {
        sessionKey: "agent:main:discord:direct:529296776637972480",
        toolName: "read",
        toolCallId: "call-read-tokyo",
      } as never,
    );

    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          skillsUsed: [
            expect.objectContaining({
              name: "tokyo",
              path: "/home/ani/.openclaw/skills/tokyo/SKILL.md",
            }),
          ],
          toolCalls: [
            expect.objectContaining({
              name: "read",
              result: skillOutput.slice(0, 200),
            }),
          ],
        }),
      }),
    );
  });

  it("does not double-record a persisted tool result when after_tool_call also arrives", async () => {
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "session-1",
    );
    const record = vi.spyOn(defaultTracker, "record");
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    const handlers = createHandlers();

    await handlers.onBeforeToolCall(
      {
        toolName: "read",
        params: { path: "/home/ani/.openclaw/skills/tokyo/SKILL.md" },
        toolCallId: "call-read-tokyo",
      } as never,
      {
        sessionKey: "agent:main:discord:direct:529296776637972480",
        toolName: "read",
        toolCallId: "call-read-tokyo",
      } as never,
    );
    handlers.onToolResultPersist(
      {
        toolName: "read",
        toolCallId: "call-read-tokyo",
        message: { role: "toolResult", content: "ok" },
      } as never,
      {
        sessionKey: "agent:main:discord:direct:529296776637972480",
        toolName: "read",
        toolCallId: "call-read-tokyo",
      } as never,
    );
    await handlers.onAfterToolCall(
      {
        toolName: "read",
        params: { path: "/home/ani/.openclaw/skills/tokyo/SKILL.md" },
        toolCallId: "call-read-tokyo",
        result: "ok",
      } as never,
      {
        sessionKey: "agent:main:discord:direct:529296776637972480",
        toolName: "read",
        toolCallId: "call-read-tokyo",
      } as never,
    );

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("resolves the canonical session key for tool tracking when hook context omits it", async () => {
    const sessionKey = "agent:main:discord:direct:529296776637972480";
    const api = {
      runtime: {
        agent: {
          session: {
            listSessionEntries: vi.fn().mockReturnValue([
              {
                sessionKey,
                entry: { sessionId: "stale-event-session" },
              },
            ]),
          },
        },
      },
    };
    const resolveCurrentSessionId = vi
      .spyOn(defaultTracker, "resolveCurrentSessionId")
      .mockReturnValue("latest-prompt-session");
    const record = vi.spyOn(defaultTracker, "record");
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);

    await createHandlers(api).onAfterToolCall(
      {
        toolName: "read",
        params: { path: "/skills/nuwa-skill/SKILL.md" },
        result: "ok",
        durationMs: 1,
      } as never,
      { sessionId: "stale-event-session", agentId: "main" },
    );

    expect(api.runtime.agent.session.listSessionEntries).toHaveBeenCalledWith({
      agentId: "main",
    });
    expect(resolveCurrentSessionId).toHaveBeenCalledWith({
      sessionId: "stale-event-session",
      sessionKey,
    });
    expect(record).toHaveBeenCalledWith(
      "latest-prompt-session",
      expect.objectContaining({
        current: expect.objectContaining({
          toolCalls: [expect.objectContaining({ name: "read" })],
        }),
      }),
    );
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
        skills: ["git-master"],
        fastpath: { keywords: [] },
        prompt: "Follow the version-control workflow.",
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

  it("aggregates the completed current turn before agent finalize", async () => {
    const state = {
      input: "read vue skill",
      intent: {
        result: {
          intent: "skill-lifecycle",
          reason: "test",
          domain: "agent-ops",
          confidence: 0.9,
          complexity: "low" as const,
        },
      },
      timestamps: { start: "2026-07-07T10:22:10.674Z" },
    };
    const definition = {
      id: "skill-lifecycle",
      definition: {
        triggers: ["skill"],
        examples: [],
        domain: "agent-ops",
        skills: ["vue"],
        fastpath: { keywords: [] },
        prompt: "Follow the skill workflow.",
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

    await createHandlers().onBeforeAgentFinalize(
      {
        sessionId: "event-context-session",
        sessionKey: "agent:main:discord:direct:529296776637972480",
        lastAssistantMessage: "done",
        messages: [],
      } as never,
      {} as never,
    );

    expect(recordStats).toHaveBeenCalledWith(
      "event-context-session",
      state,
      definition,
    );
  });

  it("aggregates agent_end using the tracked session resolved from sessionKey", async () => {
    const state = {
      input: "read skill-harness",
      intent: {
        result: {
          intent: "skill-lifecycle",
          reason: "test",
          domain: "agent-ops",
          confidence: 0.9,
          complexity: "low" as const,
        },
      },
      timestamps: { start: "2026-07-06T15:47:27.004Z" },
    };
    const definition = {
      id: "skill-lifecycle",
      definition: {
        triggers: ["skill"],
        examples: [],
        domain: "agent-ops",
        skills: ["skill-harness"],
        fastpath: { keywords: [] },
        prompt: "Follow the skill workflow.",
      },
    };
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "tracked-session",
    );
    vi.spyOn(defaultTracker, "record").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "getCurrentState").mockReturnValue(state);
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const recordStats = vi
      .spyOn(defaultStatsAggregator, "record")
      .mockReturnValue(true);

    await createHandlers().onAgentEnd(
      { messages: [{ role: "assistant", content: "done" }] } as never,
      {
        sessionId: "event-context-session",
        sessionKey: "agent:main:discord:channel:1490722656197152878",
      } as never,
    );

    expect(recordStats).toHaveBeenCalledWith(
      "tracked-session",
      state,
      definition,
    );
  });

  it("aggregates agent_end using canonical session key when hook context omits it", async () => {
    const sessionKey = "agent:main:discord:direct:529296776637972480";
    const api = {
      runtime: {
        agent: {
          session: {
            listSessionEntries: vi.fn().mockReturnValue([
              {
                sessionKey,
                entry: { sessionId: "stale-event-session" },
              },
            ]),
          },
        },
      },
    };
    const state = {
      input: "read nuwa skill",
      intent: {
        result: {
          intent: "skill-lifecycle",
          reason: "test",
          domain: "agent-ops",
          confidence: 0.9,
          complexity: "low" as const,
        },
      },
      timestamps: { start: "2026-07-07T10:07:46.061Z" },
    };
    const definition = {
      id: "skill-lifecycle",
      definition: {
        triggers: ["skill"],
        examples: [],
        domain: "agent-ops",
        skills: ["skill-lifecycle"],
        fastpath: { keywords: [] },
        prompt: "Follow the skill lifecycle workflow.",
      },
    };
    vi.spyOn(defaultTracker, "resolveCurrentSessionId").mockReturnValue(
      "latest-prompt-session",
    );
    vi.spyOn(defaultTracker, "record").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "write").mockImplementation(() => undefined);
    vi.spyOn(defaultTracker, "getCurrentState").mockReturnValue(state);
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const recordStats = vi
      .spyOn(defaultStatsAggregator, "record")
      .mockReturnValue(true);

    await createHandlers(api).onAgentEnd(
      { messages: [{ role: "assistant", content: "done" }] } as never,
      { sessionId: "stale-event-session", agentId: "main" },
    );

    expect(api.runtime.agent.session.listSessionEntries).toHaveBeenCalledWith({
      agentId: "main",
    });
    expect(defaultTracker.resolveCurrentSessionId).toHaveBeenCalledWith({
      sessionId: "stale-event-session",
      sessionKey,
    });
    expect(recordStats).toHaveBeenCalledWith(
      "latest-prompt-session",
      state,
      definition,
    );
  });

  it("does not aggregate agent_end without a tracked current turn", async () => {
    vi.spyOn(defaultTracker, "hasIntentData").mockReturnValue(false);
    const recordStats = vi.spyOn(defaultStatsAggregator, "record");

    await createHandlers().onAgentEnd({ messages: [] } as never, {});

    expect(recordStats).not.toHaveBeenCalled();
  });

  it("enqueues enabled multi-trigger review without awaiting it", async () => {
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
        skills: ["analysis"],
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\n- Ask for context.",
      },
    };
    vi.spyOn(defaultCatalog, "get").mockReturnValue([definition]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-review-skills-"));
    const workspaceDir = path.join(tmp, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "analysis");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: analysis\ndescription: Break down unclear tasks.\n---\n",
    );
    const enqueue = vi.fn();
    const reviewer = vi.fn().mockResolvedValue({
      findings: [],
      outcome: "nofinding" as const,
      noFindingReasonCounts: { "wrong-trigger": 1 },
    });
    const reviewLogWriter = { record: vi.fn() };
    const handlers = createHookHandlers({
      api: {
        config: {},
        runtime: {
          state: { resolveStateDir: () => "/missing-state" },
          agent: {
            resolveAgentWorkspaceDir: () => workspaceDir,
          },
        },
      } as unknown as OpenClawPluginApi,
      config: () =>
        resolveConfig({
          review: {
            enabled: true,
            model: "google/test-review",
          },
        }),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
      reviewQueue: { enqueue },
      reviewer,
      reviewLogWriter,
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
          availableSkills: [
            {
              name: "analysis",
              location: path.join(skillDir, "SKILL.md"),
              description: "Break down unclear tasks.",
            },
          ],
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
    expect(reviewLogWriter.record).toHaveBeenCalledWith(
      snapshot.eventId,
      expect.objectContaining({ sessionId: "session-1" }),
      [],
      {
        triggers: [
          "skill-candidate",
          "satisfaction-check",
          "missing-intent",
          "weak-intent",
          "behavior-fix",
        ],
        outcome: "nofinding",
        noFindingReasonCounts: { "wrong-trigger": 1 },
      },
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

  it.each([
    "new",
    "reset",
    "idle",
    "daily",
    "compaction",
    "deleted",
    "shutdown",
    "restart",
    "unknown",
    undefined,
  ] as const)(
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

  it("injects static context for inter-session turns without refreshing config or intents", async () => {
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
    expect(refreshIntents).not.toHaveBeenCalled();
  });

  it("injects static context for legacy inter-session marker turns", async () => {
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
  });

  it("injects static context for protected internal completion envelopes", async () => {
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
  });

  it("injects static context for a scoped non-user trigger without dynamic work", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const refreshIntents = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents,
    });

    const result = await handlers.onBeforePromptBuild(
      { prompt: "heartbeat", messages: [] },
      {
        trigger: "heartbeat",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
    expect(refreshIntents).not.toHaveBeenCalled();
  });

  it("injects static context when trigger is omitted but the session is scoped", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const refreshIntents = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents,
    });

    const result = await handlers.onBeforePromptBuild(
      { prompt: "background task", messages: [] },
      {
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(refreshLiveConfigFromRuntime).not.toHaveBeenCalled();
    expect(refreshIntents).not.toHaveBeenCalled();
  });

  it.each([
    "agent:main:direct:123:skill-harness:hint",
    "agent:main:direct:123:subagent:worker",
    "agent:main:dreaming-narrative-light-123",
    "agent:main:direct:123:active-memory:worker",
  ])("does not inject into excluded session %s", async (sessionKey) => {
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
    });

    const result = await handlers.onBeforePromptBuild(
      { prompt: "internal task", messages: [] },
      {
        trigger: "manual",
        agentId: "main",
        sessionKey,
      },
    );

    expect(result).toBeUndefined();
  });

  it.each([
    {
      label: "disabled agent",
      config: { agents: ["other"] },
    },
    {
      label: "disallowed chat type",
      config: { allowedChatTypes: ["group"] },
    },
    {
      label: "chat id absent from allowlist",
      config: { allowedChatIds: ["direct:999"] },
    },
    {
      label: "denied chat id",
      config: { deniedChatIds: ["direct:123"] },
    },
  ])("does not inject for $label", async ({ config }) => {
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig(config as never),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
    });

    const result = await handlers.onBeforePromptBuild(
      { prompt: "background task", messages: [] },
      {
        trigger: "heartbeat",
        agentId: "main",
        sessionKey: "agent:main:direct:123",
      },
    );

    expect(result).toBeUndefined();
  });

  it("fails closed when chat type cannot be resolved", async () => {
    const refreshLiveConfigFromRuntime = vi.fn();
    const handlers = createHookHandlers({
      api: { config: {} } as OpenClawPluginApi,
      config: () => resolveConfig({}),
      refreshLiveConfigFromRuntime,
      refreshIntents: vi.fn(),
    });

    const result = await handlers.onBeforePromptBuild(
      { prompt: "background task", messages: [] },
      {
        trigger: "heartbeat",
        agentId: "main",
        sessionKey: "agent:main:main",
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

  function writeSkill(
    root: string,
    name: string,
    description: string,
    relatedSkills: Record<string, string> = {},
  ): void {
    const dir = path.join(root, name);
    const relatedSkillsFrontmatter = Object.entries(relatedSkills).length
      ? `metadata:\n  related-skills:\n${Object.entries(relatedSkills)
          .map(([relatedName, reason]) => `    ${relatedName}: ${reason}`)
          .join("\n")}\n`
      : "";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n${relatedSkillsFrontmatter}---\n\n# ${name}\n`,
    );
  }

  function createTopicFlowHarness(params: {
    historicalIntents: ReturnType<
      typeof defaultTracker.getHistoricalIntentRecords
    >;
    configRaw?: Parameters<typeof resolveConfig>[0];
    intents?: IntentCatalogEntry[];
    classifier?: ReturnType<typeof vi.fn>;
    topicChecker?: ReturnType<typeof vi.fn>;
    instructionWriter?: ReturnType<typeof vi.fn>;
    api?: Partial<OpenClawPluginApi>;
    bundledSkillsDir?: string;
  }) {
    emitHostAgentEvent.mockReset();
    const intents = params.intents ?? [intent];
    const record = vi.fn();
    const rotate = vi.fn();
    const write = vi.fn();
    const tracker = {
      getHistoricalIntentRecords: vi
        .fn()
        .mockReturnValue(params.historicalIntents),
      resolveCurrentSessionId: vi.fn().mockReturnValue(undefined),
      rotate,
      record,
      write,
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
        changed: false,
        topicChangeReason: "start",
        confidence: 0.9,
        complexity: "medium" as const,
      });
    const topicChecker = params.topicChecker ?? vi.fn();
    const instructionWriter =
      params.instructionWriter ??
      vi.fn().mockResolvedValue({
        instructionHint: "Follow the generated coding instructions.",
        additionalCandidateSkills: [],
      });
    const emitAgentEvent = emitHostAgentEvent;
    const rawConfig = {
      model: "google/test-intent",
      ...((params.configRaw as Record<string, unknown> | undefined) ?? {}),
      instruction: {
        enabled: true,
        ...((
          params.configRaw as
            { instruction?: Record<string, unknown> } | undefined
        )?.instruction ?? {}),
      },
    };
    const handlers = createHookHandlers({
      api: {
        config: {},
        ...params.api,
      } as unknown as OpenClawPluginApi,
      config: () => resolveConfig(rawConfig),
      refreshLiveConfigFromRuntime: vi.fn(),
      refreshIntents: vi.fn(),
      catalog: catalog as never,
      tracker: tracker as never,
      classifier,
      topicChecker,
      instructionWriter,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    return {
      handlers,
      tracker,
      classifier,
      topicChecker,
      instructionWriter,
      rotate,
      record,
      write,
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

  const metadataPrefix = `Conversation info (untrusted metadata):
\`\`\`json
{
  "chat_id": "user:529296776637972480",
  "message_id": "1524097597906620690",
  "sender_id": "529296776637972480",
  "sender": "烤雞堡",
  "timestamp": "Wed 2026-07-08 00:59:43 GMT+8",
  "inbound_event_kind": "user_request"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "烤雞堡 (529296776637972480)",
  "id": "529296776637972480",
  "name": "烤雞堡",
  "username": "wei840222",
  "tag": "wei840222"
}
\`\`\`

System: [2026-07-08 00:54:40 GMT+8] Model switched to openai/gpt-5.5.`;

  it("strips platform metadata from latest, historical, and recorded prompt text", async () => {
    const rawLatest = `${metadataPrefix}\n\n進入 inventory 模式先 scan吧`;
    const rawHistorical = `${metadataPrefix}\n\n跟我詳細解說 skill-harness 技能`;
    const topicChecker = vi.fn().mockResolvedValue({
      keywords: ["inventory", "scan"],
      topic: "User wants inventory scanning.",
      domain: "tools",
      changed: true,
      reason: "shift",
      complexity: "medium" as const,
    });
    const classifier = vi.fn().mockResolvedValue({
      intent: "tool-reference",
      reason: "inventory request",
      keywords: ["inventory", "scan"],
      topic: "User wants inventory scanning.",
      domain: "tools",
      topicChangeReason: "shift",
      confidence: 0.9,
      complexity: "medium" as const,
    });
    const { handlers, record } = createTopicFlowHarness({
      historicalIntents: [
        {
          input: rawHistorical,
          intent: "tool-reference",
          domain: "tools",
          topic: "User requests skill-harness explanation.",
          keywords: ["skill-harness", "explanation"],
          topicChangeReason: "start",
        },
      ],
      configRaw: { instruction: { enabled: false } },
      topicChecker,
      classifier,
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: rawLatest,
        messages: [
          {
            role: "user",
            content: rawLatest,
            provenance: { kind: "external_user" },
          },
        ],
      } as never,
      ctx,
    );

    expect(topicChecker).toHaveBeenCalledWith(
      expect.objectContaining({
        latest: "進入 inventory 模式先 scan吧",
        conversation: [
          expect.objectContaining({
            role: "user",
            text: "進入 inventory 模式先 scan吧",
          }),
        ],
        history: [
          expect.objectContaining({
            input: "跟我詳細解說 skill-harness 技能",
          }),
        ],
      }),
    );
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({ latest: "進入 inventory 模式先 scan吧" }),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          input: "進入 inventory 模式先 scan吧",
          intent: expect.objectContaining({
            input: [
              expect.objectContaining({
                role: "user",
                text: "進入 inventory 模式先 scan吧",
              }),
            ],
          }),
        }),
      }),
    );
  });

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

    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(result?.prependContext).toContain("Reply warmly.");
    expect(result?.prependContext).not.toContain("## Guidelines");
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "topic-triage:completed",
    );
    expect(emittedPhaseStates(emitAgentEvent)[0]).toBe("pipeline:started");
    expect(emittedPhaseStates(emitAgentEvent).at(-1)).toBe(
      "pipeline:completed",
    );
    expect(emittedPipelineEvents(emitAgentEvent).at(-1)?.data).toEqual(
      expect.objectContaining({ durationMs: expect.any(Number) }),
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
              topicChangeReason: "start",
            }),
            instructionText: "Reply warmly.",
          }),
        }),
      }),
    );
  });

  it("skips exact keyword hints when instruction config is disabled", async () => {
    const fastEvent = {
      prompt: "謝謝",
      messages: [{ role: "user", content: "謝謝" }],
    } as never;
    const { handlers, classifier, topicChecker, instructionWriter, record } =
      createTopicFlowHarness({
        historicalIntents: [],
        configRaw: {
          model: "google/test-intent",
          instruction: { enabled: false },
        },
      });

    const result = await handlers.onBeforePromptBuild(fastEvent, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.not.objectContaining({
            instructionText: expect.any(String),
          }),
        }),
      }),
    );
  });

  it("keeps deterministic exact keyword hints in low thinking fastpath-only mode", async () => {
    const fastEvent = {
      prompt: "謝謝",
      messages: [{ role: "user", content: "謝謝" }],
    } as never;
    const { handlers, classifier, topicChecker, instructionWriter } =
      createTopicFlowHarness({ historicalIntents: [] });

    const result = await handlers.onBeforePromptBuild(fastEvent, {
      ...ctx,
      reasoningEffort: "low",
    } as never);

    expect(result?.prependContext).toContain("Reply warmly.");
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
  });

  it("skips every LLM subagent when low thinking fastpath-only mode has no exact keyword match", async () => {
    const { handlers, classifier, topicChecker, instructionWriter, record } =
      createTopicFlowHarness({ historicalIntents: [] });

    const result = await handlers.onBeforePromptBuild(event, {
      ...ctx,
      reasoningEffort: "low",
    } as never);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("skips exact keyword hints when low thinking mode is off", async () => {
    const fastEvent = {
      prompt: "謝謝",
      messages: [{ role: "user", content: "謝謝" }],
    } as never;
    const { handlers, classifier, topicChecker, instructionWriter, record } =
      createTopicFlowHarness({
        historicalIntents: [],
        configRaw: {
          model: "google/test-intent",
          lowThinkingMode: "off",
        },
      });

    const result = await handlers.onBeforePromptBuild(fastEvent, {
      ...ctx,
      reasoningEffort: "minimal",
    } as never);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(topicChecker).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("runs the full scanner pipeline for low thinking when configured to full", async () => {
    const { handlers, classifier, topicChecker, instructionWriter } =
      createTopicFlowHarness({
        historicalIntents: [],
        configRaw: {
          model: "google/test-intent",
          lowThinkingMode: "full",
        },
      });

    const result = await handlers.onBeforePromptBuild(event, {
      ...ctx,
      reasoningEffort: "off",
    } as never);

    expect(result?.prependContext).toContain(
      "Follow the generated coding instructions.",
    );
    expect(topicChecker).toHaveBeenCalledOnce();
    expect(classifier).toHaveBeenCalledOnce();
    expect(instructionWriter).toHaveBeenCalledOnce();
  });

  it("persists prompt-build intent data for exact keyword matches", async () => {
    const fastEvent = {
      prompt: "謝謝",
      messages: [{ role: "user", content: "謝謝" }],
    } as never;
    const { handlers, rotate, record, write } = createTopicFlowHarness({
      historicalIntents: [],
    });

    await handlers.onBeforePromptBuild(fastEvent, ctx);

    expect(rotate).toHaveBeenCalledWith("session-1");
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionKey: "agent:main:direct:123",
        agentId: "main",
        current: expect.objectContaining({
          input: "謝謝",
          intent: expect.objectContaining({
            input: expect.arrayContaining([
              expect.objectContaining({ role: "user", text: "謝謝" }),
            ]),
            trigger: "exact-keyword",
            result: expect.objectContaining({
              intent: "social-casual",
              topicChangeReason: "start",
            }),
            instructionText: "Reply warmly.",
          }),
          timestamps: expect.objectContaining({ start: expect.any(String) }),
        }),
      }),
    );
    expect(write).toHaveBeenCalledWith("session-1");
  });

  it("uses a resolved session key for prompt-build eligibility when hook ctx omits it", async () => {
    const fastEvent = {
      prompt: "謝謝",
      messages: [{ role: "user", content: "謝謝" }],
    } as never;
    const resolvedSessionKey = "agent:main:discord:direct:resolved";
    const { handlers, rotate, record, write } = createTopicFlowHarness({
      historicalIntents: [],
      api: {
        runtime: {
          agent: {
            session: {
              listSessionEntries: vi.fn().mockReturnValue([
                {
                  sessionKey: resolvedSessionKey,
                  entry: { sessionId: ctx.sessionId },
                },
              ]),
            },
          },
        } as never,
      },
    });

    const result = await handlers.onBeforePromptBuild(fastEvent, {
      ...ctx,
      sessionKey: undefined,
      channelId: undefined,
      messageProvider: undefined,
    });

    expect(result?.prependContext).toContain("Reply warmly.");
    expect(rotate).toHaveBeenCalledWith("session-1");
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionKey: resolvedSessionKey,
        current: expect.objectContaining({
          input: "謝謝",
        }),
      }),
    );
    expect(write).toHaveBeenCalledWith("session-1");
  });

  it("records prompt-build data into the current keyed session when hook ctx omits sessionId", async () => {
    const fastEvent = {
      prompt: "qrcode",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    } as never;
    const { handlers, tracker, rotate, record, write } = createTopicFlowHarness(
      {
        historicalIntents: [],
      },
    );
    tracker.resolveCurrentSessionId.mockReturnValue("session-1");

    const result = await handlers.onBeforePromptBuild(fastEvent, {
      ...ctx,
      sessionId: undefined,
    });

    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(tracker.resolveCurrentSessionId).toHaveBeenCalledWith({
      sessionKey: "agent:main:direct:123",
    });
    expect(rotate).toHaveBeenCalledWith("session-1");
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionKey: "agent:main:direct:123",
        current: expect.objectContaining({
          input: "qrcode",
        }),
      }),
    );
    expect(write).toHaveBeenCalledWith("session-1");
  });

  it("does not persist prompt-build intent data without a session id or current keyed session", async () => {
    const { handlers, rotate, record, write } = createTopicFlowHarness({
      historicalIntents: [],
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "hi",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      {
        ...ctx,
        sessionId: undefined,
      },
    );

    expect(rotate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
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

  it("emits topic checker no-context failures with only an error", async () => {
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
      topicChecker: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(event, ctx);

    const failedEvent = emittedPipelineEvents(emitAgentEvent).find(
      (event) =>
        event.data.phase === "topic-triage" && event.data.state === "failed",
    );
    expect(failedEvent?.data).toEqual(
      expect.objectContaining({
        error: "topic checker returned no context",
      }),
    );
    expect(failedEvent?.data).not.toHaveProperty("reason");
    expect(failedEvent?.data).not.toHaveProperty("result");
  });

  it("emits classifier no-result failures with only an error", async () => {
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
      topicChecker: vi.fn().mockResolvedValue(undefined),
      classifier: vi.fn().mockResolvedValue(undefined),
    });

    await handlers.onBeforePromptBuild(event, ctx);

    const failedEvent = emittedPipelineEvents(emitAgentEvent).find(
      (event) =>
        event.data.phase === "intent-classify" && event.data.state === "failed",
    );
    expect(failedEvent?.data).toEqual(
      expect.objectContaining({
        error: "classifier returned no result",
      }),
    );
    expect(failedEvent?.data).not.toHaveProperty("reason");
    expect(failedEvent?.data).not.toHaveProperty("result");
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
      name: "match",
      history: {
        input: "fix this",
        intent: "coding",
        topic: "User is fixing code.",
        confidence: 0.8,
        complexity: "medium" as const,
      },
      expected: {
        previousTopic: "User is fixing code.",
        topicChangeReason: "match",
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

    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(result?.appendSystemContext).toBe(SKILL_HARNESS_SYSTEM_CONTEXT);
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
      basis: "Latest asks for a git commit and matches the git domain.",
      keywords: ["comit"],
      topic: "User wants a git commit.",
      domain: "git",
      changed: false,
      reason: undefined,
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(topicChecker).toHaveBeenCalledOnce();
    expect(topicChecker).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ["chat", "git"] }),
    );
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "topic-triage:completed",
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "topic-triage",
          state: "completed",
          basis: "Latest asks for a git commit and matches the git domain.",
          changed: false,
        }),
      }),
    );
    expect(emittedPhaseStates(emitAgentEvent)).toContain(
      "intent-classify:completed",
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "intent-classify",
          state: "completed",
          intent: "version-control",
          reason: "Topic keyword similarity match: comit -> commit",
          confidence: expect.closeTo(0.833, 0.01),
        }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            trigger: "topic-keyword-similarity",
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
        changed: true,
        reason: "start" as const,
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

    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          intent: "version-control",
          domain: "git",
          topicChangeReason: "start",
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
        changed: true,
        reason: "start" as const,
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
        changed: true,
        reason: "start" as const,
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
        changed: true,
        reason: "start" as const,
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
        changed: true,
        reason: "start" as const,
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
    const { handlers, classifier, instructionWriter, record, emitAgentEvent } =
      createTopicFlowHarness({
        historicalIntents: [
          {
            input: "commit this",
            intent: "version-control",
            keywords: ["legacy-keyword"],
            topic: "Legacy commit topic.",
            domain: "legacy-git",
            confidence: 0.9,
            complexity: "medium",
          },
        ],
        intents: [versionControlIntent],
        topicChecker: vi.fn().mockResolvedValue({
          basis: "Latest message continues the commit workflow.",
          keywords: ["commit", "follow-up"],
          topic: "User is still discussing a git commit.",
          domain: "git",
          changed: false,
          reason: "same-topic" as const,
          confidence: 0.8,
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(classifier).not.toHaveBeenCalled();
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          input: "commit it",
          intent: expect.objectContaining({
            trigger: "same-topic",
            result: expect.objectContaining({
              intent: "version-control",
              keywords: ["commit", "follow-up"],
              topic: "User is still discussing a git commit.",
              domain: "git",
              confidence: 0.9,
              complexity: "low",
            }),
          }),
        }),
      }),
    );
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "topic-triage",
          state: "completed",
          confidence: 0.8,
        }),
      }),
    );
  });

  it("routes low-confidence same-topic results through the classifier", async () => {
    const topicContext = {
      basis: "Latest message may continue the commit workflow.",
      keywords: ["commit"],
      topic: "User may still be discussing a git commit.",
      domain: "git",
      changed: false,
      reason: "same-topic" as const,
      confidence: 0.79,
      complexity: "low" as const,
    };
    const { handlers, classifier, record } = createTopicFlowHarness({
      historicalIntents: [
        {
          input: "commit this",
          intent: "version-control",
          keywords: ["commit"],
          topic: "User wants a git commit.",
          domain: "git",
          confidence: 0.9,
          complexity: "medium",
        },
      ],
      intents: [versionControlIntent],
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    await handlers.onBeforePromptBuild(
      {
        prompt: "commit it",
        messages: [{ role: "user", content: "commit it" }],
      } as never,
      ctx,
    );

    expect(classifier).toHaveBeenCalledOnce();
    expect(classifier).toHaveBeenCalledWith(
      expect.objectContaining({ topicContext }),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({ trigger: "classifier" }),
        }),
      }),
    );
  });

  it("does not emit instruction hint events when confidence is undefined (treated as 0)", async () => {
    const classifier = vi.fn().mockResolvedValue({
      intent: "coding",
      reason: "User wants implementation",
      keywords: ["topic", "flow"],
      topic: "User wants implementation help for the topic flow.",
      changed: true,
      topicChangeReason: "start",
      // confidence intentionally omitted (undefined)
      complexity: "medium" as const,
    });
    const { handlers, instructionWriter, record, emitAgentEvent } =
      createTopicFlowHarness({
        historicalIntents: [],
        classifier,
      });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "hint-generate:started",
        "hint-generate:completed",
        "hint-generate:failed",
        "low-confidence-observation:completed",
        "prompt-prefix-injection:skipped",
      ]),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          input: "implement topic checker",
          intent: expect.objectContaining({
            input: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                text: "implement topic checker",
              }),
            ]),
            trigger: "classifier",
            result: expect.objectContaining({
              intent: "coding",
              topicChangeReason: "start",
            }),
          }),
        }),
      }),
    );
    expect(
      record.mock.calls[0][1].current.intent.instructionText,
    ).toBeUndefined();
  });

  it("skips hint injection when confidence is undefined (treated as 0)", async () => {
    const classifier = vi.fn().mockResolvedValue({
      intent: "coding",
      reason: "User wants implementation",
      keywords: ["topic", "flow"],
      topic: "User wants implementation help for the topic flow.",
      changed: true,
      topicChangeReason: "start",
      // confidence intentionally omitted (undefined)
      complexity: "medium" as const,
    });
    const { handlers, instructionWriter, record } = createTopicFlowHarness({
      historicalIntents: [],
      classifier,
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])(
    "reports a concrete instruction generation failure for missing error %j",
    async (error) => {
      const instructionWriter = vi.fn().mockResolvedValue({ error });
      const { handlers, record, emitAgentEvent } = createTopicFlowHarness({
        historicalIntents: [],
        instructionWriter,
      });

      const result = await handlers.onBeforePromptBuild(event, ctx);

      expect(instructionWriter).toHaveBeenCalledOnce();
      expect(result?.prependContext).toContain("<skill_harness_plugin");
      expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "hint-generate",
            state: "failed",
            error: "instruction writer produced invalid JSON",
          }),
        }),
      );
      const failedEvent = emittedPipelineEvents(emitAgentEvent).find(
        (event) =>
          event.data.phase === "hint-generate" && event.data.state === "failed",
      );
      expect(failedEvent?.data).not.toHaveProperty("reason");
      expect(failedEvent?.data).not.toHaveProperty("result");
      expect(emittedPipelineEvents(emitAgentEvent)).not.toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "hint-generate",
            state: "completed",
          }),
        }),
      );
      expect(record).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          current: expect.objectContaining({
            intent: expect.objectContaining({
              input: expect.arrayContaining([
                expect.objectContaining({
                  role: "user",
                  text: "implement topic checker",
                }),
              ]),
              result: expect.objectContaining({
                intent: "social-casual",
                topicChangeReason: "start",
              }),
            }),
          }),
        }),
      );
      expect(
        record.mock.calls[0][1].current.intent.instructionText,
      ).toBeUndefined();
    },
  );

  it("skips instruction writer hints when instruction config is disabled", async () => {
    const { handlers, instructionWriter, record, emitAgentEvent } =
      createTopicFlowHarness({
        historicalIntents: [],
        configRaw: {
          model: "google/test-intent",
          instruction: { enabled: false },
        },
      });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "hint-generate:started",
        "hint-generate:completed",
        "hint-generate:failed",
      ]),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining({
              intent: "social-casual",
              topicChangeReason: "start",
            }),
          }),
        }),
      }),
    );
    expect(
      record.mock.calls[0][1].current.intent.instructionText,
    ).toBeUndefined();
  });

  it("falls back to no prefix when instruction model cannot be resolved and no domain skills exist", async () => {
    const { handlers, instructionWriter, record, emitAgentEvent } =
      createTopicFlowHarness({
        historicalIntents: [],
        configRaw: {
          model: "google/test-intent",
          instruction: { enabled: true, model: "/" },
        },
      });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(instructionWriter).not.toHaveBeenCalled();
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "hint-generate:started",
        "hint-generate:completed",
        "hint-generate:failed",
      ]),
    );
    expect(record).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        current: expect.objectContaining({
          intent: expect.objectContaining({
            result: expect.objectContaining({
              intent: "social-casual",
              topicChangeReason: "start",
            }),
          }),
        }),
      }),
    );
    expect(
      record.mock.calls[0][1].current.intent.instructionText,
    ).toBeUndefined();
  });

  it("reports instruction generation errors without emitting a completed result", async () => {
    const instructionWriter = vi.fn().mockResolvedValue({
      error: "Model timed out",
    });
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
      instructionWriter,
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(instructionWriter).toHaveBeenCalledOnce();
    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(emittedPipelineEvents(emitAgentEvent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "hint-generate",
          state: "failed",
          error: "Model timed out",
        }),
      }),
    );
    const failedEvent = emittedPipelineEvents(emitAgentEvent).find(
      (event) =>
        event.data.phase === "hint-generate" && event.data.state === "failed",
    );
    expect(failedEvent?.data).not.toHaveProperty("reason");
    expect(failedEvent?.data).not.toHaveProperty("result");
    expect(emittedPipelineEvents(emitAgentEvent)).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "hint-generate",
          state: "completed",
        }),
      }),
    );
  });

  it("runs topic checker on the first tracked turn to seed topic metadata", async () => {
    const topicContext = {
      keywords: ["start", "topic"],
      topic: "User is starting an initial topic.",
      domain: "chat",
      changed: true,
      reason: "start" as const,
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
    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(emittedPhaseStates(emitAgentEvent)[0]).toBe("pipeline:started");
    expect(emittedPhaseStates(emitAgentEvent).at(-1)).toBe(
      "pipeline:completed",
    );
    expect(emittedPhaseStates(emitAgentEvent)).toEqual(
      expect.arrayContaining([
        "topic-triage:started",
        "topic-triage:completed",
        "intent-classify:started",
        "intent-classify:completed",
        "hint-generate:started",
        "hint-generate:completed",
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
            input: expect.arrayContaining([
              expect.objectContaining({
                role: "user",
                text: "implement topic checker",
              }),
            ]),
            result: expect.objectContaining({
              keywords: ["topic", "flow"], // classifier keywords preserved
              topic: "User is starting an initial topic.",
              domain: "chat",
              topicChangeReason: "start",
            }),
            instructionText: "Follow the generated coding instructions.",
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
      changed: true,
      reason: "marker" as const,
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
          complexity: "medium", // classifier value preserved, not topicContext override
          previousTopic: "topic / checker",
        }),
      }),
    );
  });

  it("derives final domain from the selected intent despite wrong topic and model domains", async () => {
    const topicContext = {
      keywords: ["deploy", "production", "kubernetes"],
      topic: "User is switching to a production deployment.",
      domain: "chat",
      changed: true,
      reason: "marker" as const,
      complexity: "high" as const,
    };
    const classifier = vi.fn().mockResolvedValue({
      intent: "version-control",
      reason: "User wants a deployment follow-up",
      keywords: "deploy" as unknown as string[],
      domain: "infra",
      confidence: 0.95,
      complexity: undefined,
    });
    const { handlers, instructionWriter } = createTopicFlowHarness({
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
      intents: [versionControlIntent],
      classifier,
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    await handlers.onBeforePromptBuild(event, ctx);

    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          keywords: ["deploy", "production", "kubernetes"],
          domain: "git",
          complexity: "high",
          previousTopic: "topic / checker",
        }),
      }),
    );
  });

  it("derives the fallback domain for an explicit other classification", async () => {
    const topicContext = {
      keywords: ["unclear", "request"],
      topic: "User request is unclear.",
      domain: "git",
      changed: true,
      reason: "shift" as const,
      complexity: "low" as const,
    };
    const classifier = vi.fn().mockResolvedValue({
      intent: "other",
      reason: "No catalog intent adequately explains the request",
      keywords: ["unclear", "request"],
      domain: "infra",
      confidence: 0.9,
      complexity: "low" as const,
    });
    const { handlers, instructionWriter } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [versionControlIntent],
      classifier,
      topicChecker: vi.fn().mockResolvedValue(topicContext),
    });

    await handlers.onBeforePromptBuild(event, ctx);

    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          intent: "other",
          domain: "other",
        }),
      }),
    );
  });

  it("passes referenced skill metadata to the instruction writer", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-hook-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");
    writeSkill(
      path.join(workspace, "skills"),
      "architecture-diagram",
      "Draw architecture diagrams.",
      { "visual-design": "Use visual design guidance for polished diagrams." },
    );
    writeSkill(
      path.join(workspace, "skills"),
      "visual-design",
      "Polish visual presentation.",
    );
    writeSkill(
      path.join(state, "plugin-skills"),
      "test-driven-development",
      "Drive changes with tests.",
    );
    writeSkill(path.join(state, "skills"), "blogwatcher", "Watch blogs.");
    writeSkill(bundled, "codegraph-analysis", "Analyze code graphs.");
    writeSkill(
      bundled,
      "search-discovered-skill",
      "A skill discovered by the hint writer.",
    );

    const skillIntent = {
      id: "architecture",
      definition: {
        triggers: ["diagram"],
        examples: ["draw architecture"],
        domain: "coding",
        skills: ["architecture-diagram"],
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\nDraw the requested architecture.",
      },
    };
    const testingIntent = {
      id: "testing",
      definition: {
        triggers: ["test"],
        examples: ["add tests"],
        domain: "coding",
        skills: ["test-driven-development"],
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\nUse test-driven development.",
      },
    };
    const researchIntent = {
      id: "research",
      definition: {
        triggers: ["research"],
        examples: ["watch blogs"],
        domain: "research",
        skills: ["blogwatcher"],
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\nWatch relevant blogs.",
      },
    };
    const codegraphIntent = {
      id: "codegraph",
      definition: {
        triggers: ["codegraph"],
        examples: ["analyze code graph"],
        domain: "coding",
        skills: ["codegraph-analysis"],
        fastpath: { keywords: [] },
        prompt: "## Guidelines\n\nAnalyze code graphs when requested.",
      },
    };
    const classifier = vi.fn().mockResolvedValue({
      intent: "architecture",
      reason: "User wants a diagram",
      keywords: ["diagram"],
      topic: "User wants an architecture diagram.",
      domain: "coding",
      topicChangeReason: "start",
      confidence: 0.95,
      complexity: "medium" as const,
    });
    const instructionWriter = vi.fn().mockResolvedValue({
      instructionHint:
        "MUST view skill: search-discovered-skill — it directly matches this turn.",
      additionalCandidateSkills: [
        "search-discovered-skill",
        "architecture-diagram",
        "missing-skill",
      ],
    });
    const { handlers } = createTopicFlowHarness({
      historicalIntents: [],
      intents: [skillIntent, testingIntent, researchIntent, codegraphIntent],
      classifier,
      instructionWriter,
      bundledSkillsDir: bundled,
      api: {
        runtime: {
          state: { resolveStateDir: () => state },
          agent: { resolveAgentWorkspaceDir: () => workspace },
        },
      } as unknown as Partial<OpenClawPluginApi>,
    });

    const result = await handlers.onBeforePromptBuild(
      {
        prompt: "draw architecture",
        messages: [{ role: "user", content: "draw architecture" }],
      } as never,
      ctx,
    );

    expect(instructionWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        availableSkills: [
          expect.objectContaining({
            name: "architecture-diagram",
            location: path.join(
              workspace,
              "skills",
              "architecture-diagram",
              "SKILL.md",
            ),
            description: "Draw architecture diagrams.",
          }),
          expect.objectContaining({
            name: "visual-design",
            location: path.join(
              workspace,
              "skills",
              "visual-design",
              "SKILL.md",
            ),
            description: "Polish visual presentation.",
          }),
        ],
      }),
    );
    expect(result?.prependContext).toContain("<domain_skill_candidates>");
    expect(result?.prependContext).toContain(
      "<name>architecture-diagram</name>",
    );
    expect(result?.prependContext).toContain(
      "<name>test-driven-development</name>",
    );
    expect(result?.prependContext).toContain(
      `<path>${path.join(state, "plugin-skills", "test-driven-development", "SKILL.md")}</path>`,
    );
    expect(result?.prependContext).toContain(
      "<description>Drive changes with tests.</description>",
    );
    expect(result?.prependContext).toContain("<name>codegraph-analysis</name>");
    expect(result?.prependContext).toContain(
      `<path>${path.join(bundled, "codegraph-analysis", "SKILL.md")}</path>`,
    );
    expect(result?.prependContext).toContain(
      "<description>Analyze code graphs.</description>",
    );
    expect(result?.prependContext).toContain("<related_skills>");
    expect(result?.prependContext).toContain("<related_skill>");
    expect(result?.prependContext).toContain("<name>visual-design</name>");
    expect(result?.prependContext).toContain(
      "<reason>Use visual design guidance for polished diagrams.</reason>",
    );
    expect(result?.prependContext).toContain(
      "<direction>current-to-related</direction>",
    );
    expect(result?.prependContext).toContain(
      "<name>search-discovered-skill</name>",
    );
    expect(result?.prependContext).toContain(
      `<path>${path.join(bundled, "search-discovered-skill", "SKILL.md")}</path>`,
    );
    expect(result?.prependContext).not.toContain("missing-skill");
    expect(result?.prependContext).toContain(
      "MUST view skill: search-discovered-skill — it directly matches this turn.",
    );
    expect(
      result?.prependContext.match(/<name>architecture-diagram<\/name>/g),
    ).toHaveLength(1);
    expect(result?.prependContext).not.toContain("blogwatcher");
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

  it("records same-topic continuations without classifier or hint events", async () => {
    const topicContext = {
      basis: "Latest message continues the topic checker implementation.",
      keywords: ["topic", "checker"],
      topic: "User is continuing work on the topic checker.",
      domain: "coding",
      changed: false,
      reason: "same-topic" as const,
      confidence: 0.9,
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
          intent: "social-casual",
          keywords: ["topic", "checker"],
          topic: "topic / checker",
          domain: "chat",
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
    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(emittedPhaseStates(emitAgentEvent)).not.toEqual(
      expect.arrayContaining([
        "intent-classify:started",
        "intent-classify:completed",
        "intent-classify:failed",
        "hint-generate:started",
        "hint-generate:completed",
        "hint-generate:failed",
      ]),
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
              intent: "social-casual",
              domain: "chat",
            }),
          }),
        }),
      }),
    );
    expect(record.mock.calls[0][1].current.intent.result).not.toHaveProperty(
      "topicChangeReason",
    );
    expect(record.mock.calls[0][1].current.intent.input).toBeUndefined();
  });

  it("emits a bounded terminal pipeline failure when classification throws", async () => {
    const classifier = vi.fn().mockRejectedValue("classifier string failure");
    const { handlers, emitAgentEvent } = createTopicFlowHarness({
      historicalIntents: [],
      classifier,
    });

    const result = await handlers.onBeforePromptBuild(event, ctx);

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
    expect(emittedPhaseStates(emitAgentEvent)[0]).toBe("pipeline:started");
    expect(emittedPhaseStates(emitAgentEvent).at(-1)).toBe("pipeline:failed");
    expect(emittedPipelineEvents(emitAgentEvent).at(-1)?.data).toEqual(
      expect.objectContaining({
        error: "skill-harness pipeline execution failed",
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(emittedPipelineEvents(emitAgentEvent))).not.toContain(
      "classifier string failure",
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
              listSessionEntries: vi.fn().mockReturnValue([
                {
                  sessionKey: resolvedSessionKey,
                  entry: { sessionId: ctx.sessionId },
                },
              ]),
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

    expect(result).toEqual({
      appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
    });
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

    expect(result?.prependContext).toContain("<skill_harness_plugin");
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "agent:main:direct:123",
        sessionKey: "agent:main:direct:123",
        stream: "plugin:skill-harness",
      }),
    );
  });
});
