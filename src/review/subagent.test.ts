import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetApiLogger,
  setApiLogger,
  type OpenClawPluginApi,
} from "../../api.js";
import { resolveConfig } from "../config.js";
import { runReviewSubagent } from "./subagent.js";
import type { RelationReviewContext } from "./relations.js";
import type { ReviewSnapshot } from "./types.js";

afterEach(() => {
  resetApiLogger();
  vi.restoreAllMocks();
});

const snapshot: ReviewSnapshot = {
  sessionId: "session-1",
  sessionKey: "main-session-key",
  agentId: "main",
  eventId: "session-1:2026-06-11T00:00:00.000Z",
  turnNumber: 10,
  current: {
    input: "Run the tests and fix any failures",
    matchedSkills: ["test-driven-development"],
    capabilityFit: {
      source: "tool-call-threshold",
      observedSkillNames: ["test-driven-development"],
      turnHasToolErrors: false,
      recoveryVerified: false,
    },
    skillsUsed: [
      {
        name: "test-driven-development",
        description: "Drive changes with failing tests first.",
        path: "/skills/test-driven-development/SKILL.md",
      },
    ],
    toolCalls: [
      {
        name: "exec",
        params: { command: "pnpm run test", workdir: "/repo" },
        durationMs: 42,
      },
    ],
    result: "Done",
    timestamps: { start: "2026-06-11T00:00:00.000Z" },
  },
  recent: [],
};

describe("host Review diagnostic strings", () => {
  async function run(result: unknown) {
    return runReviewSubagent({
      api: {
        config: {},
        runtime: {
          agent: {
            runEmbeddedAgent: vi.fn(async (params) => {
              expect(params).toMatchObject({
                sessionPersistence: "detached",
                toolsAllow: [
                  "ls",
                  "read",
                  "skill_list",
                  "skill_search",
                  "skill_view",
                ],
                config: { tools: { fs: { workspaceOnly: true } } },
              });
              if (result instanceof Error) throw result;
              return result;
            }),
          },
        },
      } as unknown as OpenClawPluginApi,
      config: resolveConfig({}),
      agentId: "main",
      relationContext: {
        dataRoot: "",
        skills: [],
        seedIds: [],
        relations: [],
        relationRevisions: new Map(),
        getVisibleSkills: async () => [],
        preparation: {
          status: "ready",
          requestedSeeds: 0,
          capturedSeeds: 0,
          capturedExtras: 0,
          existingNeighborAttempts: 0,
          discoveryAttempts: 0,
          skippedCaptureCount: 0,
        },
        admitSkill: async () => ({
          status: "ineligible",
          reason: "unregistered",
        }),
      } satisfies RelationReviewContext,
      modelRef: { provider: "PRIVATE-PROVIDER", model: "PRIVATE-MODEL" },
      snapshot,
      triggers: ["capability-fit"],
    });
  }

  it("distinguishes structured embedded failures without exposing their messages", async () => {
    const warn = vi.fn<(message: string) => void>();
    setApiLogger({ warn });
    for (const kind of ["context_overflow", "role_ordering"]) {
      const result = await run({
        payloads: [],
        meta: {
          error: { kind, message: "PRIVATE-RESPONSE token=PRIVATE-TOKEN" },
        },
      });
      expect(result.outcome).toBe("subagent-error");
    }
    const messages = warn.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"reason":"context-overflow"');
    expect(messages[1]).toContain('"reason":"role-ordering"');
    expect(messages[0]).not.toBe(messages[1]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
    expect(warn.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it.each([
    [{ payloads: [{ isError: true, text: "PRIVATE-ERROR" }] }, "error-payload"],
    [
      { meta: { error: { kind: "PRIVATE-KIND", message: "PRIVATE-ERROR" } } },
      "embedded-error",
    ],
    [{ meta: { error: "PRIVATE-ERROR" } }, "embedded-error"],
    [
      {
        payloads: [{ isError: true, text: "PRIVATE-ERROR" }],
        meta: {
          error: { kind: "context_overflow", message: "PRIVATE-MESSAGE" },
        },
      },
      "error-payload",
    ],
  ])(
    "keeps unknown embedded evidence private: %j",
    async (response, reason) => {
      const warn = vi.fn<(message: string) => void>();
      setApiLogger({ warn });
      expect((await run(response)).outcome).toBe("subagent-error");
      expect(warn.mock.calls.map(([message]) => message).join("\n")).toContain(
        `"reason":"${reason}"`,
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it.each([
    ["", "empty-reply"],
    ["PRIVATE-RESPONSE token=PRIVATE-TOKEN", "invalid-json"],
    ['{"PRIVATE-PAYLOAD":"PRIVATE-VALUE"}', "invalid-shape"],
    ["[]", "invalid-shape"],
    ["null", "invalid-shape"],
    ["false", "invalid-shape"],
  ])("retains safe parse diagnostics for %j", async (reply, reason) => {
    const warn = vi.fn<(message: string) => void>();
    setApiLogger({ warn });
    expect((await run({ payloads: [{ text: reply }] })).outcome).toBe(
      "parse-failed",
    );
    const messages = warn.mock.calls.map(([message]) => message).join("\n");
    expect(messages).toContain("review result parse failed");
    expect(messages).toContain(`"reason":"${reason}"`);
    expect(messages).toContain(`"rawReplyLength":${reply.length}`);
    expect(messages).not.toContain("PRIVATE");
    expect(warn.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it.each([
    ["ETIMEDOUT", "request-timeout"],
    ["EACCES", "permission-denied"],
    ["PRIVATE-CODE", "operation-failed"],
  ])("classifies thrown errors using safe codes: %s", async (code, reason) => {
    const warn = vi.fn<(message: string) => void>();
    setApiLogger({ warn });
    const error = Object.assign(
      new Error("PRIVATE-MESSAGE token=PRIVATE-TOKEN"),
      { code },
    );
    expect((await run(error)).outcome).toBe("subagent-error");
    const messages = warn.mock.calls.map(([message]) => message).join("\n");
    expect(messages).toContain(`review subagent error {"reason":"${reason}"`);
    expect(messages).not.toContain("PRIVATE");
    expect(warn.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
});
