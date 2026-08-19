import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileLock,
  reviewLogPath,
  intentsPath,
  experiencesPath,
  resolvePluginDataRoot,
  resolveStateDirFromApi,
  sessionsDirPath,
  sessionsPath,
  statsPath,
  agentWorkspacePath,
  agentSessionsPath,
  keywordCoverageLogPath,
  packageRoot,
  pluginRoot,
} from "./file-utils.js";

describe("FileLock", () => {
  it("supports zero-wait acquisition without entering the default retry loop", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    const targetPath = path.join(tempDir, "session.json");
    const holder = new FileLock(targetPath);
    expect(await holder.acquire()).toBe(true);

    const contender = new FileLock(targetPath);
    const startedAt = performance.now();
    expect(await contender.acquire({ maxWaitMs: 0 })).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(100);

    holder.release();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("never steals a lock solely because its directory mtime is old", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    const targetPath = path.join(tempDir, "session.json");
    const holder = new FileLock(targetPath);
    expect(await holder.acquire()).toBe(true);
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(`${targetPath}.lock`, staleAt, staleAt);

    try {
      const contender = new FileLock(targetPath);
      expect(await contender.acquire({ maxWaitMs: 20 })).toBe(false);
      expect(fs.existsSync(`${targetPath}.lock`)).toBe(true);
    } finally {
      holder.release();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("plugin data paths", () => {
  it("resolves the plugin data root under the OpenClaw state directory", () => {
    const stateDir = path.join("tmp", "openclaw-state");

    expect(resolvePluginDataRoot(stateDir, "skill-harness")).toBe(
      path.join(stateDir, "plugins", "skill-harness"),
    );
  });

  it("resolves runtime data files from the plugin data root", () => {
    const dataRoot = path.join("tmp", "openclaw-state", "plugins", "hint");

    expect(intentsPath(dataRoot)).toBe(path.join(dataRoot, "intents"));
    expect(experiencesPath(dataRoot)).toBe(path.join(dataRoot, "experiences"));
    expect(sessionsDirPath(dataRoot)).toBe(path.join(dataRoot, "sessions"));
    expect(sessionsPath("session-1.json", dataRoot)).toBe(
      path.join(dataRoot, "sessions", "session-1.json"),
    );
    expect(statsPath(dataRoot)).toBe(path.join(dataRoot, "stats.json"));
    expect(reviewLogPath(dataRoot)).toBe(path.join(dataRoot, "review.json"));
    expect(keywordCoverageLogPath(dataRoot)).toBe(
      path.join(dataRoot, "keyword-coverage.json"),
    );
    expect(agentWorkspacePath(dataRoot)).toBe(path.join(dataRoot, "workspace"));
    expect(agentSessionsPath(dataRoot, "intention")).toBe(
      path.join(dataRoot, "agents", "intention", "sessions"),
    );
    expect(agentSessionsPath(dataRoot, "review")).toBe(
      path.join(dataRoot, "agents", "review", "sessions"),
    );
  });

  it("preserves package-root aliases and the legacy sessions-path default", () => {
    expect(pluginRoot).toBe(packageRoot);
    expect(sessionsPath("legacy-session.json")).toBe(
      path.join(packageRoot, "sessions", "legacy-session.json"),
    );
  });

  it("safely resolves stateDir from api.runtime.state when available", () => {
    const api = {
      runtime: {
        state: {
          resolveStateDir: () => "/custom/state/dir",
        },
      },
    } as any;
    expect(resolveStateDirFromApi(api)).toBe("/custom/state/dir");
  });

  it("falls back gracefully when api.runtime or api.runtime.state is undefined", () => {
    const emptyApi = {} as any;
    const env = { OPENCLAW_STATE_DIR: "/fallback/state/dir" };
    expect(resolveStateDirFromApi(emptyApi, env)).toBe("/fallback/state/dir");
    expect(resolveStateDirFromApi(undefined, env)).toBe("/fallback/state/dir");
  });
});
