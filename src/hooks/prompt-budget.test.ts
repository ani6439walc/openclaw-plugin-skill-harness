import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as realDelay } from "node:timers/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { resolveConfig } from "../config.js";
import * as skillInventory from "../skills/index.js";
import { StatsAggregator } from "../stats/index.js";
import { SessionTracker } from "../session/tracker.js";
import { createHookHandlers } from "./index.js";
import {
  MAX_PROMPT_HOOK_TIMEOUT_MS,
  promptRoutingBudgetMs,
  withPromptDeadline,
} from "./prompt-budget.js";
import type {
  HookDeps,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "./types.js";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { TurnAssociationRegistry } from "./turn-associations.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  emitAgentEvent: vi.fn(),
}));
const roots: string[] = [];
const cleanup: Array<() => void> = [];
const operations = new Set<Promise<unknown>>();
const disposals: Array<() => Promise<void>> = [];
function track<T>(operation: Promise<T>): Promise<T> {
  operations.add(operation);
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation),
  );
  return operation;
}
async function settleFixture() {
  cleanup.splice(0).forEach((release) => release());
  await until(() => operations.size === 0);
}
afterEach(async () => {
  // Release gates and drain handlers before resetting mocks or removing files.
  await settleFixture();
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const ctx = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:main",
  runId: "turn",
  trigger: "user",
  messageProvider: "webchat",
};
const event = {
  prompt: "fixture",
  messages: [{ role: "user", content: "fixture" }],
};
const selected = {
  skills: ["fixture"],
  confidence: 0.9,
  reason: "relevant",
};
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  cleanup.push(() => resolve(cleanupValue));
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await realDelay(5);
  }
  throw new Error("Fixture did not reach expected stage");
}
function settleRun(
  handlers: ReturnType<typeof createHookHandlers>,
  context: { runId: string; sessionId?: string; sessionKey?: string },
  reply?: string,
) {
  return handlers.onAgentLifecycleEvent({
    ...context,
    stream: "lifecycle",
    seq: 1,
    ts: Date.now(),
    data: {
      phase: "end",
      executionSettled: true,
      ...(reply === undefined
        ? {}
        : { terminalReply: { disposition: "visible", text: reply } }),
    },
  });
}

async function captureCallbackBucket(
  slot: string,
  record: () => Promise<void>,
): Promise<Map<unknown, unknown>> {
  const set = vi.spyOn(Map.prototype, "set");
  try {
    await record();
    const write = set.mock.calls.findIndex(([key]) => key === slot);
    const bucket = set.mock.contexts[write];
    if (!(bucket instanceof Map)) throw new Error("Callback bucket not found");
    return bucket;
  } finally {
    set.mockRestore();
  }
}

function fixture(existingRoot?: string) {
  const root =
    existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "prompt-budget-"));
  if (!existingRoot) roots.push(root);
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(workspace, "skills", "fixture");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture skill.\n---\nInstructions.",
  );
  const tracker = SessionTracker.create(root);
  let config = resolveConfig({});
  const search = vi.fn(async () => []);
  const selector = vi.fn<NonNullable<HookDeps["routingSelector"]>>(
    async () => selected,
  );
  const lifecycle = new AbortController();
  const getWorkingSetSkills = vi.fn(async () => ["fixture"]);
  const sessionLookup = vi.fn<
    (params: { agentId?: string; sessionId: string }) => Promise<
      | {
          sessionKey: string;
          entry: { sessionId: string };
        }
      | undefined
    >
  >(async ({ sessionId }) => ({
    sessionKey: ctx.sessionKey,
    entry: { sessionId },
  }));
  const listSessionEntries = vi.fn(() => {
    throw new Error("synchronous listing is forbidden");
  });
  const turnAssociations = new TurnAssociationRegistry();
  const handlers = createHookHandlers({
    api: {
      config: {},
      lifecycle: { signal: lifecycle.signal },
      runtime: {
        state: { resolveStateDir: () => root },
        agent: {
          resolveAgentWorkspaceDir: () => workspace,
          session: {
            getSessionEntryByIdAsync: sessionLookup,
            listSessionEntries,
          },
        },
      },
    } as unknown as OpenClawPluginApi,
    dataRoot: root,
    tracker,
    statsAggregator: StatsAggregator.create(root),
    turnAssociations,
    config: () => config,
    refreshLiveConfigFromRuntime: () => {},
    getWorkingSetSkills,
    qmdSkillIndex: {
      search,
      schedule: () => {},
      getStatus: () => "ready",
      close: async () => {},
    },
    routingSelector: selector,
  });
  disposals.push(() => handlers.disposePromptWork());
  disposals.push(() => handlers.reviewScheduler.dispose());
  let active = true;
  cleanup.push(() => {
    active = false;
  });
  const onBeforePromptBuild = handlers.onBeforePromptBuild;
  handlers.onBeforePromptBuild = (event, ctx) =>
    track(
      onBeforePromptBuild(event, {
        ...ctx,
        hookInvocation: {
          assertActive: () => {
            if (!active) throw new Error("Fixture disposed");
            ctx.hookInvocation?.assertActive();
          },
        },
      }),
    );
  return {
    root,
    tracker,
    search,
    selector,
    lifecycle,
    getWorkingSetSkills,
    handlers,
    sessionLookup,
    listSessionEntries,
    turnAssociations,
    setConfig: (next: typeof config) => {
      config = next;
    },
  };
}

type Handler = (
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext,
) => Promise<PluginHookBeforePromptBuildResult | undefined>;
let hostRunner: (registry: {
  typedHooks: {
    hookName: string;
    pluginId: string;
    timeoutMs: number;
    handler: Handler;
  }[];
}) => { runBeforePromptBuild: Handler };
beforeAll(async () => {
  // Exercise the installed host's actual timeout/merge semantics, not a copied runner.
  const dist = path.dirname(createRequire(import.meta.url).resolve("openclaw"));
  const entry = fs
    .readdirSync(dist)
    .find(
      (name) =>
        /^hooks-.*\.mjs$/.test(name) &&
        fs
          .readFileSync(path.join(dist, name), "utf8")
          .includes("createHookRunner as "),
    );
  if (!entry) throw new Error("Installed OpenClaw hook runner not found");
  const source = fs.readFileSync(path.join(dist, entry), "utf8");
  const exportedName = /createHookRunner as (\w+)/.exec(source)?.[1];
  if (!exportedName) throw new Error("Installed hook runner export not found");
  const module = await import(
    /* @vite-ignore */ pathToFileURL(path.join(dist, entry)).href
  );
  hostRunner = module[exportedName];
});

