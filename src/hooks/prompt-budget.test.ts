import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as realDelay } from "node:timers/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import * as skillInventory from "../skills/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
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
  experiences: [],
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
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-budget-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const skillDir = path.join(workspace, "skills", "fixture");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture skill.\n---\nInstructions.",
  );
  const tracker = SessionTracker.create(root);
  let config = resolveConfig({
    routing: { experiences: { maxInjectedExperiences: 0 } },
  });
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
    vi.spyOn(defaultStatsAggregator, "record").mockReturnValue(false);
    const admitted = { ...event, currentUserMessageId: "admission-a" };
    await f.handlers.onBeforePromptBuild(admitted, ctx);
    await f.handlers.onMessageSending({ content: "done" }, ctx);
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

  it.each([
    ["agent_end", "pending"],
    ["agent_end", "completed"],
    ["message_sending", "pending"],
    ["message_sending", "completed"],
  ] as const)(
    "late %s for turn A preserves turn B's %s selector and cached result",
    async (completion, phase) => {
      const f = fixture();
      vi.spyOn(defaultStatsAggregator, "record").mockReturnValue(false);
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
      if (completion === "agent_end") {
        await f.handlers.onAgentEnd(
          {
            runId: "turn",
            messages: [{ role: "assistant", content: "Turn A complete" }],
            success: true,
          },
          ctx,
        );
      } else {
        await f.handlers.onMessageSending({ content: "Turn A complete" }, ctx);
      }
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
        routing: { experiences: { maxInjectedExperiences: 0 } },
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
          experiences: { maxInjectedExperiences: 0 },
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
    expect(promptRoutingBudgetMs(config.routing)).toBe(21_500);
    config.routing.experiences.search.timeoutMs = 60_000;
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
        routing: { experiences: { maxInjectedExperiences: 0 } },
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
