import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  isAllowedChatId,
  isAllowedChatType,
  isEnabledForAgent,
  isEligibleInteractiveSession,
  resolveCanonicalSessionKeyFromSessionId,
  resolveStatusUpdateAgentId,
  shouldSkipSkillSystemContext,
  shouldSkipIntentAnalysis,
} from "./guards.js";

describe("isEnabledForAgent", () => {
  it("returns false when no agentId", () => {
    expect(
      isEnabledForAgent(
        resolveConfig({ routing: { scope: { agents: ["main"] } } }),
        undefined,
      ),
    ).toBe(false);
  });

  it("returns true when agent is in list", () => {
    expect(
      isEnabledForAgent(
        resolveConfig({ routing: { scope: { agents: ["main"] } } }),
        "main",
      ),
    ).toBe(true);
  });

  it("returns false when agent not in list", () => {
    expect(
      isEnabledForAgent(
        resolveConfig({ routing: { scope: { agents: ["main"] } } }),
        "other",
      ),
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

describe("shouldSkipSkillSystemContext", () => {
  it.each([
    {
      label: "active-memory session key",
      context: {
        sessionKey: "agent:main:discord:direct:123:active-memory:abc",
      },
    },
    {
      label: "active-memory session id",
      context: { sessionId: "active-memory-xyz" },
    },
    {
      label: "skill-harness session key",
      context: {
        sessionKey: "agent:main:discord:direct:123:skill-harness:abc",
      },
    },
    {
      label: "skill-harness session id",
      context: { sessionId: "skill-harness-xyz" },
    },
    {
      label: "generic subagent session",
      context: {
        sessionKey: "agent:main:discord:direct:123:subagent:abc",
      },
    },
    {
      label: "dreaming session",
      context: {
        sessionKey: "agent:main:dreaming-narrative-light-83a0e00c357f",
      },
    },
  ])("skips $label", ({ context }) => {
    expect(shouldSkipSkillSystemContext(context)).toBe(true);
  });

  it("does not skip a normal main-agent session because its trigger is non-user", () => {
    expect(
      shouldSkipSkillSystemContext({
        trigger: "heartbeat",
        sessionKey: "agent:main:direct:123",
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
  interface SessionLookupResult {
    sessionKey: string;
    entry: { sessionId: string };
  }

  function createApi(
    lookup: (params: {
      agentId: string;
      sessionId: string;
    }) => Promise<SessionLookupResult | undefined>,
  ) {
    const getSessionEntryByIdAsync = vi.fn(lookup);
    const forbiddenLookup = vi.fn(() => {
      throw new Error("unexpected session enumeration or alternate namespace");
    });
    const api = {
      runtime: {
        agent: {
          session: {
            getSessionEntryByIdAsync,
            getSessionEntryById: forbiddenLookup,
            listSessionEntries: forbiddenLookup,
            listSessionEntriesAsync: forbiddenLookup,
          },
        },
        session: { getSessionEntryByIdAsync: forbiddenLookup },
      },
    } as unknown as OpenClawPluginApi;
    return { api, getSessionEntryByIdAsync, forbiddenLookup };
  }

  it("awaits the targeted asynchronous row read before resolving its key", async () => {
    let finishLookup!: (result: SessionLookupResult) => void;
    const lookup = new Promise<SessionLookupResult>((resolve) => {
      finishLookup = resolve;
    });
    const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
      () => lookup,
    );

    const result = resolveCanonicalSessionKeyFromSessionId({
      api,
      agentId: "main",
      sessionId: "target-session",
    });
    expect(result).toBeInstanceOf(Promise);
    expect(getSessionEntryByIdAsync).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "target-session",
    });
    let settled = false;
    void Promise.resolve(result).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishLookup({
      sessionKey: "agent:main:direct:resolved",
      entry: { sessionId: "target-session" },
    });
    await expect(result).resolves.toBe("agent:main:direct:resolved");
    expect(forbiddenLookup).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])(
    "does not read the SDK when the session ID is %s",
    async (sessionId) => {
      const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
        async () => undefined,
      );
      await expect(
        resolveCanonicalSessionKeyFromSessionId({
          api,
          agentId: "main",
          sessionId,
        }),
      ).resolves.toBeUndefined();
      expect(getSessionEntryByIdAsync).not.toHaveBeenCalled();
      expect(forbiddenLookup).not.toHaveBeenCalled();
    },
  );

  it("passes the raw requested ID and owning agent without store or ordering overrides", async () => {
    const sessionId = " target-session ";
    const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
      async () => ({
        sessionKey: "agent:other:direct:resolved",
        entry: { sessionId },
      }),
    );
    await expect(
      resolveCanonicalSessionKeyFromSessionId({
        api,
        agentId: "other",
        sessionId,
      }),
    ).resolves.toBe("agent:other:direct:resolved");
    expect(getSessionEntryByIdAsync).toHaveBeenCalledExactlyOnceWith({
      agentId: "other",
      sessionId: " target-session ",
    });
    expect(forbiddenLookup).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a different session ID", returnedId: "other-session" },
    { label: "only a trimmed legacy alias", returnedId: " target-session " },
  ])("rejects $label", async ({ returnedId }) => {
    const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
      async () => ({
        sessionKey: "agent:main:direct:unrelated",
        entry: { sessionId: returnedId },
      }),
    );
    await expect(
      resolveCanonicalSessionKeyFromSessionId({
        api,
        agentId: "main",
        sessionId: "target-session",
      }),
    ).resolves.toBeUndefined();
    expect(getSessionEntryByIdAsync).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "target-session",
    });
    expect(forbiddenLookup).not.toHaveBeenCalled();
  });

  it("returns undefined for a missing row without trying another namespace or store", async () => {
    const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
      async () => undefined,
    );
    await expect(
      resolveCanonicalSessionKeyFromSessionId({
        api,
        agentId: "main",
        sessionId: "missing-session",
      }),
    ).resolves.toBeUndefined();
    expect(getSessionEntryByIdAsync).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "missing-session",
    });
    expect(forbiddenLookup).not.toHaveBeenCalled();
  });

  it("fails open when the targeted asynchronous lookup rejects", async () => {
    const { api, getSessionEntryByIdAsync, forbiddenLookup } = createApi(
      async () => {
        throw new Error("lookup failed");
      },
    );
    await expect(
      resolveCanonicalSessionKeyFromSessionId({
        api,
        agentId: "main",
        sessionId: "target-session",
      }),
    ).resolves.toBeUndefined();
    expect(getSessionEntryByIdAsync).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "target-session",
    });
    expect(forbiddenLookup).not.toHaveBeenCalled();
  });
});

describe("isAllowedChatType", () => {
  it("allows direct when direct allowed", () => {
    expect(
      isAllowedChatType(
        resolveConfig({ routing: { scope: { chatTypes: ["direct"] } } }),
        {
          sessionKey: "agent:main:direct:123",
        },
      ),
    ).toBe(true);
  });

  it("denies group when only direct allowed", () => {
    expect(
      isAllowedChatType(
        resolveConfig({ routing: { scope: { chatTypes: ["direct"] } } }),
        {
          sessionKey: "agent:main:group:123",
        },
      ),
    ).toBe(false);
  });
});

describe("isAllowedChatId", () => {
  it("allows any when no restrictions", () => {
    expect(
      isAllowedChatId(
        resolveConfig({
          routing: { scope: { allowedChatIds: [], deniedChatIds: [] } },
        }),
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
          routing: {
            scope: {
              allowedChatIds: [],
              deniedChatIds: ["discord:direct:123"],
            },
          },
        }),
        { sessionKey: "agent:main:direct:123", messageProvider: "discord" },
      ),
    ).toBe(false);
  });
});
