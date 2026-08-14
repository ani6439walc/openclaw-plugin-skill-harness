import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, type OpenClawPluginApi } from "../api.js";
import {
  createConfiguredAgentSkillsResolver,
  createPlugin,
  initializePluginDataRoot,
} from "./plugin.js";
import { IntentCatalog } from "./intents/index.js";
import { KeywordCoverageWriter } from "./review/keyword-coverage-writer.js";
import { IntentReviewLogWriter } from "./review/log-writer.js";
import { SessionTracker } from "./session/index.js";
import { StatsAggregator } from "./stats/index.js";

const { createHookHandlersSpy } = vi.hoisted(() => ({
  createHookHandlersSpy: vi.fn(),
}));

vi.mock("./hooks/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/index.js")>();
  return {
    ...actual,
    createHookHandlers: (
      ...args: Parameters<typeof actual.createHookHandlers>
    ) => {
      createHookHandlersSpy(args[0]);
      return actual.createHookHandlers(...args);
    },
  };
});

describe("createPlugin", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-state-"));
    createHookHandlersSpy.mockClear();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createApi(overrides: Partial<OpenClawPluginApi> = {}) {
    const on = vi.fn();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const api = {
      config: {},
      pluginConfig: {},
      runtime: {
        config: {
          current: () => ({}),
        },
        state: {
          resolveStateDir: () => stateDir,
        },
      },
      on,
      registerTool,
      registerCommand,
      ...overrides,
    } as unknown as OpenClawPluginApi & {
      on: ReturnType<typeof vi.fn>;
      registerTool: ReturnType<typeof vi.fn>;
      registerCommand: ReturnType<typeof vi.fn>;
    };
    return api;
  }

  it("registers the session_end hook", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith("session_end", expect.any(Function));
  });

  it("registers tool tracking and finalize hooks", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith(
      "before_tool_call",
      expect.any(Function),
    );
    expect(api.on).toHaveBeenCalledWith(
      "tool_result_persist",
      expect.any(Function),
    );
    expect(api.on).toHaveBeenCalledWith(
      "before_agent_finalize",
      expect.any(Function),
    );
  });

  it("injects a curation queue scoped to each plugin registration", () => {
    const firstApi = createApi();
    const secondApi = createApi();

    createPlugin(firstApi).register(firstApi);
    createPlugin(secondApi).register(secondApi);

    const firstQueue = createHookHandlersSpy.mock.calls[0][0].curationQueue;
    const secondQueue = createHookHandlersSpy.mock.calls[1][0].curationQueue;
    expect(firstQueue).toEqual({
      enqueue: expect.any(Function),
      has: expect.any(Function),
    });
    expect(secondQueue).not.toBe(firstQueue);
  });

  it("defers curation recovery independently of review enablement", async () => {
    vi.useFakeTimers();
    const api = createApi({ pluginConfig: { review: { enabled: false } } });
    const listProcessedEventIds = vi
      .spyOn(StatsAggregator.prototype, "listProcessedEventIds")
      .mockReturnValue(new Set());
    const listRetainedSessions = vi
      .spyOn(SessionTracker.prototype, "listRetainedSessions")
      .mockReturnValue([]);
    const listPendingCurationSchedules = vi
      .spyOn(SessionTracker.prototype, "listPendingCurationSchedules")
      .mockResolvedValue([]);

    createPlugin(api).register(api);

    expect(api.registerTool).toHaveBeenCalledTimes(5);
    expect(api.on).toHaveBeenCalledWith("session_end", expect.any(Function));
    expect(listProcessedEventIds).not.toHaveBeenCalled();
    expect(listRetainedSessions).not.toHaveBeenCalled();
    expect(listPendingCurationSchedules).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(listProcessedEventIds).toHaveBeenCalled();
    expect(listRetainedSessions).toHaveBeenCalled();
    expect(listPendingCurationSchedules).toHaveBeenCalled();
  });

  it("fails open when deferred curation recovery fails", async () => {
    vi.useFakeTimers();
    const api = createApi();
    const error = new Error("pending schedules unavailable");
    vi.spyOn(
      SessionTracker.prototype,
      "listPendingCurationSchedules",
    ).mockRejectedValue(error);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(() => createPlugin(api).register(api)).not.toThrow();
    await vi.runAllTimersAsync();

    expect(warn).toHaveBeenCalledWith("failed to recover curation schedules", {
      error,
    });
  });

  it("registers skill tools without legacy review command surfaces", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(
      api.registerTool.mock.calls.map(([tool, options]) =>
        typeof tool === "function" ? options?.name : tool.name,
      ),
    ).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
      "skill_manage",
      "skill_experience",
    ]);
    expect(api.registerCommand).not.toHaveBeenCalled();
  });

  it("budgets before_prompt_build timeout for topic and classifier rounds only", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      { timeoutMs: 7_500 },
    );
  });

  it("initializes the runtime data root under the OpenClaw state directory", () => {
    const api = createApi();

    createPlugin(api).register(api);

    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    expect(fs.existsSync(path.join(dataRoot, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "intents"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "sessions", "stats.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dataRoot, "sessions", "review.json"))).toBe(
      false,
    );
  });

  it("keeps runtime stats and review files at the data-root level", () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "stats.json"), '{"stats":true}');
    fs.writeFileSync(
      path.join(dataRoot, "review.json"),
      '{"schemaVersion":6,"createdAt":"2026-07-01T00:00:00.000Z","updatedAt":"2026-07-01T00:00:00.000Z","processedEvents":{},"reviewedSkillEpochs":{},"historicalKeywordAudits":{}}',
    );

    createPlugin(api).register(api);

    expect(fs.readFileSync(path.join(dataRoot, "stats.json"), "utf-8")).toBe(
      '{"stats":true}',
    );
    expect(fs.existsSync(path.join(dataRoot, "sessions", "stats.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(dataRoot, "sessions", "review.json"))).toBe(
      false,
    );
  });

  it("ignores legacy evolution.json without creating review.json", () => {
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    const legacyLog = '{"schemaVersion":4}';
    fs.writeFileSync(path.join(dataRoot, "evolution.json"), legacyLog);

    initializePluginDataRoot({ dataRoot });

    expect(
      fs.readFileSync(path.join(dataRoot, "evolution.json"), "utf-8"),
    ).toBe(legacyLog);
    expect(fs.existsSync(path.join(dataRoot, "review.json"))).toBe(false);
  });

  it("loads runtime intents from the fixed data-root intents directory", () => {
    const api = createApi();
    const load = vi.spyOn(IntentCatalog.prototype, "load").mockReturnValue(0);

    createPlugin(api).register(api);

    expect(load).toHaveBeenCalledWith("intents");
  });

  it("registers hooks when keyword coverage keyword cache is corrupt", () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "keyword-coverage.json"), "{ broken");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(() => createPlugin(api).register(api)).not.toThrow();

    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    // Fail-open: corrupt coverage file should not block registration.
    expect(warn).not.toHaveBeenCalledWith(
      "failed to read review trigger keywords",
      expect.anything(),
    );
  });

  function createPackageRootWithAssets(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-package-root-"));
    const assetsDir = path.join(root, "skills", "skill-harness", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(assetsDir, name), content);
    }
    return root;
  }

  it("copies example intent assets when the runtime intents directory is missing", () => {
    const packageRoot = createPackageRootWithAssets({
      "example.md": "example",
      "ignore.txt": "ignore",
    });
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(fs.readdirSync(path.join(dataRoot, "experiences"))).toEqual([]);
      expect(fs.readdirSync(path.join(dataRoot, "intents"))).toEqual([
        "example.md",
      ]);
      expect(
        fs.readFileSync(path.join(dataRoot, "intents", "example.md"), "utf-8"),
      ).toBe("example");
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("copies example intent assets when the runtime intents directory is empty", () => {
    const packageRoot = createPackageRootWithAssets({
      "example.md": "example",
    });
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(path.join(dataRoot, "intents"), { recursive: true });
    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(fs.readdirSync(path.join(dataRoot, "intents"))).toEqual([
        "example.md",
      ]);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("copies example intent assets when the runtime intents directory has no Markdown intents", () => {
    const packageRoot = createPackageRootWithAssets({
      "example.md": "example",
    });
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(path.join(dataRoot, "intents"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "intents", "notes.txt"), "notes");
    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(fs.readdirSync(path.join(dataRoot, "intents")).sort()).toEqual([
        "example.md",
        "notes.txt",
      ]);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing runtime intent files", () => {
    const packageRoot = createPackageRootWithAssets({
      "custom.md": "seed",
      "example.md": "example",
    });
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    const intentsDir = path.join(dataRoot, "intents");
    fs.mkdirSync(intentsDir, { recursive: true });
    fs.writeFileSync(path.join(intentsDir, "custom.md"), "custom");

    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(fs.readdirSync(intentsDir)).toEqual(["custom.md"]);
      expect(fs.readFileSync(path.join(intentsDir, "custom.md"), "utf-8")).toBe(
        "custom",
      );
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("does not copy legacy package sessions after migration is complete", () => {
    const packageRoot = createPackageRootWithAssets({
      "example.md": "example",
    });
    const oldSessions = path.join(packageRoot, "sessions");
    fs.mkdirSync(oldSessions, { recursive: true });
    fs.writeFileSync(
      path.join(oldSessions, "old-session.json"),
      '{"sessionId":"old-session"}',
    );
    fs.writeFileSync(path.join(oldSessions, "stats.json"), '{"old":true}');
    fs.writeFileSync(path.join(oldSessions, "review.json"), '{"old":true}');

    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(
        fs.existsSync(path.join(dataRoot, "sessions", "old-session.json")),
      ).toBe(false);
      expect(fs.existsSync(path.join(dataRoot, "stats.json"))).toBe(false);
      expect(fs.existsSync(path.join(dataRoot, "review.json"))).toBe(false);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("wipes agents.defaults.skills and agents.list[].skills to empty arrays during registration", () => {
    const apiConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: ["docs-search"] }, { id: "coder" }],
      },
    };
    const runtimeConfig = {
      agents: {
        defaults: {
          skills: ["slack"],
        },
        list: [{ id: "main", skills: ["acpx"] }],
      },
    };
    const api = createApi({
      config: apiConfig,
      runtime: {
        config: {
          current: () => runtimeConfig,
        },
        state: {
          resolveStateDir: () => stateDir,
        },
      } as any,
    });

    createPlugin(api).register(api);

    expect(apiConfig.agents.defaults.skills).toEqual([]);
    expect(apiConfig.agents.list[0].skills).toEqual([]);
    expect(apiConfig.agents.list[1].skills).toEqual([]);
    expect(runtimeConfig.agents.defaults.skills).toEqual([]);
    expect(runtimeConfig.agents.list[0].skills).toEqual([]);
  });

  it("asynchronously refreshes configured skills from raw config and clears removed skills", async () => {
    const configPath = path.join(stateDir, "openclaw.json");
    const writeOpenClawConfig = (skills: string[]) => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { list: [{ id: "main", skills }] },
        }),
      );
    };
    writeOpenClawConfig(["skill-harness"]);

    const apiConfig = {
      agents: { list: [{ id: "main", skills: ["skill-harness"] }] },
    };
    const api = createApi({
      config: apiConfig,
      runtime: {
        config: { current: () => apiConfig },
        state: { resolveStateDir: () => stateDir },
      } as never,
    });
    const readFile = vi.spyOn(fs.promises, "readFile");
    const resolver = createConfiguredAgentSkillsResolver(
      api,
      new Map([["main", ["skill-harness"]]]),
    );
    const initial = await resolver("main");

    expect(readFile).toHaveBeenCalledWith(configPath, "utf8");
    expect(initial).toEqual(["skill-harness"]);

    writeOpenClawConfig([]);
    const removed = await resolver("main");

    expect(removed).toEqual([]);
  });
});
