import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  evolutionBacklogPath,
  intentsPath,
  resolvePluginDataRoot,
  sessionsDirPath,
  sessionsPath,
  statsPath,
} from "./file-utils.js";

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
    expect(sessionsDirPath(dataRoot)).toBe(path.join(dataRoot, "sessions"));
    expect(sessionsPath("session-1.json", dataRoot)).toBe(
      path.join(dataRoot, "sessions", "session-1.json"),
    );
    expect(statsPath(dataRoot)).toBe(path.join(dataRoot, "stats.json"));
    expect(evolutionBacklogPath(dataRoot)).toBe(
      path.join(dataRoot, "evolution.json"),
    );
  });
});
