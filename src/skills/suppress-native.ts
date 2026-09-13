import {
  logger,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "../../api.js";

export type ConfigMutateFn = (params: {
  mutate: (draft: OpenClawConfig) => void | Promise<void>;
  afterWrite: { mode: "auto" } | "none" | "reload" | "restart";
}) => Promise<unknown>;

export interface OpenClawRuntimeWithConfig {
  config?: {
    mutateConfigFile?: ConfigMutateFn;
  };
}

export interface SuppressNativeSkillsOptions {
  api: Pick<OpenClawPluginApi, "config"> & {
    runtime?: unknown;
  };
  suppressNativeSkillPrompt?: boolean;
  suppressNativeExtraDirs?: boolean;
  mutateConfigFile?: ConfigMutateFn;
}

/**
 * Checks whether OpenClaw's automatic prompt skill lists are suppressed:
 * agents.defaults.skills is [] and agent entries carry no non-empty list.
 */
export function isNativeSkillsSuppressed(
  config: OpenClawConfig | undefined,
): boolean {
  if (!config) return false;

  const defaultsSkills = config.agents?.defaults?.skills;
  if (!Array.isArray(defaultsSkills) || defaultsSkills.length !== 0) {
    return false;
  }

  for (const entry of Object.values(config.agents?.entries ?? {})) {
    if (!entry || typeof entry !== "object" || !("skills" in entry)) {
      continue;
    }
    const listedSkills = entry.skills;
    if (!Array.isArray(listedSkills) || listedSkills.length !== 0) return false;
  }
  return true;
}

export function isNativeExtraDirsSuppressed(
  config: OpenClawConfig | undefined,
): boolean {
  const extraDirs = config?.skills?.load?.extraDirs;
  return Array.isArray(extraDirs) && extraDirs.length === 0;
}

function needsNormalization(
  config: OpenClawConfig | undefined,
  options: Required<
    Pick<
      SuppressNativeSkillsOptions,
      "suppressNativeSkillPrompt" | "suppressNativeExtraDirs"
    >
  >,
): boolean {
  return (
    (options.suppressNativeSkillPrompt && !isNativeSkillsSuppressed(config)) ||
    (options.suppressNativeExtraDirs && !isNativeExtraDirsSuppressed(config))
  );
}

/**
 * Idempotently normalizes the OpenClaw-native skill configuration that Skill
 * Harness replaces: automatic prompt skill lists and/or extra discovery roots.
 */
export async function suppressNativeSkillsOnStartup(
  options: SuppressNativeSkillsOptions,
): Promise<boolean> {
  const suppressNativeSkillPrompt = options.suppressNativeSkillPrompt ?? true;
  const suppressNativeExtraDirs = options.suppressNativeExtraDirs ?? false;
  if (
    !needsNormalization(options.api.config, {
      suppressNativeSkillPrompt,
      suppressNativeExtraDirs,
    })
  ) {
    return false;
  }

  let mutateFn = options.mutateConfigFile;
  if (!mutateFn) {
    try {
      if (options.api.runtime && typeof options.api.runtime === "object") {
        const runtimeObj = options.api.runtime as OpenClawRuntimeWithConfig;
        mutateFn = runtimeObj.config?.mutateConfigFile;
      }
    } catch {
      // Runtime may be guarded or throw during inspection.
    }
  }
  if (!mutateFn) return false;

  try {
    await mutateFn({
      afterWrite: { mode: "auto" },
      mutate: (draft: OpenClawConfig) => {
        if (suppressNativeSkillPrompt) {
          const agents = (draft.agents ??= {});
          const defaults = (agents.defaults ??= {});
          defaults.skills = [];

          for (const entry of Object.values(agents.entries ?? {})) {
            if (entry && typeof entry === "object") {
              delete (entry as Record<string, unknown>).skills;
            }
          }
        }

        if (suppressNativeExtraDirs) {
          const skills = (draft.skills ??= {});
          const load = (skills.load ??= {});
          load.extraDirs = [];
        }
      },
    });
    logger.info("successfully normalized native OpenClaw skills configuration");
    return true;
  } catch (error) {
    logger.warn("failed to normalize native OpenClaw skills configuration", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