describe("native admission identity", () => {
  it("joins pending selection and tracker preparation across correlation run IDs", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const prepare = vi.spyOn(f.tracker, "preparePromptTurn");
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    const first = f.handlers.onBeforePromptBuild(admitted, ctx);
    await until(() => f.selector.mock.calls.length === 1);
    const second = f.handlers.onBeforePromptBuild(admitted, {
      ...ctx,
      runId: "rebuild",
    });
    await until(() => f.getWorkingSetSkills.mock.calls.length === 2);
    selection.resolve(selected);
    const [one, two] = await Promise.all([first, second]);
    expect(two?.prependContext).toEqual(one?.prependContext);
    expect(one?.prependContext).toContain('<skill name="fixture">');
    expect(f.selector).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.turnAssociations.resolve("rebuild")).toEqual(
      f.turnAssociations.resolve(ctx.runId),
    );
  });

  it.each(["", " ", "admission-a", " admission-a "])(
    "keeps the opaque native ID %j separate from its neighbors",
    async (id) => {
      const f = fixture();
      const callCtx = { ...ctx, runId: undefined };
      await f.handlers.onBeforePromptBuild(
        { ...event, currentUserMessageId: id },
        callCtx,
      );
      await f.handlers.onBeforePromptBuild(
        { ...event, currentUserMessageId: `${id}!` },
        callCtx,
      );
      expect(f.selector).toHaveBeenCalledTimes(2);
    },
  );

  it("never revives a finalized or superseded admission for a rebuild", async () => {
    const f = fixture();
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    await f.handlers.onBeforePromptBuild(admitted, ctx);
    await f.handlers.onAgentEnd(
      { messages: [{ role: "assistant", content: "done" }], success: true },
      ctx,
    );
    await settleRun(f.handlers, ctx);
    const prepare = vi.spyOn(f.tracker, "preparePromptTurn");
    const replay = await f.handlers.onBeforePromptBuild(admitted, {
      ...ctx,
      runId: "rebuilt-final",
    });
    expect(replay?.prependContext).toBeUndefined();
    expect(replay?.appendSystemContext).toContain("<working_set_skills>");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.selector).toHaveBeenCalledTimes(1);
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-b" },
      { ...ctx, runId: "next" },
    );
    const turnB = f.tracker.getCurrentState("session")?.turnKey;
    await f.handlers.onBeforePromptBuild(admitted, {
      ...ctx,
      runId: "late-rebuild",
    });
    expect(f.selector).toHaveBeenCalledTimes(2);
    expect(f.tracker.getCurrentState("session")?.turnKey).toBe(turnB);
  });

  it("rebinds a superseded pending admission for exact completion without rerouting", async () => {
    const f = fixture();
    const first = { ...event, currentUserMessageId: "first" };
    const warn = vi.spyOn(logger, "warn");
    await f.handlers.onBeforePromptBuild(first, ctx);
    const oldTurn = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "new" },
      { ...ctx, runId: "new-run" },
    );
    const newTurn = f.tracker.getCurrentState(ctx.sessionId)!.turnKey;
    const replayCtx = { ...ctx, runId: "late-alias" };
    await f.handlers.onBeforePromptBuild(first, replayCtx);
    expect(f.turnAssociations.resolve(replayCtx.runId)?.turnKey).toBe(oldTurn);
    expect(f.selector).toHaveBeenCalledTimes(2);
    await f.handlers.onAgentEnd({ messages: [], success: true }, replayCtx);
    await settleRun(f.handlers, replayCtx);
    expect(
      f.tracker.getTurnState(ctx.sessionId, oldTurn)?.timestamps?.end,
    ).toBeTruthy();
    expect(f.tracker.getCurrentState(ctx.sessionId)?.turnKey).toBe(newTurn);
    await f.handlers.onBeforePromptBuild(first, {
      ...ctx,
      runId: "closed-alias",
    });
    expect(f.turnAssociations.resolve("closed-alias")).toBeUndefined();
    expect(
      warn.mock.calls.some(([message]) =>
        message.startsWith("before_prompt_build hook error"),
      ),
    ).toBe(false);
  });

  it("settles a pinned anonymous predecessor in history and leaves its successor open", async () => {
    const f = fixture();
    const anonymousCtx = { ...ctx, runId: undefined };
    const firstCtx = { ...ctx, runId: "anonymous:observed-first" };
    const secondCtx = { ...ctx, runId: "unseen-second" };
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "first" },
      anonymousCtx,
    );
    const firstKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
    await f.handlers.onBeforeToolCall(
      { toolName: "read", params: {}, runId: firstCtx.runId },
      firstCtx,
    );
    expect(f.turnAssociations.resolve(firstCtx.runId)?.turnKey).toBe(firstKey);
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "second" },
      anonymousCtx,
    );
    const secondKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey;
    expect(secondKey).not.toBe(firstKey);

    await settleRun(f.handlers, secondCtx);
    expect(f.turnAssociations.hasRun(secondCtx.runId)).toBe(false);
    expect(
      f.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
    ).toBeUndefined();
    await f.handlers.onAgentEnd(
      {
        success: true,
        messages: [{ role: "assistant", content: "first answer" }],
      },
      firstCtx,
    );
    await settleRun(f.handlers, firstCtx);
    expect(f.tracker.getTurnState(ctx.sessionId, firstKey)).toMatchObject({
      result: "first answer",
      timestamps: { end: expect.any(String) },
    });
    expect(f.turnAssociations.hasRun(firstCtx.runId)).toBe(true);
    expect(f.turnAssociations.resolve(firstCtx.runId)).toBeUndefined();
    await settleRun(f.handlers, firstCtx);
    expect(
      f.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
    ).toBeUndefined();

    await f.handlers.onAgentEnd(
      {
        success: true,
        messages: [{ role: "assistant", content: "second answer" }],
      },
      secondCtx,
    );
    await settleRun(f.handlers, secondCtx);
    expect(f.tracker.getCurrentState(ctx.sessionId)).toMatchObject({
      turnKey: secondKey,
      result: "second answer",
      timestamps: { end: expect.any(String) },
    });
  });

  it.each(["unavailable", "error"] as const)(
    "preserves a pending native turn’s persisted selection when replay is %s",
    async (failure) => {
      const before = fixture();
      const admitted = {
        ...event,
        currentUserMessageId: "persisted-admission",
      };
      await before.handlers.onBeforePromptBuild(admitted, ctx);
      const persisted = before.tracker.getCurrentState(ctx.sessionId)!;
      expect(persisted.matchedSkills).toEqual(["fixture"]);
      await before.handlers.disposePromptWork();
      const after = fixture(before.root);
      after.sessionLookup.mockResolvedValue(undefined);
      if (failure === "error")
        after.selector.mockRejectedValue(new Error("unavailable"));
      else after.selector.mockResolvedValue(undefined);
      await after.handlers.onBeforePromptBuild(admitted, {
        ...ctx,
        sessionKey: "",
        runId: "replay",
      });
      expect(after.selector).toHaveBeenCalledOnce();
      expect(after.tracker.getCurrentState(ctx.sessionId)).toEqual(persisted);
      expect(after.turnAssociations.resolve("replay")?.turnKey).toBe(
        persisted.turnKey,
      );
    },
  );

  it.each([
    { kind: "legacy", hostKey: "agent:main:direct:current", sdkKey: undefined },
    { kind: "legacy", hostKey: "", sdkKey: undefined },
    { kind: "native", hostKey: "agent:main:direct:current", sdkKey: undefined },
    { kind: "native", hostKey: "", sdkKey: "agent:main:direct:sdk" },
  ])(
    "binds $kind replay using the current host or SDK key ($hostKey/$sdkKey)",
    async ({ kind, hostKey, sdkKey }) => {
      const before = fixture();
      const admitted =
        kind === "native"
          ? { ...event, currentUserMessageId: "key-replay" }
          : event;
      await before.handlers.onBeforePromptBuild(admitted, ctx);
      const turnKey = before.tracker.getCurrentState(ctx.sessionId)?.turnKey;
      expect(turnKey).toBeTruthy();
      await before.handlers.disposePromptWork();

      const after = fixture(before.root);
      after.sessionLookup.mockResolvedValue(
        sdkKey
          ? { sessionKey: sdkKey, entry: { sessionId: ctx.sessionId } }
          : undefined,
      );
      if (kind === "legacy" && hostKey) {
        after.setConfig(
          resolveConfig({
            routing: {
              scope: {
                allowedChatIds: ["webchat:direct:current"],
              },
            },
          }),
        );
      }
      const expectedKey = hostKey || sdkKey || ctx.sessionKey;
      await after.handlers.onBeforePromptBuild(admitted, {
        ...ctx,
        sessionKey: hostKey,
      });
      expect(after.turnAssociations.resolve(ctx.runId)).toMatchObject({
        turnKey,
        sessionKey: expectedKey,
      });
      await after.handlers.onAgentEnd(
        {
          success: true,
          messages: [{ role: "assistant", content: "replayed answer" }],
        },
        { ...ctx, sessionKey: expectedKey },
      );
      await after.handlers.onAgentLifecycleEvent({
        ...ctx,
        sessionKey: expectedKey,
        stream: "lifecycle",
        seq: 1,
        ts: Date.now(),
        data: { phase: "end", executionSettled: true },
      });
      expect(after.tracker.getCurrentState(ctx.sessionId)).toMatchObject({
        turnKey,
        result: "replayed answer",
        timestamps: { end: expect.any(String) },
      });
    },
  );

  it.each(["host", "SDK"] as const)(
    "uses the current %s key to bind a retained native replay behind a newer admission",
    async (source) => {
      const before = fixture();
      const admitted = { ...event, currentUserMessageId: "retained" };
      await before.handlers.onBeforePromptBuild(admitted, ctx);
      const retained = before.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
      await before.handlers.disposePromptWork();

      const after = fixture(before.root);
      await after.handlers.onBeforePromptBuild(
        { ...event, currentUserMessageId: "newer" },
        { ...ctx, runId: "newer-run" },
      );
      const newer = after.tracker.getCurrentState(ctx.sessionId)!.turnKey;
      const newKey = "agent:main:direct:current";
      after.sessionLookup.mockResolvedValue({
        sessionKey: newKey,
        entry: { sessionId: ctx.sessionId },
      });
      const replayCtx = {
        ...ctx,
        runId: "retained-run",
        sessionKey: source === "host" ? newKey : "",
      };
      await after.handlers.onBeforePromptBuild(admitted, replayCtx);
      expect(after.turnAssociations.resolve(replayCtx.runId)).toMatchObject({
        turnKey: retained,
        sessionKey: newKey,
      });
      expect(after.tracker.getCurrentState(ctx.sessionId)?.turnKey).toBe(newer);

      await settleRun(after.handlers, { ...replayCtx, sessionKey: newKey });
      expect(
        after.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
      ).toBeTruthy();
      expect(
        after.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
      ).toBeUndefined();
    },
  );

  it("keeps a replay terminal if its turn settles while the canonical key lookup waits", async () => {
    const f = fixture();
    const first = { ...event, currentUserMessageId: "first" };
    await f.handlers.onBeforePromptBuild(first, ctx);
    const firstTurnKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "newer" },
      { ...ctx, runId: "newer-run" },
    );
    const lookup = deferred<
      { sessionKey: string; entry: { sessionId: string } } | undefined
    >(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const pending = f.handlers.onBeforePromptBuild(first, {
      ...ctx,
      sessionKey: "",
      runId: "late-replay",
    });
    await until(() => f.sessionLookup.mock.calls.length === 1);
    await settleRun(f.handlers, ctx);
    expect(
      f.tracker.getTurnState(ctx.sessionId, firstTurnKey)?.timestamps?.end,
    ).toBeTruthy();
    lookup.resolve({
      sessionKey: ctx.sessionKey,
      entry: { sessionId: ctx.sessionId },
    });
    await pending;
    expect(f.turnAssociations.hasRun("late-replay")).toBe(true);
    expect(f.turnAssociations.resolve("late-replay")).toBeUndefined();
  });

  it.each(["host", "SDK"])(
    "releases Review activity for a skipped native run with a %s key",
    async (source) => {
      const f = fixture();
      const skipped = { ...event, currentUserMessageId: "skipped" };
      await f.handlers.onBeforePromptBuild(skipped, {
        ...ctx,
        sessionKey: source === "host" ? ctx.sessionKey : undefined,
        inputProvenance: { kind: "internal_system" },
      });
      expect(f.tracker.getCurrentState(ctx.sessionId)?.turnKey).toBeUndefined();
      expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(true);
      expect(f.turnAssociations.hasActiveSession(ctx.sessionKey)).toBe(true);
      await settleRun(f.handlers, { ...ctx, sessionId: "another-session" });
      await settleRun(f.handlers, { ...ctx, sessionKey: "agent:main:other" });
      expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(true);

      await settleRun(f.handlers, ctx);
      expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
      expect(f.turnAssociations.hasActiveSession(ctx.sessionKey)).toBe(false);
      expect(f.turnAssociations.hasRun(ctx.runId)).toBe(true);

      await f.handlers.onBeforePromptBuild(
        { ...event, currentUserMessageId: "anonymous" },
        { ...ctx, runId: undefined },
      );
      const active = f.tracker.getCurrentState(ctx.sessionId);
      expect(active?.turnKey).toBeTruthy();
      await settleRun(f.handlers, ctx);
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(active);
    },
  );

  it.each(["same", "different", "already settled"])(
    "handles a pinned anonymous run rebuilt by the %s admission",
    async (admission) => {
      const f = fixture();
      const admitted = { ...event, currentUserMessageId: "admitted" };
      await f.handlers.onBeforePromptBuild(admitted, {
        ...ctx,
        runId: undefined,
      });
      const turnKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
      await f.handlers.onBeforeToolCall(
        { toolName: "read", params: {}, runId: ctx.runId },
        ctx,
      );
      expect(f.turnAssociations.resolve(ctx.runId)?.turnKey).toBe(turnKey);
      if (admission === "already settled") await settleRun(f.handlers, ctx);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      await f.handlers.onBeforePromptBuild(
        admission === "different"
          ? { ...admitted, currentUserMessageId: "other" }
          : admitted,
        ctx,
      );
      const open = admission === "same";
      expect(f.turnAssociations.resolve(ctx.runId)?.turnKey).toBe(
        open ? turnKey : undefined,
      );
      await settleRun(f.handlers, ctx);
      expect(finalize).toHaveBeenCalledTimes(open ? 1 : 0);
      if (open)
        expect(
          f.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
        ).toBeTruthy();
      expect(f.turnAssociations.hasRun(ctx.runId)).toBe(true);
      expect(f.turnAssociations.resolve(ctx.runId)).toBeUndefined();
    },
  );

  async function retainedReplayFixture() {
    const before = fixture();
    const admitted = { ...event, currentUserMessageId: "retained" };
    await before.handlers.onBeforePromptBuild(admitted, ctx);
    const retained = before.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
    await before.handlers.disposePromptWork();
    const f = fixture(before.root);
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "newer" },
      { ...ctx, runId: "newer-run" },
    );
    const newer = f.tracker.getCurrentState(ctx.sessionId);
    const replayCtx = { ...ctx, runId: "retained-run", sessionKey: undefined };
    const currentKey = "agent:main:direct:current";
    const match = {
      sessionKey: currentKey,
      entry: { sessionId: ctx.sessionId },
    };
    return { f, admitted, retained, newer, replayCtx, match };
  }

  it.each([
    "settlement only",
    "key-only settlement",
    "settlement without identity",
    "with attempt",
    "wrong attempt key",
    "wrong settlement key",
    "wrong session ID",
    "aborted lookup",
    "ended session",
  ])(
    "correlates events during a retained replay lookup ($0)",
    async (scenario) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      let aborted = false;
      const pending = f.handlers.onBeforePromptBuild(admitted, {
        ...replayCtx,
        hookInvocation: {
          assertActive: () => {
            if (aborted) throw new Error("expired invocation");
          },
        },
      });
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const wrongKey = "agent:main:direct:other";
      const settledCtx = {
        ...replayCtx,
        sessionId:
          scenario === "wrong session ID"
            ? "another-session"
            : scenario === "key-only settlement" ||
                scenario === "settlement without identity"
              ? undefined
              : ctx.sessionId,
        sessionKey:
          scenario === "wrong settlement key"
            ? wrongKey
            : scenario === "settlement without identity"
              ? undefined
              : match.sessionKey,
      };
      await settleRun(f.handlers, settledCtx);
      const hasAttempt =
        scenario === "with attempt" || scenario === "wrong attempt key";
      if (hasAttempt) {
        await f.handlers.onAgentEnd(
          {
            runId: replayCtx.runId,
            success: true,
            messages: [{ role: "assistant", content: "early reply" }],
          },
          {
            ...replayCtx,
            sessionKey:
              scenario === "wrong attempt key" ? wrongKey : match.sessionKey,
          },
        );
      }
      expect(finalize).not.toHaveBeenCalled();
      aborted = scenario === "aborted lookup";
      if (scenario === "ended session") {
        await f.handlers.onSessionEnd(
          { sessionId: ctx.sessionId, messageCount: 0 },
          ctx,
        );
      }
      lookup.resolve(match);
      await pending;

      if (scenario === "ended session") {
        expect(finalize).not.toHaveBeenCalled();
        expect(f.turnAssociations.hasRun(replayCtx.runId)).toBe(false);
        expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
        return;
      }
      const shouldSettle =
        scenario === "settlement only" ||
        scenario === "key-only settlement" ||
        hasAttempt;
      expect(finalize).toHaveBeenCalledTimes(shouldSettle ? 1 : 0);
      const turn = f.tracker.getTurnState(ctx.sessionId, retained);
      if (shouldSettle) expect(turn?.timestamps?.end).toBeTruthy();
      else expect(turn?.timestamps?.end).toBeUndefined();
      expect(turn?.result).toBe(
        scenario === "with attempt" ? "early reply" : undefined,
      );
      expect(f.turnAssociations.hasRun(replayCtx.runId)).toBe(true);
      if (shouldSettle || aborted) {
        expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
        await settleRun(f.handlers, settledCtx);
        expect(finalize).toHaveBeenCalledTimes(shouldSettle ? 1 : 0);
      } else {
        expect(f.turnAssociations.resolve(replayCtx.runId)?.turnKey).toBe(
          retained,
        );
        await settleRun(f.handlers, {
          ...replayCtx,
          sessionKey: match.sessionKey,
        });
        expect(finalize).toHaveBeenCalledOnce();
      }
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
      if (aborted) {
        await settleRun(f.handlers, { ...ctx, runId: "newer-run" });
        expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
      }
    },
  );

  it.each([
    "older SDK, newer host",
    "older persisted fallback, newer host",
    "older SDK, newer SDK",
    "older SDK after newer host settled",
    "older SDK, deferred settlement applied by newer host",
  ])("preserves the winning retained replay key ($0)", async (scenario) => {
    const { f, admitted, retained, newer, replayCtx, match } =
      await retainedReplayFixture();
    const firstLookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup
      .mockReturnValueOnce(firstLookup.promise)
      .mockResolvedValueOnce(match);
    const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    const settleCtx = { ...replayCtx, sessionKey: match.sessionKey };
    const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
    const settledWhilePending = scenario.includes("deferred settlement");
    if (settledWhilePending) {
      await settleRun(f.handlers, settleCtx);
      expect(finalize).not.toHaveBeenCalled();
    }
    await f.handlers.onBeforePromptBuild(admitted, {
      ...replayCtx,
      sessionKey:
        scenario === "older SDK, newer SDK" ? undefined : match.sessionKey,
    });
    const settledEarly = scenario.endsWith("settled");
    if (settledEarly) await settleRun(f.handlers, settleCtx);
    if (settledWhilePending) expect(finalize).toHaveBeenCalledOnce();
    firstLookup.resolve(
      scenario.includes("persisted")
        ? undefined
        : {
            ...match,
            sessionKey: "agent:main:direct:old",
          },
    );
    await pending;
    if (!settledEarly && !settledWhilePending) {
      expect(f.turnAssociations.resolve(replayCtx.runId)).toMatchObject({
        turnKey: retained,
        sessionKey: match.sessionKey,
      });
    }
    await settleRun(f.handlers, settleCtx);
    expect(finalize).toHaveBeenCalledOnce();
    expect(
      f.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
    ).toBeTruthy();
    expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
    expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
  });

  it.each([
    { callback: "settlement", validFirst: true },
    { callback: "settlement", validFirst: false },
    { callback: "attempt", validFirst: true },
    { callback: "attempt", validFirst: false },
  ])(
    "keeps the matching replay $callback across different keys (valid first: $validFirst)",
    async ({ callback, validFirst }) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const valid = { ...replayCtx, sessionKey: match.sessionKey };
      const wrong = { ...replayCtx, sessionKey: "agent:main:direct:other" };
      for (const observed of validFirst ? [valid, wrong] : [wrong, valid]) {
        if (callback === "settlement") await settleRun(f.handlers, observed);
        else
          await f.handlers.onAgentEnd(
            {
              success: true,
              messages: [
                {
                  role: "assistant",
                  content: observed === valid ? "valid reply" : "wrong reply",
                },
              ],
            },
            observed,
          );
      }
      if (callback === "attempt") await settleRun(f.handlers, valid);
      expect(finalize).not.toHaveBeenCalled();
      lookup.resolve(match);
      await pending;

      expect(finalize).toHaveBeenCalledOnce();
      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        timestamps: { end: expect.any(String) },
      });
      expect(f.tracker.getTurnState(ctx.sessionId, retained)?.result).toBe(
        callback === "attempt" ? "valid reply" : undefined,
      );
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
    },
  );

  it.each([
    { withAttempt: false, alreadyBound: false },
    { withAttempt: true, alreadyBound: false },
    { withAttempt: true, alreadyBound: true },
  ])(
    "drains the newer SDK key without redelivery (attempt: $withAttempt, already bound: $alreadyBound)",
    async ({ withAttempt, alreadyBound }) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const oldKey = "agent:main:direct:old";
      const firstLookup = deferred<typeof match | undefined>(undefined);
      const secondLookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise);
      const first = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const resolveFirst = async () => {
        firstLookup.resolve({ ...match, sessionKey: oldKey });
        await first;
        expect(f.turnAssociations.resolve(replayCtx.runId)).toMatchObject({
          turnKey: retained,
          sessionKey: oldKey,
        });
      };
      if (alreadyBound) await resolveFirst();
      const second = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 2);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const callbackCtx = { ...replayCtx, sessionKey: match.sessionKey };
      if (withAttempt)
        await f.handlers.onAgentEnd(
          {
            success: true,
            messages: [{ role: "assistant", content: "new key reply" }],
          },
          callbackCtx,
        );
      await settleRun(f.handlers, callbackCtx);
      if (!alreadyBound) await resolveFirst();
      expect(finalize).not.toHaveBeenCalled();
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);

      secondLookup.resolve(match);
      await second;

      expect(finalize).toHaveBeenCalledOnce();
      expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        timestamps: { end: expect.any(String) },
      });
      expect(f.tracker.getTurnState(ctx.sessionId, retained)?.result).toBe(
        withAttempt ? "new key reply" : undefined,
      );
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
    },
  );

  it.each([
    { attemptTiming: "staged", settlementTiming: "during lookup" },
    { attemptTiming: "staged", settlementTiming: "after lookup" },
    { attemptTiming: "already observed", settlementTiming: "during lookup" },
    { attemptTiming: "already observed", settlementTiming: "after lookup" },
  ])(
    "uses the winning key's terminal reply ($attemptTiming attempt, settlement $settlementTiming)",
    async ({ attemptTiming, settlementTiming }) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const oldKey = "agent:main:direct:old";
      const firstLookup = deferred<typeof match | undefined>(undefined);
      const secondLookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise);
      const first = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const second = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 2);

      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const settle = () =>
        settleRun(
          f.handlers,
          { ...replayCtx, sessionKey: match.sessionKey },
          "terminal reply",
        );
      if (attemptTiming === "already observed") {
        firstLookup.resolve({ ...match, sessionKey: oldKey });
        await first;
      }
      await f.handlers.onAgentEnd(
        {
          success: true,
          messages: [{ role: "assistant", content: "old reply" }],
        },
        { ...replayCtx, sessionKey: oldKey },
      );
      if (settlementTiming === "during lookup") await settle();
      if (attemptTiming === "staged") {
        firstLookup.resolve({ ...match, sessionKey: oldKey });
        await first;
      }
      expect(f.turnAssociations.resolve(replayCtx.runId)?.sessionKey).toBe(
        oldKey,
      );
      expect(finalize).not.toHaveBeenCalled();

      secondLookup.resolve(match);
      await second;
      if (settlementTiming === "after lookup") await settle();

      expect(finalize).toHaveBeenCalledOnce();
      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result: "terminal reply",
        timestamps: { end: expect.any(String) },
      });
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
      await settle();
      expect(finalize).toHaveBeenCalledOnce();
    },
  );

  it.each(["during lookup", "after lookup"] as const)(
    "prefers the winning key's attempt over a later run-only attempt (%s)",
    async (settlementTiming) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const oldKey = "agent:main:direct:old";
      const firstLookup = deferred<typeof match | undefined>(undefined);
      const secondLookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise);
      const first = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const second = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 2);

      const winning = { ...replayCtx, sessionKey: match.sessionKey };
      await f.handlers.onAgentEnd(
        {
          success: true,
          messages: [{ role: "assistant", content: "winning reply" }],
        },
        winning,
      );
      firstLookup.resolve({ ...match, sessionKey: oldKey });
      await first;
      expect(f.turnAssociations.resolve(replayCtx.runId)).toMatchObject({
        turnKey: retained,
        sessionKey: oldKey,
      });
      await f.handlers.onAgentEnd(
        {
          success: true,
          messages: [{ role: "assistant", content: "unidentified reply" }],
        },
        { runId: replayCtx.runId },
      );
      const settle = () => settleRun(f.handlers, winning, "terminal reply");
      if (settlementTiming === "during lookup") await settle();
      expect(
        f.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
      ).toBeUndefined();

      secondLookup.resolve(match);
      await second;
      if (settlementTiming === "after lookup") await settle();

      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result: "winning reply",
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
    },
  );

  it.each([
    { newerIdentity: "ID-only", settlementTiming: "during lookup" },
    { newerIdentity: "ID-only", settlementTiming: "after lookup" },
    { newerIdentity: "canonical", settlementTiming: "during lookup" },
    { newerIdentity: "canonical", settlementTiming: "after lookup" },
  ])(
    "uses the newer matching $newerIdentity attempt ($settlementTiming)",
    async ({ newerIdentity, settlementTiming }) => {
      const { f, admitted, retained, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);

      const canonical = { ...replayCtx, sessionKey: match.sessionKey };
      const [earlier, later] =
        newerIdentity === "ID-only"
          ? [canonical, replayCtx]
          : [replayCtx, canonical];
      const earlierReply =
        newerIdentity === "ID-only"
          ? "earlier canonical reply"
          : "earlier id-only reply";
      const laterReply =
        newerIdentity === "ID-only"
          ? "later id-only reply"
          : "later canonical reply";
      for (const [context, reply] of [
        [earlier, earlierReply],
        [later, laterReply],
      ] as const) {
        await f.handlers.onAgentEnd(
          { success: true, messages: [{ role: "assistant", content: reply }] },
          context,
        );
      }

      const settle = () => settleRun(f.handlers, canonical, "terminal reply");
      if (settlementTiming === "during lookup") await settle();
      expect(
        f.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
      ).toBeUndefined();
      lookup.resolve(match);
      await pending;
      if (settlementTiming === "after lookup") await settle();

      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result: laterReply,
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
    },
  );

  it.each([
    { identity: "ID-only", settlementTiming: "during lookup", runOnly: true },
    { identity: "ID-only", settlementTiming: "after lookup", runOnly: true },
    {
      identity: "unverified",
      settlementTiming: "during lookup",
      runOnly: true,
    },
    { identity: "unverified", settlementTiming: "after lookup", runOnly: true },
    { identity: "ID-only", settlementTiming: "during lookup", runOnly: false },
    {
      identity: "canonical",
      settlementTiming: "during lookup",
      runOnly: false,
    },
  ])(
    "applies $identity attempt priority in a full staged bucket ($settlementTiming, run-only: $runOnly)",
    async ({ identity, settlementTiming, runOnly }) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);

      const { runId } = replayCtx;
      const observe = (reply: string, context: PluginHookAgentContext) =>
        f.handlers.onAgentEnd(
          { success: true, messages: [{ role: "assistant", content: reply }] },
          context,
        );
      const firstKey = "agent:main:direct:nonmatching-0";
      const bucket = await captureCallbackBucket(`key:${firstKey}`, () =>
        observe("nonmatching reply", { runId, sessionKey: firstKey }),
      );
      for (let index = 1; index < 7; index++) {
        await observe("nonmatching reply", {
          runId,
          sessionKey: `agent:main:direct:nonmatching-${index}`,
        });
      }
      const lastKey = "agent:main:direct:nonmatching-7";
      if (runOnly) await observe("run-only reply", { runId });
      else await observe("nonmatching reply", { runId, sessionKey: lastKey });
      expect(bucket.size).toBe(8);

      await observe(
        identity === "ID-only" ? "verified id reply" : "unverified key reply",
        identity === "ID-only"
          ? replayCtx
          : {
              runId,
              sessionKey:
                identity === "unverified" ? lastKey : match.sessionKey,
            },
      );
      expect(bucket.size).toBe(8);
      if (identity === "ID-only") {
        const verified = bucket.get("");
        expect(verified).toMatchObject({
          ctx: { sessionId: replayCtx.sessionId },
        });
        await observe("later run-only reply", { runId });
        expect(bucket.get("")).toBe(verified);
      } else {
        const rejectedKey =
          identity === "unverified" ? lastKey : match.sessionKey;
        expect(bucket.has(`key:${rejectedKey}`)).toBe(false);
      }

      const settle = () =>
        settleRun(
          f.handlers,
          { ...replayCtx, sessionKey: match.sessionKey },
          identity === "unverified" ? undefined : "terminal reply",
        );
      if (settlementTiming === "during lookup") await settle();
      expect(
        f.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
      ).toBeUndefined();
      lookup.resolve(match);
      await pending;
      if (settlementTiming === "after lookup") await settle();

      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result:
          identity === "ID-only"
            ? "verified id reply"
            : runOnly
              ? "run-only reply"
              : "terminal reply",
        timestamps: { end: expect.any(String) },
      });
      expect(bucket.has("")).toBe(runOnly || identity === "ID-only");
      expect(f.turnAssociations.resolve(runId)).toBeUndefined();
      expect(f.tracker.getCurrentState(ctx.sessionId)).toEqual(newer);
    },
  );

  it.each(["settlement", "attempt"] as const)(
    "preserves the canonical key-only %s in a full bucket during SDK lookup",
    async (callback) => {
      const { f, admitted, retained, newer, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);

      const { runId, sessionId } = replayCtx;
      const canonical = { runId, sessionKey: match.sessionKey };
      const record = (
        context: typeof canonical & { sessionId?: string },
        reply: string,
      ) =>
        callback === "settlement"
          ? settleRun(f.handlers, context, reply)
          : f.handlers.onAgentEnd(
              {
                success: true,
                messages: [{ role: "assistant", content: reply }],
              },
              context,
            );
      const slot = (key: string) =>
        callback === "attempt" ? `key:${key}` : key;
      const bucket = await captureCallbackBucket(slot(match.sessionKey), () =>
        record(canonical, "canonical reply"),
      );
      for (let index = 0; index < 7; index++) {
        await record(
          { runId, sessionKey: `agent:main:direct:nonmatching-${index}` },
          "nonmatching reply",
        );
      }
      expect(bucket.size).toBe(8);
      const conflictingKey = "agent:main:direct:conflicting";
      await record(
        { runId, sessionId, sessionKey: conflictingKey },
        "conflicting reply",
      );
      if (callback === "attempt")
        await settleRun(f.handlers, canonical, "terminal fallback");

      expect(
        f.tracker.getTurnState(sessionId, retained)?.timestamps?.end,
      ).toBeUndefined();
      lookup.resolve(match);
      await pending;

      expect(f.tracker.getTurnState(sessionId, retained)).toMatchObject({
        result: "canonical reply",
        timestamps: { end: expect.any(String) },
      });
      expect(bucket.size).toBe(8);
      expect(bucket.has(slot(match.sessionKey))).toBe(true);
      expect(bucket.has(slot(conflictingKey))).toBe(false);
      expect(f.tracker.getCurrentState(sessionId)).toEqual(newer);
    },
  );

  it.each(["settlement", "attempt"] as const)(
    "preserves the canonical key-only %s in a full bucket while waiting for the working set",
    async (callback) => {
      const f = fixture();
      const workingSet = deferred(["fixture"]);
      f.getWorkingSetSkills.mockReturnValueOnce(workingSet.promise);
      const admitted = { ...event, currentUserMessageId: "host-key" };
      const pending = f.handlers.onBeforePromptBuild(admitted, ctx);
      await until(() => f.getWorkingSetSkills.mock.calls.length === 1);

      const { runId, sessionId, sessionKey } = ctx;
      const canonical = { runId, sessionKey };
      const record = (
        context: typeof canonical & { sessionId?: string },
        reply: string,
      ) =>
        callback === "settlement"
          ? settleRun(f.handlers, context, reply)
          : f.handlers.onAgentEnd(
              {
                success: true,
                messages: [{ role: "assistant", content: reply }],
              },
              context,
            );
      const slot = callback === "attempt" ? `key:${sessionKey}` : sessionKey;
      const bucket = await captureCallbackBucket(slot, () =>
        record(canonical, "canonical reply"),
      );
      for (let index = 0; index < 7; index++) {
        await record(
          { runId, sessionKey: `agent:main:direct:nonmatching-${index}` },
          "nonmatching reply",
        );
      }
      expect(bucket.size).toBe(8);
      const conflictingKey = "agent:main:direct:conflicting";
      await record(
        { runId, sessionId, sessionKey: conflictingKey },
        "conflicting reply",
      );
      if (callback === "attempt")
        await settleRun(f.handlers, canonical, "terminal fallback");

      expect(f.tracker.getCurrentState(sessionId)).toBeUndefined();
      workingSet.resolve(["fixture"]);
      await pending;

      expect(f.tracker.getCurrentState(sessionId)).toMatchObject({
        result: "canonical reply",
        timestamps: { end: expect.any(String) },
      });
      expect(bucket.size).toBe(8);
      expect(bucket.has(slot)).toBe(true);
      expect(
        bucket.has(
          callback === "attempt" ? `key:${conflictingKey}` : conflictingKey,
        ),
      ).toBe(false);
    },
  );

  it.each(["run-only", "ID-only"] as const)(
    "admits a newly supplied host key to a full staged attempt bucket with a %s slot",
    async (keyless) => {
      const f = fixture();
      const admitted = { ...event, currentUserMessageId: "host-key-rebuild" };
      const lookup =
        deferred<Awaited<ReturnType<typeof f.sessionLookup>>>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const first = f.handlers.onBeforePromptBuild(admitted, {
        ...ctx,
        sessionKey: undefined,
      });
      await until(() => f.sessionLookup.mock.calls.length === 1);

      const { runId, sessionId, sessionKey } = ctx;
      const observe = (context: PluginHookAgentContext, reply: string) =>
        f.handlers.onAgentEnd(
          { success: true, messages: [{ role: "assistant", content: reply }] },
          context,
        );
      const firstKey = "agent:main:direct:nonmatching-0";
      const bucket = await captureCallbackBucket(`key:${firstKey}`, () =>
        observe({ runId, sessionKey: firstKey }, "nonmatching reply"),
      );
      for (let index = 1; index < 7; index++) {
        await observe(
          { runId, sessionKey: `agent:main:direct:nonmatching-${index}` },
          "nonmatching reply",
        );
      }
      await observe(
        keyless === "ID-only" ? { runId, sessionId } : { runId },
        "keyless reply",
      );
      expect(bucket.size).toBe(8);

      const workingSet = deferred(["fixture"]);
      f.getWorkingSetSkills.mockReturnValueOnce(workingSet.promise);
      const second = f.handlers.onBeforePromptBuild(admitted, ctx);
      await observe({ runId, sessionKey }, "canonical reply");
      expect(bucket.size).toBe(8);
      expect(bucket.has("")).toBe(true);
      expect(bucket.has(`key:${sessionKey}`)).toBe(true);
      await until(() => f.getWorkingSetSkills.mock.calls.length === 1);
      await settleRun(f.handlers, { runId, sessionKey }, "terminal fallback");

      workingSet.resolve(["fixture"]);
      await second;
      lookup.resolve({
        sessionKey: "agent:main:direct:older-sdk",
        entry: { sessionId },
      });
      await first;
      expect(f.tracker.getCurrentState(sessionId)).toMatchObject({
        result: "canonical reply",
        timestamps: { end: expect.any(String) },
      });
    },
  );

  it("admits a verified settlement to a full staged bucket", async () => {
    const { f, admitted, retained, replayCtx, match } =
      await retainedReplayFixture();
    const lookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
    await until(() => f.sessionLookup.mock.calls.length === 1);

    const { runId } = replayCtx;
    for (let index = 0; index < 7; index++) {
      await settleRun(f.handlers, {
        runId,
        sessionKey: `agent:main:direct:nonmatching-${index}`,
      });
    }
    const lastKey = "agent:main:direct:nonmatching-7";
    const bucket = await captureCallbackBucket(lastKey, () =>
      settleRun(f.handlers, { runId, sessionKey: lastKey }),
    );
    expect(bucket.size).toBe(8);
    await settleRun(f.handlers, replayCtx, "verified settlement reply");
    expect(bucket.size).toBe(8);
    expect(
      f.tracker.getTurnState(ctx.sessionId, retained)?.timestamps?.end,
    ).toBeUndefined();
    lookup.resolve(match);
    await pending;

    expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
      result: "verified settlement reply",
      timestamps: { end: expect.any(String) },
    });
  });

  it("admits a verified attempt to a full observed bucket with run-only fallback", async () => {
    const { f, admitted, retained, replayCtx, match } =
      await retainedReplayFixture();
    const canonical = { ...replayCtx, sessionKey: match.sessionKey };
    await f.handlers.onBeforePromptBuild(admitted, canonical);

    const observe = (reply: string, context: PluginHookAgentContext) =>
      f.handlers.onAgentEnd(
        { success: true, messages: [{ role: "assistant", content: reply }] },
        context,
      );
    await observe("canonical key reply", canonical);
    const bucket = await captureCallbackBucket("run-only", () =>
      observe("run-only reply", { runId: replayCtx.runId }),
    );
    const canonicalAttempt = bucket.get(`key:${match.sessionKey}`);
    expect(canonicalAttempt).toBeDefined();
    // A stable binding has fewer than seven distinct compatible identity slots.
    // Seed compatible entries to exercise fallback eviction after stale-key eviction has no candidates.
    for (let index = 0; index < 6; index++)
      bucket.set(`key:compatible-${index}`, canonicalAttempt);
    expect(bucket.size).toBe(8);

    await observe("verified id reply", replayCtx);
    expect(bucket.size).toBe(8);
    await settleRun(f.handlers, canonical);

    expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
      result: "verified id reply",
      timestamps: { end: expect.any(String) },
    });
    expect(bucket.has("run-only")).toBe(false);
  });

  it.each(["during lookup", "after lookup"] as const)(
    "keeps the staged reply when the bound key matches the settlement (%s)",
    async (settlementTiming) => {
      const { f, admitted, retained, replayCtx, match } =
        await retainedReplayFixture();
      const firstLookup = deferred<typeof match | undefined>(undefined);
      const secondLookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup
        .mockReturnValueOnce(firstLookup.promise)
        .mockReturnValueOnce(secondLookup.promise);
      const first = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const second = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 2);
      const current = { ...replayCtx, sessionKey: match.sessionKey };
      await f.handlers.onAgentEnd(
        {
          success: true,
          messages: [{ role: "assistant", content: "matching reply" }],
        },
        current,
      );
      const settle = () => settleRun(f.handlers, current, "terminal reply");
      firstLookup.resolve(match);
      await first;
      if (settlementTiming === "during lookup") await settle();
      secondLookup.resolve(
        settlementTiming === "during lookup"
          ? { ...match, sessionKey: "agent:main:direct:later" }
          : match,
      );
      await second;
      if (settlementTiming === "after lookup") await settle();

      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result: "matching reply",
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
    },
  );

  it("uses a later matching staged attempt over an earlier attempt from another run", async () => {
    const { f, admitted, retained, replayCtx, match } =
      await retainedReplayFixture();
    const earlier = {
      ...replayCtx,
      runId: "earlier-run",
      sessionKey: match.sessionKey,
    };
    await f.handlers.onBeforePromptBuild(admitted, earlier);
    await f.handlers.onAgentEnd(
      {
        success: true,
        messages: [{ role: "assistant", content: "earlier reply" }],
      },
      earlier,
    );

    const lookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    const current = { ...replayCtx, sessionKey: match.sessionKey };
    await f.handlers.onAgentEnd(
      {
        success: true,
        messages: [{ role: "assistant", content: "later reply" }],
      },
      current,
    );
    await settleRun(f.handlers, current);
    lookup.resolve(match);
    await pending;

    expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
      result: "later reply",
      timestamps: { end: expect.any(String) },
    });
  });

  it.each(["settlement", "attempt"] as const)(
    "preserves a staged ID-only %s when an identity-free callback follows",
    async (callback) => {
      const { f, admitted, retained, replayCtx, match } =
        await retainedReplayFixture();
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const pending = f.handlers.onBeforePromptBuild(admitted, replayCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const anonymous = { ...replayCtx, sessionId: undefined };
      if (callback === "settlement") {
        await settleRun(f.handlers, replayCtx, "valid reply");
        await settleRun(f.handlers, anonymous, "unidentified reply");
      } else {
        for (const [context, reply] of [
          [replayCtx, "valid reply"],
          [anonymous, "unidentified reply"],
        ] as const) {
          await f.handlers.onAgentEnd(
            {
              success: true,
              messages: [{ role: "assistant", content: reply }],
            },
            context,
          );
        }
        await settleRun(f.handlers, replayCtx);
      }
      expect(finalize).not.toHaveBeenCalled();
      lookup.resolve(match);
      await pending;

      expect(finalize).toHaveBeenCalledOnce();
      expect(f.tracker.getTurnState(ctx.sessionId, retained)).toMatchObject({
        result: "valid reply",
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.resolve(replayCtx.runId)).toBeUndefined();
    },
  );

  it.each(["current", "history"] as const)(
    "keeps a finalized legacy run from %s terminal after reload",
    async (location) => {
      const before = fixture();
      await before.handlers.onBeforePromptBuild(event, ctx);
      await before.handlers.onAgentEnd({ messages: [], success: true }, ctx);
      await settleRun(before.handlers, ctx);
      if (location === "history")
        await before.handlers.onBeforePromptBuild(event, {
          ...ctx,
          runId: "second",
        });
      const current = before.tracker.getCurrentState(ctx.sessionId);
      await before.handlers.disposePromptWork();
      const after = fixture(before.root);
      after.sessionLookup.mockResolvedValue(undefined);
      const warn = vi.spyOn(logger, "warn");
      await after.handlers.onBeforePromptBuild(event, {
        ...ctx,
        sessionKey: "",
      });
      expect(after.turnAssociations.hasRun(ctx.runId)).toBe(true);
      expect(after.turnAssociations.resolve(ctx.runId)).toBeUndefined();
      expect(after.search).not.toHaveBeenCalled();
      expect(after.selector).not.toHaveBeenCalled();
      expect(after.tracker.getCurrentState(ctx.sessionId)).toEqual(current);
      expect(
        warn.mock.calls.some(([message]) =>
          message.startsWith("before_prompt_build hook error"),
        ),
      ).toBe(false);
    },
  );

  it("keeps a deadline cancellation terminal across same-admission rebuilds", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    const first = f.handlers.onBeforePromptBuild(admitted, ctx);
    await until(() => f.selector.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(MAX_PROMPT_HOOK_TIMEOUT_MS + 1);
    expect((await first)?.prependContext).toBeUndefined();
    expect(
      (
        await f.handlers.onBeforePromptBuild(admitted, {
          ...ctx,
          runId: "rebuild",
        })
      )?.prependContext,
    ).toBeUndefined();
    expect(f.selector).toHaveBeenCalledTimes(1);
    selection.resolve(selected);
  });

  it("keeps equal text independent for distinct admissions without run IDs", async () => {
    const f = fixture();
    const callCtx = { ...ctx, runId: undefined };
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-a" },
      callCtx,
    );
    const firstTurn = f.tracker.getCurrentState("session")?.turnKey;
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-b" },
      callCtx,
    );
    expect(f.selector).toHaveBeenCalledTimes(2);
    expect(f.tracker.getCurrentState("session")?.turnKey).not.toBe(firstTurn);
  });

  it("shares completed selection across run IDs of one admission", async () => {
    const f = fixture();
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    const first = await f.handlers.onBeforePromptBuild(admitted, ctx);
    const firstTurn = f.tracker.getCurrentState("session")?.turnKey;
    const second = await f.handlers.onBeforePromptBuild(admitted, {
      ...ctx,
      runId: "rebuilt-run",
    });
    expect(second?.prependContext).toEqual(first?.prependContext);
    expect(f.selector).toHaveBeenCalledTimes(1);
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.tracker.getCurrentState("session")?.turnKey).toBe(firstTurn);
  });

  it("does not retry terminal selection failure when the same admission gets a new run ID", async () => {
    const f = fixture();
    f.selector.mockRejectedValue(new Error("selection failed"));
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    await f.handlers.onBeforePromptBuild(admitted, ctx);
    await f.handlers.onBeforePromptBuild(admitted, {
      ...ctx,
      runId: "rebuilt-run",
    });
    expect(f.selector).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct admissions independent even when they share a run ID", async () => {
    const f = fixture();
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-a" },
      ctx,
    );
    const firstTurn = f.tracker.getCurrentState("session")?.turnKey;
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-b" },
      ctx,
    );
    expect(f.selector).toHaveBeenCalledTimes(2);
    expect(f.tracker.getCurrentState("session")?.turnKey).not.toBe(firstTurn);
  });
});

