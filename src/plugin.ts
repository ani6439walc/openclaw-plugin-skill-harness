import {
  definePluginEntry,
  logger,
  setApiLogger,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "../api.js";
import {
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveConfig } from "./config.js";
import { canonicalIdentity } from "./normalize.js";
import { SessionTracker } from "./session/index.js";
import { StatsAggregator } from "./stats/index.js";
import { IntentReviewLogWriter } from "./review/log-writer.js";
import { createIntentReviewScheduler } from "./review/scheduler.js";
import { createHookHandlers, type HookDeps } from "./hooks/index.js";
import { listAvailableSkills, registerSkillTools } from "./skills/index.js";
import {
  resolveOpenClawBundledSkillsDir,
  resolveSkillRoots,
} from "./skills/roots.js";
import { suppressNativeSkillsOnStartup } from "./skills/suppress-native.js";
import { SkillExperienceCatalog } from "./experiences/index.js";
import { createSkillQmdIndex } from "./qmd/skill-index.js";
import { activeAgentIdsFromConfig } from "./qmd/active-agents.js";
import { createSkillExperienceQmdIndex } from "./qmd/experience-index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedSkillHarnessPluginConfig } from "./types.js";
import {
  experiencesPath,
  packageRoot as defaultPackageRoot,
  resolvePluginDataRoot,
  resolveStateDirFromApi,
  sessionsDirPath,
} from "./file-utils.js";

import { MAX_PROMPT_HOOK_TIMEOUT_MS } from "./hooks/prompt-budget.js";

const PLUGIN_ID = "skill-harness";

export function initializePluginDataRoot({
  dataRoot,
}: {
  dataRoot: string;
  packageRoot?: string;
}): void {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(sessionsDirPath(dataRoot), { recursive: true });
    fs.mkdirSync(experiencesPath(dataRoot), { recursive: true });
  } catch (err) {
    logger.warn("failed to create skill-harness data root", {
      error: err,
      path: dataRoot,
    });
  }
}

export function extractConfiguredAgentIds(config?: OpenClawConfig): string[] {
  const ids: string[] = [];
  for (const agentId of Object.keys(config?.agents?.entries ?? {})) {
    const normalizedAgentId = canonicalIdentity(agentId);
    if (normalizedAgentId) {
      ids.push(normalizedAgentId);
    }
  }
  return ids;
}

export function createWorkingSetSkillsResolver(
  refreshLiveConfig: () => ResolvedSkillHarnessPluginConfig,
): (agentId: string) => Promise<string[]> {
  return async (agentId: string): Promise<string[]> => {
    try {
      const liveConfig = refreshLiveConfig();
      const normalized = canonicalIdentity(agentId);
      return (
        liveConfig.skills.workingSet.agents[normalized] ??
        liveConfig.skills.workingSet.defaults
      );
    } catch (error) {
      logger.warn("failed to resolve live working-set skills", {
        errorType: error instanceof Error ? "Error" : typeof error,
        workingSetSkillCount: 0,
      });
      return [];
    }
  };
}

