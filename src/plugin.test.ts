import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, type OpenClawPluginApi } from "../api.js";
import { createPlugin, initializePluginDataRoot } from "./plugin.js";
import { IntentCatalog } from "./intents/index.js";

describe("createPlugin", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-state-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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

  it("registers skill tools without legacy review command surfaces", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "skill_list",
      "skill_view",
      "skill_manage",
    ]);
    expect(api.registerCommand).not.toHaveBeenCalled();
  });

  it("budgets before_prompt_build timeout for three scanner subagent rounds", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      { timeoutMs: 10_500 },
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
      '{"schemaVersion":4,"createdAt":"2026-07-01T00:00:00.000Z","updatedAt":"2026-07-01T00:00:00.000Z","processedEvents":{},"triggerKeywords":{}}',
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

  it("migrates legacy review logs into review.json without deleting the source", () => {
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    const legacyLog =
      '{"schemaVersion":4,"createdAt":"2026-07-01T00:00:00.000Z","updatedAt":"2026-07-01T00:00:00.000Z","processedEvents":{},"triggerKeywords":{"successfulPattern":["done"]}}';
    fs.writeFileSync(path.join(dataRoot, "evolution.json"), legacyLog);

    initializePluginDataRoot({ dataRoot });

    expect(fs.existsSync(path.join(dataRoot, "evolution.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(dataRoot, "review.json"), "utf-8")),
    ).toMatchObject({
      schemaVersion: 4,
      triggerKeywords: { successfulPattern: ["done"] },
    });
  });

  it("does not overwrite an existing review.json during legacy review log migration", () => {
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    const currentLog =
      '{"schemaVersion":4,"createdAt":"2026-07-02T00:00:00.000Z","updatedAt":"2026-07-02T00:00:00.000Z","processedEvents":{},"triggerKeywords":{"successfulPattern":["current"]}}';
    fs.writeFileSync(path.join(dataRoot, "review.json"), currentLog);
    fs.writeFileSync(
      path.join(dataRoot, "evolution.json"),
      '{"schemaVersion":4,"createdAt":"2026-07-01T00:00:00.000Z","updatedAt":"2026-07-01T00:00:00.000Z","processedEvents":{},"triggerKeywords":{"successfulPattern":["legacy"]}}',
    );

    initializePluginDataRoot({ dataRoot });

    expect(fs.readFileSync(path.join(dataRoot, "review.json"), "utf-8")).toBe(
      currentLog,
    );
  });

  it("loads runtime intents from the fixed data-root intents directory", () => {
    const api = createApi();
    const load = vi.spyOn(IntentCatalog.prototype, "load").mockReturnValue(0);

    createPlugin(api).register(api);

    expect(load).toHaveBeenCalledWith("intents");
  });

  it("registers hooks when review trigger keyword cache is corrupt", () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "review.json"), "{ broken");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(() => createPlugin(api).register(api)).not.toThrow();

    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(warn).toHaveBeenCalledWith(
      "failed to read review trigger keywords",
      expect.objectContaining({ path: path.join(dataRoot, "review.json") }),
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
});
