import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../api.js";
import {
  isNativeSkillsSuppressed,
  suppressNativeSkillsOnStartup,
} from "./suppress-native.js";

describe("isNativeSkillsSuppressed", () => {
  it("returns false for undefined or empty config", () => {
    expect(isNativeSkillsSuppressed(undefined)).toBe(false);
    expect(isNativeSkillsSuppressed({} as OpenClawConfig)).toBe(false);
  });

  it("returns false when agents.defaults.skills is unset or non-empty", () => {
    expect(
      isNativeSkillsSuppressed({
        agents: { defaults: {} },
      } as OpenClawConfig),
    ).toBe(false);

    expect(
      isNativeSkillsSuppressed({
        agents: { defaults: { skills: ["alpha"] } },
      } as OpenClawConfig),
    ).toBe(false);
  });

  it("returns false when any agent entry contains non-empty skills", () => {
    expect(
      isNativeSkillsSuppressed({
        agents: {
          defaults: { skills: [] },
          entries: {
            worker: { skills: ["alpha"] },
          },
        },
      } as OpenClawConfig),
    ).toBe(false);
  });

  it("returns true when agents.defaults.skills is [] and entries have no or empty skills", () => {
    expect(
      isNativeSkillsSuppressed({
        agents: {
          defaults: { skills: [] },
        },
      } as OpenClawConfig),
    ).toBe(true);

    expect(
      isNativeSkillsSuppressed({
        agents: {
          defaults: { skills: [] },
          entries: {
            worker: { workspace: "/tmp/workspace" },
          },
        },
      } as OpenClawConfig),
    ).toBe(true);

    expect(
      isNativeSkillsSuppressed({
        agents: {
          defaults: { skills: [] },
          entries: {
            worker: { skills: [] },
          },
        },
      } as OpenClawConfig),
    ).toBe(true);
  });
});

describe("suppressNativeSkillsOnStartup", () => {
  it("does not invoke mutation if already suppressed", async () => {
    const mutateConfigFile = vi.fn();
    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: {
            defaults: { skills: [] },
          },
        } as OpenClawConfig,
      },
      mutateConfigFile,
    });

    expect(result).toBe(false);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("applies mutation when unsuppressed and cleans draft correctly", async () => {
    let capturedDraft: OpenClawConfig | undefined;
    const mutateConfigFile = vi.fn(async (params) => {
      const draft = {
        agents: {
          defaults: {
            skills: ["legacy-skill"],
            model: "anthropic/claude-3-5",
          },
          entries: {
            main: {
              skills: ["main-skill"],
              workspace: "/tmp/main",
            },
            subagent: {
              workspace: "/tmp/sub",
            },
          },
        },
      } as unknown as OpenClawConfig;
      await params.mutate(draft);
      capturedDraft = draft;
    });

    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: {
            defaults: { skills: ["legacy-skill"] },
          },
        } as OpenClawConfig,
      },
      mutateConfigFile,
    });

    expect(result).toBe(true);
    expect(mutateConfigFile).toHaveBeenCalledWith({
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(capturedDraft?.agents?.defaults?.skills).toEqual([]);
    expect(capturedDraft?.agents?.defaults?.model).toBe("anthropic/claude-3-5");
    expect(
      (capturedDraft?.agents?.entries?.main as { skills?: unknown })?.skills,
    ).toBeUndefined();
    expect(capturedDraft?.agents?.entries?.main?.workspace).toBe("/tmp/main");
    expect(capturedDraft?.agents?.entries?.subagent?.workspace).toBe(
      "/tmp/sub",
    );
  });

  it("handles empty draft safely by initializing agents and defaults", async () => {
    let capturedDraft: OpenClawConfig | undefined;
    const mutateConfigFile = vi.fn(async (params) => {
      const draft = {} as OpenClawConfig;
      await params.mutate(draft);
      capturedDraft = draft;
    });

    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {} as OpenClawConfig,
      },
      mutateConfigFile,
    });

    expect(result).toBe(true);
    expect(capturedDraft?.agents?.defaults?.skills).toEqual([]);
  });

  it("fails open and returns false without throwing when mutation fails", async () => {
    const mutateConfigFile = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: permission denied"));

    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: ["legacy"] } },
        } as OpenClawConfig,
      },
      mutateConfigFile,
    });

    expect(result).toBe(false);
  });

  it("prefers api.runtime.config.mutateConfigFile when options.mutateConfigFile is omitted", async () => {
    const mutateConfigFile = vi.fn().mockResolvedValue(undefined);
    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: ["legacy"] } },
        } as OpenClawConfig,
        runtime: {
          config: {
            mutateConfigFile,
          },
        },
      },
    });

    expect(result).toBe(true);
    expect(mutateConfigFile).toHaveBeenCalled();
  });
});
