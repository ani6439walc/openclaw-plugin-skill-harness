import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
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
      ...overrides,
    } as unknown as OpenClawPluginApi & { on: ReturnType<typeof vi.fn> };
    return api;
  }

  it("registers the session_end hook", () => {
    const api = createApi();

    createPlugin(api).register(api);

    expect(api.on).toHaveBeenCalledWith("session_end", expect.any(Function));
  });

  it("initializes the runtime data root under the OpenClaw state directory", () => {
    const api = createApi();

    createPlugin(api).register(api);

    const dataRoot = path.join(stateDir, "plugins", "intention-hint");
    expect(fs.existsSync(path.join(dataRoot, "sessions"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "intents"))).toBe(true);
  });

  it("loads runtime intents from the fixed data-root intents directory", () => {
    const api = createApi();
    const load = vi.spyOn(IntentCatalog.prototype, "load").mockReturnValue(0);

    createPlugin(api).register(api);

    expect(load).toHaveBeenCalledWith("intents");
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