export function createPlugin(
  api: OpenClawPluginApi,
): OpenClawPluginDefinition & {
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} {
  if (api.logger) {
    setApiLogger(api.logger);
  }
  const canAccessRuntime = api.registrationMode !== "cli-metadata";
  const getRuntimeConfig = (): OpenClawConfig | undefined => {
    if (!canAccessRuntime) return undefined;
    return api.runtime?.config?.current?.() as OpenClawConfig | undefined;
  };
  const getOpenClawConfig = (): OpenClawConfig | undefined =>
    getRuntimeConfig() ?? api.config;
  const runtimeConfigApi = new Proxy(api, {
    get(target, property, receiver) {
      if (property === "config") return getOpenClawConfig() ?? target.config;
      return Reflect.get(target, property, receiver);
    },
  });
  const registrationPluginConfig = {
    ...resolvePluginConfigObject(api.config, PLUGIN_ID),
    ...api.pluginConfig,
  };

  let config = resolveConfig(registrationPluginConfig, {
    openClawConfig: getOpenClawConfig(),
  });

  const refreshLiveConfigFromRuntime = (): ResolvedSkillHarnessPluginConfig => {
    const livePluginConfig = resolveLivePluginConfigObject(
      canAccessRuntime ? getRuntimeConfig : undefined,
      PLUGIN_ID,
      api.pluginConfig as Record<string, unknown>,
    );
    const sdkPluginConfig = {
      ...registrationPluginConfig,
      ...livePluginConfig,
    };
    config = resolveConfig(sdkPluginConfig, {
      openClawConfig: getOpenClawConfig(),
    });
    return config;
  };

  return definePluginEntry({
    id: PLUGIN_ID,
    name: "Skill Harness",
    description:
      "Discovers relevant skills and experiences before replies and injects routing context via before_prompt_build hook.",
    register() {
      const getWorkingSetSkills = createWorkingSetSkillsResolver(
        refreshLiveConfigFromRuntime,
      );

      const stateDir = resolveStateDirFromApi(
        canAccessRuntime ? api : undefined,
        process.env,
      );
      const dataRoot = resolvePluginDataRoot(stateDir, PLUGIN_ID);
      initializePluginDataRoot({ dataRoot });

      const bundledSkillsDir = path.join(defaultPackageRoot, "skills");
      // Captured generations have different asset paths but share one index identity.
      const bundledSkillsIdentityDir = path.join(
        api.rootDir ?? defaultPackageRoot,
        "skills",
      );
      const ownsBackgroundWork =
        api.registrationMode === undefined || api.registrationMode === "full";
      let disposed = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      const nativeBundledSkillsDir = resolveOpenClawBundledSkillsDir();
      const experienceCatalog = new SkillExperienceCatalog(dataRoot);
      const activeAgentIds = (): string[] | undefined => {
        try {
          return activeAgentIdsFromConfig(
            getRuntimeConfig(),
            Object.keys(config.skills.workingSet.agents),
          );
        } catch {
          return undefined;
        }
      };
      const qmdSkillIndex = createSkillQmdIndex({
        dataRoot,
        readOnly: !ownsBackgroundWork,
        activeAgentIds,
        config: () => {
          refreshLiveConfigFromRuntime();
          return { qmd: config.qmd, skills: config.skills };
        },
      });
      const qmdExperienceIndex = createSkillExperienceQmdIndex({
        dataRoot,
        readOnly: !ownsBackgroundWork,
        getEntries: () => experienceCatalog.listAll(),
        config: () => {
          refreshLiveConfigFromRuntime();
          return config.qmd;
        },
      });
      if (!ownsBackgroundWork) {
        qmdExperienceIndex.schedule(experienceCatalog.listAll());
      }
      const tracker = SessionTracker.create(dataRoot);
      const statsAggregator = StatsAggregator.create(dataRoot);
      const reviewLogWriter = new IntentReviewLogWriter(dataRoot);

      const knownAgentIds = new Set<string>(["main"]);
      const collectKnownAgentIds = () => {
        const currentAgentIds = activeAgentIds();
        if (currentAgentIds) return currentAgentIds;
        for (const id of extractConfiguredAgentIds(api.config)) {
          knownAgentIds.add(id);
        }
        for (const agentId of Object.keys(config.skills.workingSet.agents)) {
          knownAgentIds.add(agentId);
        }
        return knownAgentIds;
      };

      const scheduleSkillSearchIndex = (agentId: string, automatic = false) => {
        if (disposed || !ownsBackgroundWork) return;
        const normalizedAgentId = canonicalIdentity(agentId);
        if (!normalizedAgentId || normalizedAgentId === "defaults") return;
        knownAgentIds.add(normalizedAgentId);
        void nativeBundledSkillsDir
          .then(async (resolvedNativeBundledSkillsDir) => {
            if (disposed) return;
            if (
              automatic &&
              activeAgentIds()?.includes(normalizedAgentId) === false
            )
              return;
            const skills = await listAvailableSkills({
              api: runtimeConfigApi,
              agentId: normalizedAgentId,
              nativeBundledSkillsDir: resolvedNativeBundledSkillsDir,
              sharedRoots: config.skills.sharedRoots,
            });
            if (disposed) return;
            if (
              automatic &&
              activeAgentIds()?.includes(normalizedAgentId) === false
            )
              return;
            qmdSkillIndex.schedule(normalizedAgentId, {
              skills,
              sourceRoots: resolveSkillRoots({
                api: runtimeConfigApi,
                agentId: normalizedAgentId,
                bundledSkillsDir: bundledSkillsIdentityDir,
                nativeBundledSkillsDir: resolvedNativeBundledSkillsDir,
                sharedRoots: config.skills.sharedRoots,
              }).map((root) => root.path),
            });
          })
          .catch((error: unknown) => {
            logger.warn("failed to schedule QMD skill search index", {
              errorType: error instanceof Error ? "Error" : typeof error,
              scheduled: false,
            });
          });
      };

      const refreshQmdIndexes = () => {
        if (disposed || !ownsBackgroundWork) return;
        refreshLiveConfigFromRuntime();
        qmdExperienceIndex.schedule(experienceCatalog.listAll());
        for (const agentId of collectKnownAgentIds()) {
          scheduleSkillSearchIndex(agentId, true);
        }
        void qmdSkillIndex.maintenance?.().catch((error: unknown) => {
          logger.warn("failed to maintain QMD skill indexes", {
            errorType: error instanceof Error ? "Error" : typeof error,
          });
        });
      };

      const scheduleQmdIndexRefresh = () => {
        if (disposed || !ownsBackgroundWork) return;
        const intervalSeconds = config.qmd.indexRefreshIntervalSeconds;
        if (intervalSeconds <= 0) return;
        refreshTimer = setTimeout(() => {
          refreshQmdIndexes();
          scheduleQmdIndexRefresh();
        }, intervalSeconds * 1_000);
        refreshTimer.unref();
      };

      const reviewScheduler = createIntentReviewScheduler();

      api.lifecycle?.onDispose?.(async () => {
        disposed = true;
        if (refreshTimer !== undefined) clearTimeout(refreshTimer);
        await Promise.all([
          reviewScheduler.dispose(),
          qmdSkillIndex.close(),
          qmdExperienceIndex.close(),
        ]);
      });

      const deps: HookDeps = {
        api: runtimeConfigApi,
        config: () => config,
        refreshLiveConfigFromRuntime,
        tracker,
        statsAggregator,
        reviewLogWriter,
        reviewScheduler,
        getWorkingSetSkills,
        qmdSkillIndex,
        qmdExperienceIndex,

        bundledSkillsDir,
        nativeBundledSkillsDir,
        getSharedRoots: () => config.skills.sharedRoots,
        dataRoot,
      };

      const handlers = createHookHandlers(deps);

      refreshLiveConfigFromRuntime();
      refreshQmdIndexes();
      scheduleQmdIndexRefresh();

      api.on("before_prompt_build", handlers.onBeforePromptBuild, {
        timeoutMs: MAX_PROMPT_HOOK_TIMEOUT_MS,
        priority: -1,
      });
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("tool_result_persist", handlers.onToolResultPersist);
      api.on("before_agent_finalize", handlers.onBeforeAgentFinalize);
      api.on("message_sending", handlers.onMessageSending);
      api.on("agent_end", handlers.onAgentEnd);
      api.on("session_end", handlers.onSessionEnd);
      registerSkillTools(api, {
        experienceCatalog,
        qmdExperienceIndex,
        qmdSkillIndex,
        scheduleSkillSearchIndex,
        bundledSkillsDir: deps.bundledSkillsDir,
        nativeBundledSkillsDir: deps.nativeBundledSkillsDir,
        getSharedRoots: () => config.skills.sharedRoots,
      });

      if (
        ownsBackgroundWork &&
        (config.skills.suppressNativeSkillPrompt ||
          config.skills.suppressNativeExtraDirs)
      ) {
        void suppressNativeSkillsOnStartup({
          api,
          suppressNativeSkillPrompt: config.skills.suppressNativeSkillPrompt,
          suppressNativeExtraDirs: config.skills.suppressNativeExtraDirs,
        });
      }
    },
  });
}