describe("asynchronous prompt identity", () => {
  const admitted = { ...event, currentUserMessageId: "admission-a" };
  const noKey = { ...ctx, sessionKey: undefined };
  const match = {
    sessionKey: ctx.sessionKey,
    entry: { sessionId: ctx.sessionId },
  };

  it("skips SDK lookup when the canonical key is supplied", async () => {
    const f = fixture();
    await f.handlers.onBeforePromptBuild(admitted, ctx);
    expect(f.sessionLookup).not.toHaveBeenCalled();
    expect(f.listSessionEntries).not.toHaveBeenCalled();
  });

  it("shares one pending lookup across rebuilds of the same admission", async () => {
    const f = fixture();
    const lookup = deferred<typeof match | undefined>(match);
    f.sessionLookup.mockReturnValue(lookup.promise);
    const first = f.handlers.onBeforePromptBuild(admitted, noKey);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    const second = f.handlers.onBeforePromptBuild(admitted, {
      ...noKey,
      runId: "rebuild",
    });
    await Promise.resolve();
    lookup.resolve(match);
    const [one, two] = await Promise.all([first, second]);
    expect(one?.prependContext).toContain('<skill name="fixture">');
    expect(two?.prependContext).toEqual(one?.prependContext);
    expect(f.sessionLookup).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "session",
    });
    expect(f.selector).toHaveBeenCalledTimes(1);
    expect(f.listSessionEntries).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "settles a current admission on its rebuilt run during lookup (attempt: %s)",
    async (withAttempt) => {
      const f = fixture();
      await f.handlers.onBeforePromptBuild(admitted, ctx);
      const turnKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
      const rebuild = { ...noKey, runId: "rebuild" };
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const warn = vi.spyOn(logger, "warn");
      const pending = f.handlers.onBeforePromptBuild(admitted, rebuild);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      if (withAttempt)
        await f.handlers.onAgentEnd(
          {
            success: true,
            messages: [{ role: "assistant", content: "rebuilt reply" }],
          },
          rebuild,
        );
      await settleRun(f.handlers, rebuild);
      expect(finalize).not.toHaveBeenCalled();
      lookup.resolve(match);
      const result = await pending;

      expect(result?.appendSystemContext).toContain("<working_set_skills>");
      expect(result?.prependContext).toBeUndefined();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("before_prompt_build hook error"),
      );
      expect(finalize).toHaveBeenCalledOnce();
      expect(f.tracker.getCurrentState(ctx.sessionId)).toMatchObject({
        turnKey,
        timestamps: { end: expect.any(String) },
      });
      expect(f.tracker.getCurrentState(ctx.sessionId)?.result).toBe(
        withAttempt ? "rebuilt reply" : undefined,
      );
      expect(f.turnAssociations.hasRun(rebuild.runId)).toBe(true);
      expect(f.turnAssociations.resolve(rebuild.runId)).toBeUndefined();
      expect(f.turnAssociations.resolve(ctx.runId)).toBeUndefined();
      await settleRun(f.handlers, rebuild);
      expect(finalize).toHaveBeenCalledOnce();
      expect(f.selector).toHaveBeenCalledOnce();
    },
  );

  it.each(["during lookup", "after lookup"] as const)(
    "settles a rebuilt current admission excluded by chat scope (%s)",
    async (settlementTiming) => {
      const f = fixture();
      await f.handlers.onBeforePromptBuild(admitted, ctx);
      const turnKey = f.tracker.getCurrentState(ctx.sessionId)!.turnKey!;
      const rebuild = { ...noKey, runId: "rebuild" };
      const lookup = deferred<typeof match | undefined>(undefined);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      const warn = vi.spyOn(logger, "warn");
      const pending = f.handlers.onBeforePromptBuild(admitted, rebuild);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      f.setConfig(
        resolveConfig({ routing: { scope: { chatTypes: ["group"] } } }),
      );

      if (settlementTiming === "during lookup")
        await settleRun(f.handlers, rebuild);
      expect(finalize).not.toHaveBeenCalled();
      lookup.resolve(match);
      const result = await pending;
      expect(result?.appendSystemContext).toContain("<working_set_skills>");
      expect(result?.prependContext).toBeUndefined();
      if (settlementTiming === "after lookup") {
        expect(f.turnAssociations.resolve(rebuild.runId)?.turnKey).toBe(
          turnKey,
        );
        await settleRun(f.handlers, rebuild);
      }

      expect(f.tracker.getCurrentState(ctx.sessionId)).toMatchObject({
        turnKey,
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
      await settleRun(f.handlers, rebuild);
      expect(finalize).toHaveBeenCalledOnce();
      expect(f.selector).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("before_prompt_build hook error"),
      );
    },
  );

  it("joins pending preparation before a rebuild exits prompt routing", async () => {
    const f = fixture();
    const release = deferred<void>(undefined);
    const prepareTurn = f.tracker.preparePromptTurn.bind(f.tracker);
    const prepare = vi
      .spyOn(f.tracker, "preparePromptTurn")
      .mockImplementationOnce(async (params) => {
        await release.promise;
        return prepareTurn(params);
      });
    const first = f.handlers.onBeforePromptBuild(admitted, ctx);
    await until(() => prepare.mock.calls.length === 1);
    const rebuild = { ...noKey, runId: "rebuild" };
    const lookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    let lookupReleased = false;
    let rebuiltAfterLookup = false;
    const pending = f.handlers.onBeforePromptBuild(admitted, {
      ...rebuild,
      inputProvenance: { kind: "internal_system" },
      hookInvocation: {
        assertActive: () => {
          if (lookupReleased) rebuiltAfterLookup = true;
        },
      },
    });
    await until(() => f.sessionLookup.mock.calls.length === 1);
    await settleRun(f.handlers, rebuild);
    lookupReleased = true;
    lookup.resolve(match);
    await until(() => rebuiltAfterLookup);

    release.resolve();
    await Promise.all([first, pending]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(
      f.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
    ).toBeTruthy();
    expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
  });

  it.each(["prepared", "preparing"] as const)(
    "settles a routing-excluded alias when the same admission is %s after working-set resolution",
    async (preparation) => {
      const f = fixture();
      const workingSet = deferred(["fixture"]);
      const afterWorkingSet = deferred<void>(undefined);
      const releasePreparation = deferred<void>(undefined);
      const prepareTurn = f.tracker.preparePromptTurn.bind(f.tracker);
      const prepare = vi
        .spyOn(f.tracker, "preparePromptTurn")
        .mockImplementationOnce(async (params) => {
          await releasePreparation.promise;
          return prepareTurn(params);
        });
      const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
      f.getWorkingSetSkills.mockReturnValueOnce(workingSet.promise);
      const rebuild = { ...ctx, runId: "rebuild" };
      let workingSetReleased = false;
      const first = f.handlers.onBeforePromptBuild(admitted, {
        ...rebuild,
        hookInvocation: {
          assertActive: () => {
            if (workingSetReleased) afterWorkingSet.resolve();
          },
        },
      });
      await until(() => f.getWorkingSetSkills.mock.calls.length === 1);
      expect(prepare).not.toHaveBeenCalled();

      const newerKey = "agent:main:direct:current";
      const second = f.handlers.onBeforePromptBuild(admitted, {
        ...ctx,
        sessionKey: newerKey,
      });
      await until(() => prepare.mock.calls.length === 1);
      if (preparation === "prepared") {
        releasePreparation.resolve();
        await second;
      }

      f.setConfig(
        resolveConfig({ routing: { scope: { chatTypes: ["group"] } } }),
      );
      await settleRun(
        f.handlers,
        { ...rebuild, sessionKey: newerKey },
        "settled reply",
      );
      expect(finalize).not.toHaveBeenCalled();
      workingSetReleased = true;
      workingSet.resolve(["fixture"]);
      await afterWorkingSet.promise;
      if (preparation === "preparing") releasePreparation.resolve();

      const [result] = await Promise.all([first, second]);
      expect(result?.appendSystemContext).toContain("<working_set_skills>");
      expect(result?.prependContext).toBeUndefined();
      expect(prepare).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledOnce();
      expect(f.tracker.getCurrentState(ctx.sessionId)).toMatchObject({
        result: "settled reply",
        timestamps: { end: expect.any(String) },
      });
      expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
    },
  );

  it("clears Review activity for an untracked skipped run settled during lookup", async () => {
    const f = fixture();
    f.setConfig(
      resolveConfig({ routing: { scope: { chatTypes: ["group"] } } }),
    );
    const lookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const pending = f.handlers.onBeforePromptBuild(admitted, noKey);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    await settleRun(f.handlers, {
      runId: ctx.runId,
      sessionKey: match.sessionKey,
    });
    expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(true);
    lookup.resolve(match);
    await pending;

    expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(false);
    expect(f.turnAssociations.hasRun(ctx.runId)).toBe(true);
    expect(f.tracker.getCurrentState(ctx.sessionId)?.turnKey).toBeUndefined();
    expect(f.selector).not.toHaveBeenCalled();
  });

  it("keeps a fresh run bindable after an unrelated key-only settlement during lookup", async () => {
    const f = fixture();
    const lookup = deferred<typeof match | undefined>(undefined);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
    const pending = f.handlers.onBeforePromptBuild(admitted, noKey);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    await settleRun(f.handlers, {
      runId: ctx.runId,
      sessionKey: "agent:main:unrelated",
    });
    expect(f.turnAssociations.hasActiveSession(ctx.sessionId)).toBe(true);
    lookup.resolve(match);
    await pending;

    const current = f.tracker.getCurrentState(ctx.sessionId);
    expect(current?.timestamps?.end).toBeUndefined();
    expect(f.turnAssociations.resolve(ctx.runId)).toMatchObject({
      sessionKey: match.sessionKey,
      turnKey: current?.turnKey,
    });
    expect(finalize).not.toHaveBeenCalled();
    await settleRun(f.handlers, ctx);
    expect(finalize).toHaveBeenCalledOnce();
    expect(
      f.tracker.getCurrentState(ctx.sessionId)?.timestamps?.end,
    ).toBeTruthy();
  });

  it.each(["native", "legacy-named", "legacy-anonymous"])(
    "rejects an older %s lookup returning after the newer request",
    async (kind) => {
      const f = fixture();
      const lookup = deferred<typeof match | undefined>(match);
      f.sessionLookup.mockReturnValueOnce(lookup.promise);
      const firstEvent = kind === "native" ? admitted : event;
      const secondEvent = {
        ...event,
        prompt: "fixture next",
        messages: [{ role: "user", content: "fixture next" }],
        ...(kind === "native" ? { currentUserMessageId: "admission-b" } : {}),
      };
      const firstCtx =
        kind === "legacy-anonymous" ? { ...noKey, runId: undefined } : noKey;
      const first = f.handlers.onBeforePromptBuild(firstEvent, firstCtx);
      await until(() => f.sessionLookup.mock.calls.length === 1);
      const secondCtx = {
        ...ctx,
        runId: kind === "legacy-anonymous" ? undefined : "run-b",
      };
      const second = await f.handlers.onBeforePromptBuild(
        secondEvent,
        secondCtx,
      );
      const turnB = f.tracker.getCurrentState("session")?.turnKey;
      lookup.resolve(match);
      expect((await first)?.prependContext).toBeUndefined();
      expect(second?.prependContext).toContain('<skill name="fixture">');
      expect(f.tracker.getCurrentState("session")?.turnKey).toBe(turnB);
      expect(f.selector).toHaveBeenCalledTimes(1);
      await f.handlers.onBeforePromptBuild(secondEvent, secondCtx);
      expect(f.selector).toHaveBeenCalledTimes(1);
    },
  );

  it("fences a pending old run from falling back to a newer anonymous turn", async () => {
    const f = fixture();
    const lookup = deferred<typeof match | undefined>(match);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const first = f.handlers.onBeforePromptBuild(admitted, noKey);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    await f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-b" },
      { ...ctx, runId: undefined },
    );
    const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
    await f.handlers.onAgentEnd(
      {
        runId: ctx.runId,
        success: true,
        messages: [{ role: "assistant", content: "late" }],
      },
      ctx,
    );
    await settleRun(f.handlers, ctx);
    expect(finalize).not.toHaveBeenCalled();
    expect(
      f.tracker.getCurrentState("session")?.timestamps?.end,
    ).toBeUndefined();
    lookup.resolve(match);
    await first;
  });

  it("makes a colliding run ambiguous while the second admission lookup is still pending", async () => {
    const f = fixture();
    await f.handlers.onBeforePromptBuild(admitted, ctx);
    const lookup = deferred<typeof match | undefined>(match);
    f.sessionLookup.mockReturnValueOnce(lookup.promise);
    const second = f.handlers.onBeforePromptBuild(
      { ...event, currentUserMessageId: "admission-b" },
      noKey,
    );
    await until(() => f.sessionLookup.mock.calls.length === 1);
    const finalize = vi.spyOn(f.tracker, "finalizeTurnFromAgentEnd");
    await f.handlers.onAgentEnd(
      {
        runId: ctx.runId,
        success: true,
        messages: [{ role: "assistant", content: "ambiguous" }],
      },
      ctx,
    );
    await settleRun(f.handlers, ctx);
    expect(finalize).not.toHaveBeenCalled();
    lookup.resolve(match);
    expect((await second)?.prependContext).toContain('<skill name="fixture">');
    expect(f.selector).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired invocation immediately after its lookup settles", async () => {
    const f = fixture();
    const lookup = deferred<typeof match | undefined>(match);
    f.sessionLookup.mockReturnValue(lookup.promise);
    let active = true;
    const prepare = vi.spyOn(f.tracker, "preparePromptTurn");
    const pending = f.handlers.onBeforePromptBuild(admitted, {
      ...noKey,
      hookInvocation: {
        assertActive: () => {
          if (!active) throw new Error("expired");
        },
      },
    });
    await until(() => f.sessionLookup.mock.calls.length === 1);
    active = false;
    lookup.resolve(match);
    await pending;
    expect(f.getWorkingSetSkills).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.selector).not.toHaveBeenCalled();
  });

  it("drains an accepted lookup on disposal without reserving a turn afterward", async () => {
    const f = fixture();
    const lookup = deferred<typeof match | undefined>(match);
    f.sessionLookup.mockReturnValue(lookup.promise);
    const prepare = vi.spyOn(f.tracker, "preparePromptTurn");
    const pending = f.handlers.onBeforePromptBuild(admitted, noKey);
    await until(() => f.sessionLookup.mock.calls.length === 1);
    f.lifecycle.abort();
    let disposed = false;
    const disposal = f.handlers.disposePromptWork().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    lookup.resolve(match);
    await Promise.all([pending, disposal]);
    expect(f.getWorkingSetSkills).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.selector).not.toHaveBeenCalled();
  });
});

