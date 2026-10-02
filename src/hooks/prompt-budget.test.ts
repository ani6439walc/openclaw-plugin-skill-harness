import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { SessionTracker } from "../session/tracker.js";
import { createHookHandlers } from "./index.js";
import {
  MAX_PROMPT_HOOK_TIMEOUT_MS,
  promptRoutingBudgetMs,
  withPromptDeadline,
} from "./prompt-budget.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "./types.js";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  emitAgentEvent: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
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
  const selector = vi.fn(async () => selected);
  const handlers = createHookHandlers({
    api: {
      config: {},
      runtime: {
        state: { resolveStateDir: () => root },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi,
    dataRoot: root,
    tracker,
    config: () => config,
    refreshLiveConfigFromRuntime: () => {},
    getWorkingSetSkills: async () => ["fixture"],
    qmdSkillIndex: {
      search,
      schedule: () => {},
      getStatus: () => "ready",
      close: async () => {},
    },
    routingSelector: selector,
  });
  return {
    tracker,
    search,
    selector,
    handlers,
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

describe("prompt routing deadlines", () => {
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
    const search = deferred<[]>();
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
    const search = deferred<[]>();
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
    const search = deferred<[]>();
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
    const selection = deferred<typeof selected>();
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
    const selection = deferred<typeof selected>();
    f.selector.mockReturnValue(selection.promise);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = f.handlers.onBeforePromptBuild(event, ctx);
    await until(() => f.selector.mock.calls.length > 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
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
    const search = deferred<[]>();
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
    const release = deferred<void>();
    const original = f.tracker.preparePromptTurn.bind(f.tracker);
    const prepare = vi
      .spyOn(f.tracker, "preparePromptTurn")
      .mockImplementationOnce(async (params) => {
        await release.promise;
        return original(params);
      });
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
    const release = deferred<void>();
    const original = f.tracker.mergeTurnAndPersist.bind(f.tracker);
    const merge = vi
      .spyOn(f.tracker, "mergeTurnAndPersist")
      .mockImplementation(async (params) => {
        await release.promise;
        return original(params);
      });
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

  it("expires guards even when an operation completes after its deadline", async () => {
    vi.useFakeTimers();
    const done = deferred<void>();
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
