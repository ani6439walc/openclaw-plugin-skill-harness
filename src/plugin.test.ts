import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, type OpenClawPluginApi } from "../api.js";
import { createPlugin, initializePluginDataRoot } from "./plugin.js";
import { IntentCatalog } from "./intent-loader.js";

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

  it("registers the optional evolution backlog tool", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
      names: ["intention_hint_evolution"],
      optional: true,
    });
  });

  it("registers the plugin-owned intention-hint command namespace", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "intention-hint",
        acceptsArgs: true,
        handler: expect.any(Function),
      }),
    );
  });

  it("runs evolution backlog actions through the registered tool", async () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "evolution.json"),
      JSON.stringify({
        schemaVersion: 3,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        triggerKeywords: {
          successfulPattern: [],
          behaviorFix: [],
          entityContext: [],
        },
        processedEvents: {},
        items: [
          {
            id: "one",
            type: "behavior-fix",
            targetKind: "intent-markdown",
            operation: "unknown",
            targetIntentIds: [],
            dedupeKey: "one",
            summary: "one",
            correctionGoal: "goal",
            details: { evidence: [], suggestedChange: "change" },
            frequency: 1,
            sources: [],
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
            status: "pending",
          },
        ],
      }),
    );

    createPlugin(api).register(api);
    const [factory] = api.registerTool.mock.calls[0];
    const tool = factory({});

    const listResult = await tool.execute("call", { action: "list" });
    expect(listResult.details).toMatchObject({
      ok: true,
      result: [{ id: "one" }],
    });

    const mutationError = await tool.execute("call", {
      action: "set-target",
      id: "one",
      operation: "refine",
      targetIntentIds: [],
    });
    expect(mutationError.details).toMatchObject({
      ok: false,
      error: expect.stringContaining("at least one target intent ID"),
    });
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

    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    expect(fs.existsSync(path.join(dataRoot, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "intents"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "sessions", "stats.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(dataRoot, "sessions", "evolution.json")),
    ).toBe(false);
  });

  it("keeps runtime stats and evolution files at the data-root level", () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "stats.json"), '{"stats":true}');
    fs.writeFileSync(
      path.join(dataRoot, "evolution.json"),
      '{"schemaVersion":3,"items":[],"triggerKeywords":{}}',
    );

    createPlugin(api).register(api);

    expect(fs.readFileSync(path.join(dataRoot, "stats.json"), "utf-8")).toBe(
      '{"stats":true}',
    );
    expect(fs.existsSync(path.join(dataRoot, "sessions", "stats.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(dataRoot, "sessions", "evolution.json")),
    ).toBe(false);
  });

  it("loads runtime intents from the fixed data-root intents directory", () => {
    const api = createApi();
    const load = vi.spyOn(IntentCatalog.prototype, "load").mockReturnValue(0);

    createPlugin(api).register(api);

    expect(load).toHaveBeenCalledWith("intents");
  });

  it("registers hooks when evolution trigger keyword cache is corrupt", () => {
    const api = createApi();
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "evolution.json"), "{ broken");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(() => createPlugin(api).register(api)).not.toThrow();

    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(warn).toHaveBeenCalledWith(
      "failed to read evolution trigger keywords",
      expect.objectContaining({ path: path.join(dataRoot, "evolution.json") }),
    );
  });

  function createPackageRootWithAssets(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-package-root-"));
    const assetsDir = path.join(root, "skills", "intention-hint", "assets");
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
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
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
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
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
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
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
    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
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
    fs.writeFileSync(path.join(oldSessions, "evolution.json"), '{"old":true}');

    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    try {
      initializePluginDataRoot({ dataRoot, packageRoot });

      expect(
        fs.existsSync(path.join(dataRoot, "sessions", "old-session.json")),
      ).toBe(false);
      expect(fs.existsSync(path.join(dataRoot, "stats.json"))).toBe(false);
      expect(fs.existsSync(path.join(dataRoot, "evolution.json"))).toBe(false);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