describe("prompt routing deadlines", () => {
  it("drains a blocked handler during early-exit cleanup before resetting mocks", async () => {
    const f = fixture();
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.search.mock.calls.length > 0);
    await settleFixture();
    expect(operations.size).toBe(0);
    expect((await pending)?.prependContext).toBeUndefined();
    expect(f.selector).not.toHaveBeenCalled();
  });

  it.each(["named", "anonymous"])(
    "shares %s turn work across concurrent reentry and serial prompt rebuild",
    async (kind) => {
      const f = fixture();
      const callCtx = kind === "anonymous" ? { ...ctx, runId: undefined } : ctx;
      const selection = deferred<typeof selected>(selected);
      f.selector.mockReturnValue(selection.promise);
      const merge = vi.spyOn(f.tracker, "mergeTurnAndPersist");
      const first = f.handlers.onBeforePromptBuild(event, callCtx);
      await until(() => f.selector.mock.calls.length > 0);
      const second = f.handlers.onBeforePromptBuild(event, callCtx);
      await until(() => f.getWorkingSetSkills.mock.calls.length === 2);
      selection.resolve(selected);
      const [one, two] = await Promise.all([first, second]);
      expect(one?.prependContext).toContain('<skill name="fixture">');
      expect(two?.prependContext).toEqual(one?.prependContext);
      const third = await f.handlers.onBeforePromptBuild(event, callCtx);
      expect(third?.prependContext).toEqual(one?.prependContext);
      expect(f.selector).toHaveBeenCalledTimes(1);
      expect(f.search).toHaveBeenCalledTimes(1);
      expect(merge).toHaveBeenCalledTimes(1);
      expect(
        vi
          .mocked(emitAgentEvent)
          .mock.calls.filter(([event]) => event.data.phase === "rerank"),
      ).toHaveLength(1);
    },
  );

  it.each(["named", "anonymous"])(
    "does not duplicate %s selection while tracker preparation is pending",
    async (kind) => {
      const f = fixture();
      const callCtx = kind === "anonymous" ? { ...ctx, runId: undefined } : ctx;
      const release = deferred<void>(undefined);
      const original = f.tracker.preparePromptTurn.bind(f.tracker);
      const prepare = vi
        .spyOn(f.tracker, "preparePromptTurn")
        .mockImplementationOnce(async (params) => {
          await release.promise;
          return original(params);
        });
      const first = f.handlers.onBeforePromptBuild(event, callCtx);
      await until(() => prepare.mock.calls.length === 1);
      const second = f.handlers.onBeforePromptBuild(event, callCtx);
      await until(() => f.getWorkingSetSkills.mock.calls.length === 2);
      release.resolve();
      const [result] = await Promise.all([first, second]);
      expect(result?.prependContext).toContain('<skill name="fixture">');
      await f.handlers.onBeforePromptBuild(event, callCtx);
      expect(f.selector).toHaveBeenCalledTimes(1);
      expect(f.search).toHaveBeenCalledTimes(1);
    },
  );

  it("checks each joining invocation before returning shared dynamic context", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const first = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    let active = true;
    const second = f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      hookInvocation: {
        assertActive: () => {
          if (!active) throw new Error("inactive joined caller");
        },
      },
    });
    await until(() => f.getWorkingSetSkills.mock.calls.length === 2);
    active = false;
    selection.resolve(selected);
    expect((await first)?.prependContext).toContain('<skill name="fixture">');
    expect((await second)?.prependContext).toBeUndefined();
    expect(f.selector).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "completed"] as const)(
    "late agent_end for turn A preserves turn B’s %s selector and cached result",
    async (phase) => {
      const f = fixture();
      await f.handlers.onBeforePromptBuild(event, ctx);
      const selection = deferred<typeof selected>(selected);
      f.selector.mockReturnValueOnce(selection.promise);
      const nextCtx = { ...ctx, runId: "turn-b" };
      const next = f.handlers.onBeforePromptBuild(event, nextCtx);
      await until(() => f.selector.mock.calls.length === 2);
      const signal = f.selector.mock.calls[1][0].signal;
      if (phase === "completed") {
        selection.resolve(selected);
        expect((await next)?.prependContext).toContain(
          '<skill name="fixture">',
        );
      }
      await f.handlers.onAgentEnd(
        {
          runId: "turn",
          messages: [{ role: "assistant", content: "Turn A complete" }],
          success: true,
        },
        ctx,
      );
      await settleRun(f.handlers, ctx);
      expect(
        f.tracker.getTurnState("session", "turn")?.timestamps?.end,
      ).toBeTruthy();
      expect(signal?.aborted).toBe(false);
      selection.resolve(selected);
      const result = await next;
      expect(result?.prependContext).toContain('<skill name="fixture">');
      const replay = await f.handlers.onBeforePromptBuild(event, nextCtx);
      expect(replay?.prependContext).toEqual(result?.prependContext);
      expect(f.selector).toHaveBeenCalledTimes(2);
      expect(f.search).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps selection failure terminal and admits a genuine next turn", async () => {
    const f = fixture();
    f.selector.mockRejectedValueOnce(new Error("selection failed"));
    expect(
      (await f.handlers.onBeforePromptBuild(event, ctx))?.prependContext,
    ).toBeUndefined();
    expect(
      (await f.handlers.onBeforePromptBuild(event, ctx))?.prependContext,
    ).toBeUndefined();
    expect(f.selector).toHaveBeenCalledTimes(1);
    const next = await f.handlers.onBeforePromptBuild(
      {
        prompt: "fixture next",
        messages: [{ role: "user", content: "fixture next" }],
      },
      { ...ctx, runId: "next" },
    );
    expect(next?.prependContext).toContain('<skill name="fixture">');
    expect(f.selector).toHaveBeenCalledTimes(2);
  });

  it("refreshes static context when replaying the cached dynamic result", async () => {
    const f = fixture();
    const first = await f.handlers.onBeforePromptBuild(event, ctx);
    f.getWorkingSetSkills.mockResolvedValue([]);
    f.setConfig(
      resolveConfig({
        skills: { includeWorkspaceSkills: false, includeWorkshopSkills: false },
      }),
    );
    const second = await f.handlers.onBeforePromptBuild(event, ctx);
    expect(first?.appendSystemContext).toContain("<working_set_skills>");
    expect(second?.appendSystemContext).not.toContain("<working_set_skills>");
    expect(second?.prependContext).toEqual(first?.prependContext);
    expect(f.selector).toHaveBeenCalledTimes(1);
  });

  it("aborts the selector on lifecycle stop and drains accepted work before disposal", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const first = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    const signal = f.selector.mock.calls[0][0].signal;
    expect(signal?.aborted).toBe(false);
    f.lifecycle.abort();
    expect(signal?.aborted).toBe(true);
    let disposed = false;
    const disposal = f.handlers.disposePromptWork().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect((await first)?.prependContext).toBeUndefined();
    const next = await f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      runId: "next",
    });
    expect(next?.appendSystemContext).toContain("<working_set_skills>");
    expect(f.selector).toHaveBeenCalledTimes(1);
    selection.resolve(selected);
    await disposal;
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toBeUndefined();
  });

  it("aborts a replaced turn before starting the next selector", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValueOnce(selection.promise);
    const first = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    const signal = f.selector.mock.calls[0][0].signal;
    const next = await f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      runId: "next",
    });
    expect(signal?.aborted).toBe(true);
    expect(next?.prependContext).toContain('<skill name="fixture">');
    expect((await first)?.prependContext).toBeUndefined();
    selection.resolve(selected);
  });

  it("cancels a superseded selector even when the next turn disables dynamic routing", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const first = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    const signal = f.selector.mock.calls[0][0].signal;
    f.setConfig(
      resolveConfig({
        routing: {
          skills: { maxInjectedSkills: 0 },
        },
      }),
    );
    const next = await f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      runId: "next",
    });
    expect(signal?.aborted).toBe(true);
    expect(next?.prependContext).toBeUndefined();
    expect((await first)?.prependContext).toBeUndefined();
    selection.resolve(selected);
    expect(f.selector).toHaveBeenCalledTimes(1);
  });

  it("does not admit retrieval after cancellation during inventory discovery", async () => {
    const f = fixture();
    const release = deferred<void>(undefined);
    const original = skillInventory.listAvailableSkills;
    let discovering = false;
    vi.spyOn(skillInventory, "listAvailableSkills").mockImplementation(
      async (params) => {
        const result = await original(params);
        if (!params.source) {
          discovering = true;
          await release.promise;
        }
        return result;
      },
    );
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => discovering);
    f.lifecycle.abort();
    expect((await pending)?.prependContext).toBeUndefined();
    release.resolve();
    await f.handlers.disposePromptWork();
    expect(f.search).not.toHaveBeenCalled();
    expect(f.selector).not.toHaveBeenCalled();
  });

  it("does not publish successful discovery events after lifecycle cancellation", async () => {
    const f = fixture();
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.search.mock.calls.length > 0);
    f.lifecycle.abort();
    expect((await pending)?.prependContext).toBeUndefined();
    search.resolve([]);
    await f.handlers.disposePromptWork();
    expect(f.selector).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(emitAgentEvent)
        .mock.calls.filter(
          ([event]) =>
            event.data.phase === "search" && event.data.state === "completed",
        ),
    ).toHaveLength(0);
  });

  it("cancels in-flight turn work on session_end", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    const signal = f.selector.mock.calls[0][0].signal;
    await f.handlers.onSessionEnd(
      { sessionId: "session", messageCount: 1 },
      { agentId: "main", sessionId: "session" },
    );
    expect(signal?.aborted).toBe(true);
    expect((await pending)?.prependContext).toBeUndefined();
    selection.resolve(selected);
  });

  it("uses enabled search budgets plus selection and overhead", () => {
    const config = resolveConfig({});
    expect(promptRoutingBudgetMs(config.routing)).toBe(21_500);
    config.routing.skills.maxInjectedSkills = 0;
    config.routing.skills.search.timeoutMs = 60_000;
    expect(promptRoutingBudgetMs(config.routing)).toBe(6_500);
    config.routing.skills.maxInjectedSkills = 1;
    config.routing.timeoutMs = 60_000;
    expect(promptRoutingBudgetMs(config.routing)).toBe(
      MAX_PROMPT_HOOK_TIMEOUT_MS,
    );
  });

  it("retains context after 12-second retrieval through the installed host", async () => {
    const f = fixture();
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const runner = hostRunner({
      typedHooks: [
        {
          hookName: "before_prompt_build",
          pluginId: "skill-harness",
          timeoutMs: MAX_PROMPT_HOOK_TIMEOUT_MS,
          handler: f.handlers.onBeforePromptBuild,
        },
      ],
    });
    const pending = runner.runBeforePromptBuild(event, ctx);
    await until(() => f.search.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(12_000);
    search.resolve([]);
    const result = await pending;
    expect(result?.appendSystemContext).toContain("<working_set_skills>");
    expect(result?.prependContext).toContain('<skill name="fixture">');
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toEqual([
      "fixture",
    ]);
  });

  it("uses live larger budgets without changing the host registration", async () => {
    const f = fixture();
    f.setConfig(
      resolveConfig({
        qmd: { timeoutMs: 30_000 },
      }),
    );
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const runner = hostRunner({
      typedHooks: [
        {
          hookName: "before_prompt_build",
          pluginId: "skill-harness",
          timeoutMs: MAX_PROMPT_HOOK_TIMEOUT_MS,
          handler: f.handlers.onBeforePromptBuild,
        },
      ],
    });
    const pending = runner.runBeforePromptBuild(event, ctx);
    await until(() => f.search.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(25_000);
    search.resolve([]);
    expect((await pending)?.prependContext).toContain('<skill name="fixture">');
  });

  it("bounds a stalled skill search and ignores its late result", async () => {
    const f = fixture();
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.search.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(15_000);
    // A timed-out QMD search can still leave deterministic name evidence.
    const result = await pending;
    expect(result?.prependContext).toContain('<skill name="fixture">');
    expect(f.selector).toHaveBeenCalledTimes(1);
    search.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.selector).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(emitAgentEvent)
        .mock.calls.filter(
          ([event]) =>
            event.data.phase === "pipeline" && event.data.state !== "started",
        ),
    ).toHaveLength(1);
  });

  it("does not commit selection to a superseded turn", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    await f.tracker.preparePromptTurn({
      sessionId: "session",
      agentId: "main",
      runId: "new-turn",
      input: "next",
      startedAt: new Date().toISOString(),
    });
    selection.resolve(selected);
    const result = await pending;
    expect(result?.prependContext).toBeUndefined();
    expect(f.tracker.getCurrentState("session")?.turnKey).toBe("new-turn");
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toBeUndefined();
    expect(
      vi
        .mocked(emitAgentEvent)
        .mock.calls.filter(([event]) => event.data.phase === "rerank"),
    ).toHaveLength(0);
  });

  it("fails open on selector timeout and ignores its late selection", async () => {
    const f = fixture();
    const selection = deferred<typeof selected>(selected);
    f.selector.mockReturnValue(selection.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(f.selector.mock.calls[0][0].signal?.aborted).toBe(true);
    await f.handlers.onBeforePromptBuild(event, ctx);
    expect(f.selector).toHaveBeenCalledTimes(1);
    expect(result?.appendSystemContext).toContain("<working_set_skills>");
    expect(result?.prependContext).toBeUndefined();
    selection.resolve(selected);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toEqual([]);
    const terminal = vi
      .mocked(emitAgentEvent)
      .mock.calls.filter(
        ([event]) =>
          event.data.phase === "pipeline" && event.data.state !== "started",
      );
    expect(terminal).toHaveLength(1);
  });

  it("does not persist after the host invalidates the invocation", async () => {
    const f = fixture();
    const search = deferred<[]>([]);
    f.search.mockReturnValue(search.promise);
    let active = true;
    const pending = f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      hookInvocation: {
        assertActive: () => {
          if (!active) throw Error("host expired");
        },
      },
    });
    await until(() => f.search.mock.calls.length > 0);
    active = false;
    search.resolve([]);
    await pending;
    expect(f.selector).not.toHaveBeenCalled();
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toBeUndefined();
  });

  it("does not prepare an expired turn and releases its reservation for a retry", async () => {
    const f = fixture();
    const release = deferred<void>(undefined);
    const original = f.tracker.preparePromptTurn.bind(f.tracker);
    const prepare = vi
      .spyOn(f.tracker, "preparePromptTurn")
      .mockImplementationOnce((params) =>
        track(
          (async () => {
            await release.promise;
            return original(params);
          })(),
        ),
      );
    let active = true;
    const invocation = {
      assertActive: () => {
        if (!active) throw new Error("host expired");
      },
    };
    const pending = f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      hookInvocation: invocation,
    });
    await until(() => prepare.mock.calls.length > 0);
    active = false;
    release.resolve();
    await pending;
    expect(f.tracker.getCurrentState("session")?.turnKey).toBeUndefined();
    expect(f.search).not.toHaveBeenCalled();
    expect(f.selector).not.toHaveBeenCalled();
    active = true;
    const result = await f.handlers.onBeforePromptBuild(event, {
      ...ctx,
      hookInvocation: invocation,
    });
    expect(result?.prependContext).toContain('<skill name="fixture">');
    expect(f.tracker.getCurrentState("session")?.turnKey).toBe("turn");
  });

  it("rechecks validity inside a delayed persistence operation", async () => {
    const f = fixture();
    const release = deferred<void>(undefined);
    const original = f.tracker.mergeTurnAndPersist.bind(f.tracker);
    const merge = vi
      .spyOn(f.tracker, "mergeTurnAndPersist")
      .mockImplementation((params) =>
        track(
          (async () => {
            await release.promise;
            return original(params);
          })(),
        ),
      );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => merge.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(21_500);
    const result = await pending;
    expect(result?.appendSystemContext).toContain("<working_set_skills>");
    expect(result?.prependContext).toBeUndefined();
    release.resolve();
    await until(() => f.tracker.getCurrentState("session") !== undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tracker.getCurrentState("session")?.matchedSkills).toBeUndefined();
    expect(
      vi
        .mocked(emitAgentEvent)
        .mock.calls.filter(([event]) => event.data.phase === "rerank"),
    ).toHaveLength(0);
  });

  it("propagates parent cancellation and removes its deadline timer", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const done = deferred<void>(undefined);
    let signal: AbortSignal | undefined;
    const pending = withPromptDeadline(
      100,
      () => {},
      async (_assertActive, childSignal) => {
        signal = childSignal;
        await done.promise;
      },
      parent.signal,
    );
    const check = expect(pending).rejects.toThrow("cancelled");
    parent.abort();
    expect(signal?.aborted).toBe(true);
    await check;
    expect(vi.getTimerCount()).toBe(0);
    done.resolve();
  });

  it("expires guards even when an operation completes after its deadline", async () => {
    vi.useFakeTimers();
    const done = deferred<void>(undefined);
    let guard!: () => void;
    const pending = withPromptDeadline(
      100,
      () => {},
      async (assertActive) => {
        guard = assertActive;
        await done.promise;
      },
    );
    const check = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(guard).toThrow("expired");
    done.resolve();
  });
});
