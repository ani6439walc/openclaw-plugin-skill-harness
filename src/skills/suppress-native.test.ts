import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../api.js";
import {
  isNativeExtraDirsSuppressed,
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
          entries: { worker: { skills: ["alpha"] } },
        },
      } as OpenClawConfig),
    ).toBe(false);
  });

  it("accepts empty inherited and agent skill lists", () => {
    expect(
      isNativeSkillsSuppressed({
        agents: {
          defaults: { skills: [] },
          entries: {
            worker: { workspace: "/tmp/workspace" },
            helper: { skills: [] },
          },
        },
      } as OpenClawConfig),
    ).toBe(true);
  });
});

describe("isNativeExtraDirsSuppressed", () => {
  it("requires an explicit empty extraDirs list", () => {
    expect(isNativeExtraDirsSuppressed(undefined)).toBe(false);
    expect(
      isNativeExtraDirsSuppressed({
        skills: { load: { extraDirs: ["/srv/skills"] } },
      } as OpenClawConfig),
    ).toBe(false);
    expect(
      isNativeExtraDirsSuppressed({
        skills: { load: { extraDirs: [] } },
      } as OpenClawConfig),
    ).toBe(true);
  });
});

describe("suppressNativeSkillsOnStartup", () => {
  it("does not invoke mutation when requested normalization is already complete", async () => {
    const mutateConfigFile = vi.fn();
    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: [] } },
          skills: { load: { extraDirs: [] } },
        } as OpenClawConfig,
      },
      suppressNativeSkillPrompt: true,
      suppressNativeExtraDirs: true,
      mutateConfigFile,
    });

    expect(result).toBe(false);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("preserves the legacy default of suppressing prompt skills", async () => {
    let capturedDraft: OpenClawConfig | undefined;
    const mutateConfigFile = vi.fn(async (params) => {
      const draft = {
        agents: { defaults: { skills: ["legacy"] } },
      } as unknown as OpenClawConfig;
      await params.mutate(draft);
      capturedDraft = draft;
    });

    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: ["legacy"] } },
        } as OpenClawConfig,
      },
      mutateConfigFile,
    });

    expect(result).toBe(true);
    expect(capturedDraft?.agents?.defaults?.skills).toEqual([]);
  });

  it("normalizes prompt lists and extra directories atomically", async () => {
    let capturedDraft: OpenClawConfig | undefined;
    const mutateConfigFile = vi.fn(async (params) => {
      const draft = {
        agents: {
          defaults: { skills: ["legacy-skill"], model: "anthropic/claude-3-5" },
          entries: {
            main: { skills: ["main-skill"], workspace: "/tmp/main" },
            subagent: { workspace: "/tmp/sub" },
          },
        },
        skills: {
          load: {
            extraDirs: ["/legacy/skills"],
            watch: true,
            watchDebounceMs: 1_000,
          },
        },
      } as unknown as OpenClawConfig;
      await params.mutate(draft);
      capturedDraft = draft;
    });

    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: ["legacy-skill"] } },
          skills: { load: { extraDirs: ["/legacy/skills"] } },
        } as OpenClawConfig,
      },
      suppressNativeSkillPrompt: true,
      suppressNativeExtraDirs: true,
      mutateConfigFile,
    });

    expect(result).toBe(true);
    expect(mutateConfigFile).toHaveBeenCalledWith({
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(capturedDraft?.agents?.defaults?.skills).toEqual([]);
    expect(capturedDraft?.agents?.defaults?.model).toBe("anthropic/claude-3-5");
    expect(capturedDraft?.agents?.entries?.main).not.toHaveProperty("skills");
    expect(capturedDraft?.agents?.entries?.main?.workspace).toBe("/tmp/main");
    expect(capturedDraft?.skills?.load?.extraDirs).toEqual([]);
    expect(capturedDraft?.skills?.load?.watch).toBe(true);
    expect(capturedDraft?.skills?.load?.watchDebounceMs).toBe(1_000);
  });

  it("normalizes only extra directories without creating agents", async () => {
    let capturedDraft: OpenClawConfig | undefined;
    const mutateConfigFile = vi.fn(async (params) => {
      const draft = {} as OpenClawConfig;
      await params.mutate(draft);
      capturedDraft = draft;
    });

    const result = await suppressNativeSkillsOnStartup({
      api: { config: {} as OpenClawConfig },
      suppressNativeSkillPrompt: false,
      suppressNativeExtraDirs: true,
      mutateConfigFile,
    });

    expect(result).toBe(true);
    expect(capturedDraft?.agents).toBeUndefined();
    expect(capturedDraft?.skills?.load?.extraDirs).toEqual([]);
  });

  it("fails open when mutation fails", async () => {
    const mutateConfigFile = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(
      suppressNativeSkillsOnStartup({
        api: {
          config: {
            skills: { load: { extraDirs: ["/legacy/skills"] } },
          } as OpenClawConfig,
        },
        suppressNativeSkillPrompt: false,
        suppressNativeExtraDirs: true,
        mutateConfigFile,
      }),
    ).resolves.toBe(false);
  });

  it("uses the runtime mutation API when no override is supplied", async () => {
    const mutateConfigFile = vi.fn().mockResolvedValue(undefined);
    const result = await suppressNativeSkillsOnStartup({
      api: {
        config: {
          agents: { defaults: { skills: ["legacy"] } },
        } as OpenClawConfig,
        runtime: { config: { mutateConfigFile } },
      },
    });

    expect(result).toBe(true);
    expect(mutateConfigFile).toHaveBeenCalled();
  });
});
