import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { readPluginConfig } from "./plugin-config.js";

describe("readPluginConfig", () => {
  it.each([
    undefined,
    {},
    { plugins: { entries: [] } },
    { plugins: { entries: { "skill-harness": null } } },
    { plugins: { entries: { "skill-harness": { config: [] } } } },
    { plugins: { entries: { "skill-harness": { config: null } } } },
    { plugins: { entries: { "skill-harness": { config: "invalid" } } } },
  ])("ignores absent or malformed plugin configuration: %j", (snapshot) => {
    expect(
      readPluginConfig(snapshot as OpenClawConfig | undefined, "skill-harness"),
    ).toBeUndefined();
  });

  it.each([
    [{ enabled: true }, { routing: { timeoutMs: 1_000 } }],
    [{ config: {} }, {}],
    [{ config: { skills: {} } }, { skills: {} }],
    [{ config: null }, undefined],
    [null, undefined],
  ])("preserves normalized alias precedence: %j", (laterEntry, expected) => {
    const snapshot = {
      plugins: {
        entries: {
          " Skill-Harness ": { config: { routing: { timeoutMs: 1_000 } } },
          "skill-harness": laterEntry,
          unrelated: { config: { skills: { workingSet: {} } } },
        },
      },
    };
    const before = structuredClone(snapshot);

    expect(
      readPluginConfig(snapshot as OpenClawConfig, "skill-harness"),
    ).toEqual(expected);
    expect(snapshot).toEqual(before);
  });
});
