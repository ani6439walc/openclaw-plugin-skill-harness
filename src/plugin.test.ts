import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import {
  createConfiguredAgentSkillsResolver,
  createPlugin,
  extractConfiguredAgentIds,
  initializePluginDataRoot,
} from "./plugin.js";
import { IntentCatalog } from "./intents/index.js";
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

  it("registers hooks and tools without runtime access during CLI metadata registration", () => {
    const runtime = new Proxy(Object.create(null), {
      get() {
        throw new Error("runtime unavailable");
      },
    });
    const api = createApi({
      registrationMode: "cli-metadata",
      runtime,
    } as Partial<OpenClawPluginApi>);

    expect(() => createPlugin(api).register(api)).not.toThrow();
    expect(api.on).toHaveBeenCalledTimes(8);
    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      expect.objectContaining({ priority: -1 }),
    );
    expect(
      api.registerTool.mock.calls.map(([tool, options]) =>
        typeof tool === "function" ? options?.name : tool.name,
      ),
    ).toEqual(["skill_list", "skill_search", "skill_view", "skill_experience"]);
  });

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

  it("registers before_prompt_build with lower priority to run after default prompt-build hooks", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      {
        timeoutMs: 11_500,
        priority: -1,
      },
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
          ＲＥＶＩＥＷＥＲ: { skills: [] },
        },
      },
    };
    expect(extractConfiguredAgentIds(config as never)).toEqual([
      "main",
      "coder",
      "reviewer",
    ]);
  });

  it("schedules skill search indexing for host and working-set agents on refresh", async () => {
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
            ＲＵＮＴＩＭＥ: {},
          },
        },
      },
      pluginConfig: {
        qmd: { indexRefreshIntervalSeconds: 300 },
        workingSetSkills: { agents: { writer: ["draft"] } },
      },
    });

    createPlugin(api).register(api);
    await vi.waitFor(
      () => {
        expect(scheduleSpy).toHaveBeenCalledWith(
          "main",
          expect.objectContaining({
            skills: expect.any(Array),
            sourceRoots: expect.any(Array),
          }),
        );
        expect(scheduleSpy).toHaveBeenCalledWith(
          "coder",
          expect.objectContaining({
            skills: expect.any(Array),
            sourceRoots: expect.any(Array),
          }),
        );
        expect(scheduleSpy).toHaveBeenCalledWith(
          "reviewer",
          expect.objectContaining({
            skills: expect.any(Array),
            sourceRoots: expect.any(Array),
          }),
        );
        expect(scheduleSpy).toHaveBeenCalledWith(
          "writer",
          expect.objectContaining({
            skills: expect.any(Array),
            sourceRoots: expect.any(Array),
          }),
        );
        expect(scheduleSpy).toHaveBeenCalledWith(
          "runtime",
          expect.objectContaining({
            skills: expect.any(Array),
            sourceRoots: expect.any(Array),
          }),
        );
        expect(scheduleSpy).not.toHaveBeenCalledWith(
          "ＲＵＮＴＩＭＥ",
          expect.anything(),
        );
      },
      { timeout: 3000 },
    );
  });

  it("does not disclose scheduler errors or agent identifiers", async () => {
    const privateAgentId = "private-agent/customer/path";
    const failure = new Error("private scheduler detail");
    failure.name = privateAgentId;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    createHookHandlersSpy.mockImplementationOnce(
      (deps: {
        qmdSkillIndex?: { schedule: (...args: unknown[]) => void };
      }) => {
        if (!deps.qmdSkillIndex) throw new Error("missing QMD skill index");
        vi.spyOn(deps.qmdSkillIndex, "schedule").mockImplementation(() => {
          throw failure;
        });
      },
    );
    const api = createApi({
      config: { agents: { entries: { [privateAgentId]: {} } } },
    });

    createPlugin(api).register(api);

    await vi.waitFor(() => {
      const receipt = warn.mock.calls.find(
        ([message]) => message === "failed to schedule QMD skill search index",
      );
      expect(receipt).toEqual([
        "failed to schedule QMD skill search index",
        { errorType: "Error", scheduled: false },
      ]);
      expect(JSON.stringify(receipt)).not.toContain(privateAgentId);
      expect(JSON.stringify(receipt)).not.toContain(failure.message);
    });
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

  it("preserves host skill configuration and resolves only live plugin working sets", async () => {
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
      plugins: {
        entries: {
          "skill-harness": {
            config: {
              workingSetSkills: {
                defaults: ["shared"],
                agents: { main: ["live-agent"] },
              },
            },
          },
        },
      },
    };
    const apiConfigBefore = structuredClone(apiConfig);
    const runtimeConfigBefore = structuredClone(runtimeConfig);
    const api = createApi({
      config: apiConfig,
      runtime: {
        config: {
          current: () => runtimeConfig,
        },
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });
    const readFile = vi.spyOn(fs.promises, "readFile");

    createPlugin(api).register(api);
    const deps = createHookHandlersSpy.mock.calls[0][0];

    expect(await deps.getConfiguredAgentSkills("main")).toEqual([
      "live-agent",
      "shared",
    ]);
    expect(apiConfig).toEqual(apiConfigBefore);
    expect(runtimeConfig).toEqual(runtimeConfigBefore);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves an agent-specific working set for an NFKC-equivalent runtime agent ID", async () => {
    const runtimeConfig = {
      plugins: {
        entries: {
          "skill-harness": {
            config: {
              workingSetSkills: {
                defaults: ["shared"],
                agents: { main: ["live-agent"] },
              },
            },
          },
        },
      },
    };
    const api = createApi({
      runtime: {
        config: { current: () => runtimeConfig },
        state: { resolveStateDir: () => stateDir },
      } as never,
    });

    createPlugin(api).register(api);
    const deps = createHookHandlersSpy.mock.calls[0][0];

    expect(await deps.getConfiguredAgentSkills("main")).toEqual([
      "live-agent",
      "shared",
    ]);
    expect(await deps.getConfiguredAgentSkills("ＭＡＩＮ")).toEqual([
      "live-agent",
      "shared",
    ]);
  });

  it("refreshes removed working-set names and fails open on malformed live config", async () => {
    let runtimeFailure = false;
    let runtimeConfig: Record<string, unknown> = {
      plugins: {
        entries: {
          "skill-harness": {
            config: {
              workingSetSkills: { agents: { main: ["skill-harness"] } },
            },
          },
        },
      },
    };
    const api = createApi({
      runtime: {
        config: {
          current: () => {
            if (runtimeFailure) throw new Error("runtime unavailable");
            return runtimeConfig;
          },
        },
        state: { resolveStateDir: () => stateDir },
      } as never,
    });
    const readFile = vi.spyOn(fs.promises, "readFile");
    createPlugin(api).register(api);
    const deps = createHookHandlersSpy.mock.calls[0][0];

    expect(await deps.getConfiguredAgentSkills("main")).toEqual([
      "skill-harness",
    ]);

    runtimeConfig = {
      plugins: {
        entries: {
          "skill-harness": {
            config: { workingSetSkills: { agents: { main: [] } } },
          },
        },
      },
    };
    expect(await deps.getConfiguredAgentSkills("main")).toEqual([]);

    runtimeConfig = {
      plugins: {
        entries: {
          "skill-harness": {
            config: { workingSetSkills: { agents: [] } },
          },
        },
      },
    };
    expect(await deps.getConfiguredAgentSkills("main")).toEqual([]);

    runtimeFailure = true;
    expect(await deps.getConfiguredAgentSkills("main")).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not disclose the agent identifier when live working-set resolution fails", async () => {
    const privateAgentId = "private-agent/customer/path";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const resolve = createConfiguredAgentSkillsResolver(() => {
      const failure = new Error("runtime unavailable");
      failure.name = privateAgentId;
      throw failure;
    });

    await resolve(privateAgentId);

    const receipt = warn.mock.calls.find(
      ([message]) =>
        message === "failed to resolve live configured skill working set",
    );
    expect(receipt).toEqual([
      "failed to resolve live configured skill working set",
      {
        errorType: "Error",
        configuredSkillCount: 0,
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain(privateAgentId);
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
