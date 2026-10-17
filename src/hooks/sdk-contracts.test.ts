import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config.js";
import { createHookHandlers } from "./index.js";
import { SKILL_HARNESS_SYSTEM_CONTEXT } from "./system-context.js";
import {
  TurnAssociationRegistry,
  type TurnAssociation,
} from "./turn-associations.js";
import type { HookDeps, PluginHookBeforePromptBuildEvent } from "./types.js";

vi.mock("../skills/index.js", () => ({
  listAvailableSkills: async () => [],
  resolveAvailableSkills: async () => [],
  resolveSkillInventory: async () => [],
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  emitAgentEvent: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function createHandlers(overrides: Partial<HookDeps> = {}) {
  return createHookHandlers({
    api: { config: {} } as HookDeps["api"],
    config: () => resolveConfig({}),
    refreshLiveConfigFromRuntime: () => {},
    reviewScheduler: {
      schedule: () => false,
      setRunner: () => {},
      setOnDiscard: () => {},
    },
    ...overrides,
  });
}

const ctx = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:direct:123",
  runId: "run",
  trigger: "user",
};

function promptHarness() {
  const tracker = {
    preparePromptTurn: vi.fn(async () => ({
      status: "applied",
      identity: { turnKey: "run", reused: false },
    })),
    getCurrentState: () => ({ turnKey: "run" }),
    mergeTurnAndPersist: vi.fn(async () => "applied"),
  };
  const skillSearch = vi.fn(async () => []);
  const experienceSearch = vi.fn(async () => []);
  const selector = vi.fn();
  return {
    tracker,
    skillSearch,
    experienceSearch,
    selector,
    handlers: createHandlers({
      tracker: tracker as never,
      qmdSkillIndex: { search: skillSearch } as never,
      qmdExperienceIndex: { search: experienceSearch } as never,
      routingSelector: selector,
    }),
  };
}

describe("SDK current request contract", () => {
  it("uses the explicit request for tracking and both searches when the prompt reconstructs history", async () => {
    const h = promptHarness();
    await h.handlers.onBeforePromptBuild(
      {
        currentUserMessage: "What is two plus two?",
        currentUserMessageId: "admission-id",
        prompt:
          "Previous request: deploy Kubernetes.\nAssistant: done.\nCurrent request: What is two plus two?",
        messages: [{ role: "user", content: "deploy Kubernetes" }],
      },
      ctx,
    );
    expect(h.tracker.preparePromptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: "What is two plus two?", runId: "run" }),
    );
    for (const search of [h.skillSearch, h.experienceSearch]) {
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ query: "What is two plus two?" }),
      );
    }
  });

  it("preserves literal assembled-context markers in the explicit user request", async () => {
    const h = promptHarness();
    const currentUserMessage =
      "OpenClaw assembled context for this turn:\n" +
      "<conversation_context>\nExample history\n</conversation_context>\n" +
      "Current user request: Explain this literal envelope";
    await h.handlers.onBeforePromptBuild(
      { currentUserMessage, prompt: "reconstructed prompt", messages: [] },
      ctx,
    );
    expect(h.tracker.preparePromptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: currentUserMessage }),
    );
    expect(h.skillSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: currentUserMessage }),
    );
  });

  it.each(["", " \n "])(
    "keeps static guidance without routing or tracking explicit empty input (%j)",
    async (currentUserMessage) => {
      const h = promptHarness();
      const result = await h.handlers.onBeforePromptBuild(
        {
          currentUserMessage,
          currentUserMessageId: "image-only-admission",
          prompt: "Earlier request: deploy Kubernetes",
          messages: [
            { role: "user", content: "Earlier request: deploy Kubernetes" },
            { role: "user", content: [{ type: "image", data: "image" }] },
          ],
        },
        ctx,
      );
      expect(result?.appendSystemContext).toContain(
        SKILL_HARNESS_SYSTEM_CONTEXT,
      );
      expect(result?.prependContext).toBeUndefined();
      expect(h.tracker.preparePromptTurn).not.toHaveBeenCalled();
      expect(h.skillSearch).not.toHaveBeenCalled();
      expect(h.experienceSearch).not.toHaveBeenCalled();
      expect(h.selector).not.toHaveBeenCalled();
    },
  );

  it("does not infer current provenance from an older reconstructed prompt when the request is explicit", async () => {
    const h = promptHarness();
    await h.handlers.onBeforePromptBuild(
      {
        currentUserMessage: "Inspect this deployment",
        prompt: "[Inter-session message] isUser=false\nOlder internal request",
        messages: [],
      },
      ctx,
    );
    expect(h.skillSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Inspect this deployment" }),
    );
  });

  it.each(["inter_session", "internal_system"] as const)(
    "still skips typed %s provenance even when current text is present",
    async (kind) => {
      const h = promptHarness();
      const result = await h.handlers.onBeforePromptBuild(
        {
          currentUserMessage: "internal request",
          prompt: "request",
          messages: [],
        },
        { ...ctx, inputProvenance: { kind } },
      );
      expect(result).toBeUndefined();
      expect(h.tracker.preparePromptTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { prompt: "legacy prompt only", messages: [] },
    {
      prompt: "legacy prompt only",
      messages: [{ role: "user", content: "legacy prompt only" }],
    },
  ] satisfies PluginHookBeforePromptBuildEvent[])(
    "preserves legacy extraction when currentUserMessage is absent ($messages)",
    async (event) => {
      const h = promptHarness();
      await h.handlers.onBeforePromptBuild(event, ctx);
      expect(h.tracker.preparePromptTurn).toHaveBeenCalledWith(
        expect.objectContaining({ input: "legacy prompt only" }),
      );
      expect(h.skillSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: "legacy prompt only" }),
      );
    },
  );
});

