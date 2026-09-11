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
  mutateConfigFile?: ConfigMutateFn;
}

/**
 * Checks if OpenClaw native skills are already completely suppressed:
 * 1. agents.defaults.skills is an empty array ([]).
 * 2. No agent in agents.entries has a defined non-empty skills property.
 */
export function isNativeSkillsSuppressed(
  config: OpenClawConfig | undefined,
): boolean {
  if (!config) return false;

  const defaultsSkills = config.agents?.defaults?.skills;
  const isDefaultsEmpty =
    Array.isArray(defaultsSkills) && defaultsSkills.length === 0;
  if (!isDefaultsEmpty) return false;

  const entries = config.agents?.entries;
  if (entries && typeof entries === "object") {
    for (const entry of Object.values(entries)) {
      if (
        entry &&
        typeof entry === "object" &&
        Object.hasOwn(entry, "skills")
      ) {
        const skills = (entry as { skills?: unknown }).skills;
        if (
          skills !== undefined &&
          !(Array.isArray(skills) && skills.length === 0)
        ) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Idempotently mutates openclaw.json on startup to suppress OpenClaw core's
 * automatic <available_skills> prompt:
 * - Sets agents.defaults.skills to []
 * - Removes skills from all agents.entries.*
 *
 * If already suppressed, exits immediately without modifying disk.
 * If mutation fails (e.g. read-only filesystem), catches the error and logs a
 * warning (fail-open).
 */
export async function suppressNativeSkillsOnStartup(
  options: SuppressNativeSkillsOptions,
): Promise<boolean> {
  if (isNativeSkillsSuppressed(options.api.config)) {
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
      // Runtime may be guarded or throw during inspection
    }
  }
  if (!mutateFn) {
    return false;
  }

  try {
    await mutateFn({
      afterWrite: { mode: "auto" },
      mutate: (draft: OpenClawConfig) => {
        const agents = (draft.agents ??= {});
        const defaults = (agents.defaults ??= {});
        defaults.skills = [];

        if (agents.entries && typeof agents.entries === "object") {
          for (const entry of Object.values(agents.entries)) {
            if (entry && typeof entry === "object") {
              delete (entry as Record<string, unknown>).skills;
            }
          }
        }
      },
    });
    logger.info(
      "successfully suppressed native OpenClaw skills configuration in openclaw.json",
    );
    return true;
  } catch (error) {
    logger.warn(
      "failed to suppress native skills configuration in openclaw.json",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return false;
  }
}
