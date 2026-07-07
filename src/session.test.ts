import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import {
  isAllowedChatId,
  isAllowedChatType,
  isEnabledForAgent,
  isEligibleInteractiveSession,
  resolveCanonicalSessionKeyFromSessionId,
  resolveStatusUpdateAgentId,
  shouldSkipIntentAnalysis,
} from "./session.js";

describe("isEnabledForAgent", () => {
  it("returns false when no agentId", () => {
    expect(
      isEnabledForAgent(resolveConfig({ agents: ["main"] }), undefined),
    ).toBe(false);
  });

  it("returns true when agent is in list", () => {
    expect(isEnabledForAgent(resolveConfig({ agents: ["main"] }), "main")).toBe(
      true,
    );
  });

  it("returns false when agent not in list", () => {
    expect(
      isEnabledForAgent(resolveConfig({ agents: ["main"] }), "other"),
    ).toBe(false);
  });
});

describe("isEligibleInteractiveSession", () => {
  it("returns true for user trigger with sessionKey", () => {
    expect(
      isEligibleInteractiveSession({
        trigger: "user",
        sessionKey: "agent:main:direct:123",
      }),
    ).toBe(true);
  });

  it("returns false for non-user trigger", () => {
    expect(
      isEligibleInteractiveSession({
        trigger: "heartbeat",
        sessionKey: "agent:main:direct:123",
      }),
    ).toBe(false);
  });

  it("returns true for webchat", () => {
    expect(
      isEligibleInteractiveSession({
        trigger: "user",
        sessionKey: undefined,
        messageProvider: "webchat",
      }),
    ).toBe(true);
  });

  it("returns true for channelId", () => {
    expect(
      isEligibleInteractiveSession({
        trigger: "user",
        sessionKey: undefined,
        sessionId: undefined,
        channelId: "123",
      }),
    ).toBe(true);
  });
});

describe("shouldSkipIntentAnalysis", () => {
  it("skips non-user triggers", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "manual",
        sessionKey: "agent:main:discord:direct:123:active-memory:abc",
      }),
    ).toBe(true);
  });

  it("skips active-memory subagent sessions", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionKey: "agent:main:discord:direct:123:active-memory:abc",
      }),
    ).toBe(true);
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionId: "active-memory-xyz",
      }),
    ).toBe(true);
  });

  it("skips skill-harness self-recursive sessions", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionKey: "agent:main:discord:direct:123:skill-harness:abc",
      }),
    ).toBe(true);
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionId: "skill-harness-xyz",
      }),
    ).toBe(true);
  });

  it("skips generic subagent sessions", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionKey: "agent:main:discord:direct:123:subagent:abc",
      }),
    ).toBe(true);
  });

  it("skips dreaming sessions", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionKey: "agent:main:dreaming-narrative-light-83a0e00c357f",
      }),
    ).toBe(true);
  });

  it("does not skip normal user sessions", () => {
    expect(
      shouldSkipIntentAnalysis({
        trigger: "user",
        sessionKey: "agent:main:discord:direct:123",
        sessionId: "session-123",
      }),
    ).toBe(false);
  });
});

describe("resolveStatusUpdateAgentId", () => {
  it("returns agentId from ctx if present", () => {
    expect(resolveStatusUpdateAgentId({ agentId: "custom" })).toBe("custom");
  });

  it("returns agent from sessionKey", () => {
    expect(
      resolveStatusUpdateAgentId({ sessionKey: "agent:main:direct:123" }),
    ).toBe("main");
  });

  it("returns default when nothing provided", () => {
    expect(resolveStatusUpdateAgentId({})).toBe("main");
  });
});

describe("resolveCanonicalSessionKeyFromSessionId", () => {
  it("returns the session key for the matching row-scoped session entry", () => {
    const api = {
      runtime: {
        agent: {
          session: {
            listSessionEntries: () => [
              {
                sessionKey: "agent:main:direct:first",
                entry: { sessionId: "other-session" },
              },
              {
                sessionKey: "agent:main:direct:resolved",
                entry: { sessionId: "target-session" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveCanonicalSessionKeyFromSessionId({
        api,
        agentId: "main",
        sessionId: "target-session",
      }),
    ).toBe("agent:main:direct:resolved");
  });
});

describe("isAllowedChatType", () => {
  it("allows direct when direct allowed", () => {
    expect(
      isAllowedChatType(resolveConfig({ allowedChatTypes: ["direct"] }), {
        sessionKey: "agent:main:direct:123",
      }),
    ).toBe(true);
  });

  it("denies group when only direct allowed", () => {
    expect(
      isAllowedChatType(resolveConfig({ allowedChatTypes: ["direct"] }), {
        sessionKey: "agent:main:group:123",
      }),
    ).toBe(false);
  });
});

describe("isAllowedChatId", () => {
  it("allows any when no restrictions", () => {
    expect(
      isAllowedChatId(
        resolveConfig({ allowedChatIds: [], deniedChatIds: [] }),
        {
          sessionKey: "agent:main:direct:123",
        },
      ),
    ).toBe(true);
  });

  it("denies if chatId in denied list", () => {
    expect(
      isAllowedChatId(
        resolveConfig({
          allowedChatIds: [],
          deniedChatIds: ["discord:direct:123"],
        }),
        { sessionKey: "agent:main:direct:123", messageProvider: "discord" },
      ),
    ).toBe(false);
  });
});