function bind(
  registry: TurnAssociationRegistry,
  association: TurnAssociation,
  runId?: string,
) {
  const reservation = runId
    ? registry.reserve(runId)
    : registry.reserveAnonymous();
  if (reservation.status !== "reserved") throw new Error("reservation failed");
  if (runId) registry.bind(reservation.token, runId, association);
  else registry.bindAnonymous(reservation.token, association);
}

function correlationHarness(registry: TurnAssociationRegistry) {
  const merge = vi.fn(async () => "applied");
  const finalize = vi.fn(async () => "stale");
  return {
    merge,
    finalize,
    handlers: createHandlers({
      turnAssociations: registry,
      tracker: {
        mergeTurnAndPersist: merge,
        finalizeTurnFromAgentEnd: finalize,
      } as never,
    }),
  };
}

const association = {
  sessionId: ctx.sessionId,
  sessionKey: ctx.sessionKey,
  turnKey: "current-turn",
};
const tool = { toolName: "read", params: {}, result: "tool output" };

describe("SDK run correlation contract", () => {
  it.each([
    { eventRunId: "other-run", contextRunId: undefined },
    { eventRunId: undefined, contextRunId: "other-run" },
    { eventRunId: "other-run", contextRunId: "other-run" },
    { eventRunId: "current-run", contextRunId: "other-run" },
  ])(
    "never attributes a different known run through the current session ($eventRunId/$contextRunId)",
    async ({ eventRunId, contextRunId }) => {
      const registry = new TurnAssociationRegistry();
      bind(registry, association, "current-run");
      const h = correlationHarness(registry);
      await h.handlers.onAfterToolCall(
        { ...tool, runId: eventRunId },
        { ...ctx, runId: contextRunId },
      );
      await h.handlers.onAgentEnd(
        { runId: eventRunId, success: true, messages: [] },
        { ...ctx, runId: contextRunId },
      );
      expect(h.merge).not.toHaveBeenCalled();
      expect(h.finalize).not.toHaveBeenCalled();
    },
  );

  it("ignores a late terminal run after the next named turn starts", async () => {
    const registry = new TurnAssociationRegistry();
    const old = { ...association, turnKey: "old-turn" };
    bind(registry, old, "old-run");
    registry.markAssociationTerminal(old);
    bind(registry, association, "current-run");
    const h = correlationHarness(registry);
    await h.handlers.onAgentEnd(
      { runId: "old-run", success: true, messages: [] },
      { ...ctx, runId: "old-run" },
    );
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it.each(["terminal", "ambiguous", "reserved", "other-session"] as const)(
    "never reassigns a known %s run to the next anonymous turn",
    async (state) => {
      const registry = new TurnAssociationRegistry();
      const runId = "known-run";
      const old = {
        ...association,
        turnKey: "old-turn",
        ...(state === "other-session"
          ? {
              sessionId: "other-session",
              sessionKey: "agent:main:direct:other",
            }
          : {}),
      };
      if (state === "reserved") {
        registry.reserve(runId);
      } else {
        bind(registry, old, runId);
        if (state === "terminal") registry.markAssociationTerminal(old);
        if (state === "ambiguous") {
          registry.bindExisting(runId, { ...old, turnKey: "conflicting-turn" });
        }
      }
      bind(registry, association);
      const h = correlationHarness(registry);
      await h.handlers.onAfterToolCall({ ...tool, runId }, { ...ctx, runId });
      await h.handlers.onAgentEnd(
        { runId, success: true, messages: [] },
        { ...ctx, runId },
      );
      expect(h.merge).not.toHaveBeenCalled();
      expect(h.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { registeredRunId: "current-run", eventRunId: "current-run" },
    { registeredRunId: "current-run", eventRunId: undefined },
    { registeredRunId: undefined, eventRunId: "newly-supplied-run" },
    { registeredRunId: undefined, eventRunId: undefined },
  ])(
    "retains exact run matches and unique session/anonymous compatibility ($registeredRunId/$eventRunId)",
    async ({ registeredRunId, eventRunId }) => {
      const registry = new TurnAssociationRegistry();
      bind(registry, association, registeredRunId);
      const h = correlationHarness(registry);
      await h.handlers.onAfterToolCall(
        { ...tool, runId: eventRunId },
        { ...ctx, runId: eventRunId },
      );
      expect(h.merge).toHaveBeenCalledWith(
        expect.objectContaining({ expectedTurnKey: "current-turn" }),
      );
    },
  );

  it("does not guess an anonymous owner when multiple anonymous turns are active", async () => {
    const registry = new TurnAssociationRegistry();
    bind(registry, association);
    bind(registry, { ...association, turnKey: "other-turn" });
    const h = correlationHarness(registry);
    await h.handlers.onAfterToolCall(
      { ...tool, runId: "newly-supplied-run" },
      { ...ctx, runId: "newly-supplied-run" },
    );
    expect(h.merge).not.toHaveBeenCalled();
  });
});
