import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, type OpenClawPluginApi } from "../api.js";
import {
  createConfiguredAgentSkillsResolver,
  createPlugin,
  extractConfiguredAgentIds,
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
        agent: {
          resolveAgentWorkspaceDir: () => stateDir,
        },
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
    expect(api.on).toHaveBeenCalledWith(
      "message_sending",
      expect.any(Function),
    );
  });

  it("registers skill tools without legacy review command surfaces", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(
      api.registerTool.mock.calls.map(([tool, options]) =>
        typeof tool === "function" ? options?.name : tool.name,
      ),
    ).toEqual(["skill_list", "skill_search", "skill_view", "skill_experience"]);
    expect(api.registerCommand).not.toHaveBeenCalled();
  });

  it("budgets before_prompt_build timeout for topic and classifier rounds only", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      { timeoutMs: 11_500 },
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

  it("refreshes QMD sources only on the configured polling interval", async () => {
    vi.useFakeTimers();
    const api = createApi({
      pluginConfig: { qmd: { indexRefreshIntervalSeconds: 300 } },
    });
    const load = vi.spyOn(IntentCatalog.prototype, "load").mockReturnValue(0);

    createPlugin(api).register(api);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("extracts configured agent IDs from entries", () => {
    const config = {
      agents: {
        defaults: { skills: ["alpha"] },
        entries: {
          main: { skills: ["alpha"] },
          coder: {},
          REVIEWER: { skills: [] },
        },
      },
    };
    expect(extractConfiguredAgentIds(config as never)).toEqual([
      "main",
      "coder",
      "reviewer",
    ]);
  });

  it("schedules skill search indexing for all configured agents on refresh", async () => {
    let scheduleSpy: ReturnType<typeof vi.fn> | undefined;
    createHookHandlersSpy.mockImplementationOnce(
      (deps: {
        qmdSkillIndex?: { schedule: (...args: unknown[]) => void };
      }) => {
        if (deps.qmdSkillIndex) {
          scheduleSpy = vi.spyOn(deps.qmdSkillIndex, "schedule");
        }
      },
    );

    const api = createApi({
      config: {
        agents: {
          entries: {
            main: {},
            coder: {},
            reviewer: {},
          },
        },
      },
      pluginConfig: { qmd: { indexRefreshIntervalSeconds: 300 } },
    });

    createPlugin(api).register(api);
    await vi.waitFor(
      () => {
        expect(scheduleSpy).toHaveBeenCalledWith("main", expect.any(Array));
        expect(scheduleSpy).toHaveBeenCalledWith("coder", expect.any(Array));
        expect(scheduleSpy).toHaveBeenCalledWith("reviewer", expect.any(Array));
      },
      { timeout: 3000 },
    );
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

  it("wipes agents.defaults.skills and agents.entries.*.skills during registration", () => {
    const apiConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        entries: {
          writer: { skills: ["docs-search"] },
          coder: {},
        },
      },
    };
    const runtimeConfig = {
      agents: {
        defaults: {
          skills: ["slack"],
        },
        entries: {
          main: { skills: ["acpx"] },
        },
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
    expect(apiConfig.agents.entries.writer.skills).toEqual([]);
    expect(apiConfig.agents.entries.coder.skills).toEqual([]);
    expect(runtimeConfig.agents.defaults.skills).toEqual([]);
    expect(runtimeConfig.agents.entries.main.skills).toEqual([]);
  });

  it("asynchronously refreshes configured skills from raw config and clears removed skills", async () => {
    const configPath = path.join(stateDir, "openclaw.json");
    const writeOpenClawConfig = (skills: string[]) => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { entries: { main: { skills } } },
        }),
      );
    };
    writeOpenClawConfig(["skill-harness"]);

    const apiConfig = {
      agents: { entries: { main: { skills: ["skill-harness"] } } },
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

  it("resolves QMD provider baseUrl and apiKey dynamically from live OpenClaw config", () => {
    const apiConfig = {
      models: {
        providers: {
          bifrost: {
            baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
            apiKey: "bifrost-secret-token",
            models: [],
          },
        },
      },
    };
    const api = createApi({
      config: apiConfig,
      pluginConfig: {
        qmd: {
          embedding: {
            model: "bifrost/text-embedding-3-small",
          },
          expansion: {
            model: "bifrost/gpt-4o-mini",
          },
        },
      },
      runtime: {
        agent: { resolveAgentWorkspaceDir: () => stateDir },
        config: { current: () => apiConfig },
        state: { resolveStateDir: () => stateDir },
      } as never,
    });

    createPlugin(api).register(api);

    expect(createHookHandlersSpy).toHaveBeenCalled();
    const deps = createHookHandlersSpy.mock.calls[0][0];
    const resolvedConfig = deps.config();
    expect(resolvedConfig.qmd.embedding.baseUrl).toBe(
      "https://bifrost.home-infra.weii.cloud/openai/v1",
    );
    expect(resolvedConfig.qmd.embedding.model).toBe("text-embedding-3-small");
    expect(resolvedConfig.qmd.embedding.apiKey).toBe("bifrost-secret-token");
    expect(resolvedConfig.qmd.expansion.baseUrl).toBe(
      "https://bifrost.home-infra.weii.cloud/openai/v1",
    );
    expect(resolvedConfig.qmd.expansion.model).toBe("gpt-4o-mini");
    expect(resolvedConfig.qmd.expansion.apiKey).toBe("bifrost-secret-token");
  });
});
