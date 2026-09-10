import {
  definePluginEntry,
  logger,
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
import { IntentCatalog } from "./intents/index.js";
import { SessionTracker } from "./session/index.js";
import { StatsAggregator } from "./stats/index.js";
import { IntentReviewLogWriter } from "./review/log-writer.js";
import { createHookHandlers, type HookDeps } from "./hooks/index.js";
import { listAvailableSkills, registerSkillTools } from "./skills/index.js";
import { resolveSkillRoots } from "./skills/roots.js";
import { suppressNativeSkillsOnStartup } from "./skills/suppress-native.js";
import { SkillExperienceCatalog } from "./experiences/index.js";
import { createIntentQmdIndex } from "./qmd/intent-index.js";
import { createSkillQmdIndex } from "./qmd/skill-index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedSkillHarnessPluginConfig } from "./types.js";
import {
  intentsPath,
  experiencesPath,
  packageRoot as defaultPackageRoot,
  resolvePluginDataRoot,
  resolveStateDirFromApi,
  sessionsDirPath,
} from "./file-utils.js";

const PLUGIN_ID = "skill-harness";
const EXAMPLE_INTENT_ASSETS_DIR = path.join(
  "skills",
  "skill-harness",
  "assets",
);

function copyFileIfMissing(sourcePath: string, targetPath: string): void {
  if (fs.existsSync(targetPath)) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function hasMarkdownFiles(dir: string): boolean {
  return (
    fs.existsSync(dir) &&
    fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".md"))
  );
}

function seedExampleIntents(dataRoot: string, packageRoot: string): void {
  const sourceDir = path.join(packageRoot, EXAMPLE_INTENT_ASSETS_DIR);
  const targetDir = intentsPath(dataRoot);
  if (!fs.existsSync(sourceDir)) return;
  if (hasMarkdownFiles(targetDir)) return;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    copyFileIfMissing(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
    );
  }
}

export function initializePluginDataRoot({
  dataRoot,
  packageRoot = defaultPackageRoot,
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
    return;
  }

  try {
    seedExampleIntents(dataRoot, packageRoot);
  } catch (err) {
    logger.warn("failed to seed skill-harness example intents", {
      error: err,
      path: intentsPath(dataRoot),
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
        liveConfig.workingSetSkills.agents[normalized] ??
        liveConfig.workingSetSkills.defaults
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
      "Pre-scans user intent before replies and injects routing context via before_prompt_build hook.",
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
      const catalog = IntentCatalog.create(dataRoot);
      const experienceCatalog = new SkillExperienceCatalog(dataRoot);
      const qmdIntentIndex = createIntentQmdIndex({
        dataRoot,
        config: () => {
          refreshLiveConfigFromRuntime();
          return config.qmd;
        },
      });
      const qmdSkillIndex = createSkillQmdIndex({
        dataRoot,
        config: () => {
          refreshLiveConfigFromRuntime();
          return { qmd: config.qmd, skills: config.skills };
        },
      });
      const tracker = SessionTracker.create(dataRoot);
      const statsAggregator = StatsAggregator.create(dataRoot);
      const reviewLogWriter = new IntentReviewLogWriter(dataRoot);

      const refreshRuntimeIntents = (options?: { rebuildQmd?: boolean }) => {
        catalog.load("intents");
        if (options?.rebuildQmd) qmdIntentIndex.schedule(catalog.get());
      };

      const knownAgentIds = new Set<string>(["main"]);
      const collectKnownAgentIds = () => {
        for (const id of extractConfiguredAgentIds(api.config)) {
          knownAgentIds.add(id);
        }
        const currentRuntimeConfig = getRuntimeConfig();
        if (currentRuntimeConfig) {
          for (const id of extractConfiguredAgentIds(currentRuntimeConfig)) {
            knownAgentIds.add(id);
          }
        }
        for (const agentId of Object.keys(config.workingSetSkills.agents)) {
          knownAgentIds.add(agentId);
        }
        return knownAgentIds;
      };

      const scheduleSkillSearchIndex = (agentId: string) => {
        const normalizedAgentId = canonicalIdentity(agentId);
        if (!normalizedAgentId || normalizedAgentId === "defaults") return;
        knownAgentIds.add(normalizedAgentId);
        void listAvailableSkills({
          api,
          agentId: normalizedAgentId,
          intents: catalog.get(),
        })
          .then((skills) => {
            qmdSkillIndex.schedule(normalizedAgentId, {
              skills,
              sourceRoots: resolveSkillRoots({
                api,
                agentId: normalizedAgentId,
                bundledSkillsDir,
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
        refreshLiveConfigFromRuntime();
        refreshRuntimeIntents();
        qmdIntentIndex.schedule(catalog.get());
        for (const agentId of collectKnownAgentIds()) {
          scheduleSkillSearchIndex(agentId);
        }
      };

      const scheduleQmdIndexRefresh = () => {
        const intervalSeconds = config.qmd.indexRefreshIntervalSeconds;
        if (intervalSeconds <= 0) return;
        const timer = setTimeout(() => {
          refreshQmdIndexes();
          scheduleQmdIndexRefresh();
        }, intervalSeconds * 1_000);
        timer.unref();
      };

      const deps: HookDeps = {
        api: runtimeConfigApi,
        config: () => config,
        refreshLiveConfigFromRuntime,
        refreshIntents: refreshRuntimeIntents,
        catalog,
        tracker,
        statsAggregator,
        reviewLogWriter,
        getWorkingSetSkills,
        qmdIntentIndex,
        qmdSkillIndex,

        bundledSkillsDir,
        dataRoot,
      };

      const handlers = createHookHandlers(deps);

      refreshLiveConfigFromRuntime();
      refreshQmdIndexes();
      scheduleQmdIndexRefresh();

      api.on("before_prompt_build", handlers.onBeforePromptBuild, {
        timeoutMs: config.routing.classifier.timeoutMs * 2 + 1_500,
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
        getIntents: () => catalog.get(),
        experienceCatalog,
        qmdSkillIndex,
        scheduleSkillSearchIndex,
        bundledSkillsDir: deps.bundledSkillsDir,
      });

      if (
        canAccessRuntime &&
        config.workingSetSkills.suppressNativeSkillPrompt
      ) {
        void suppressNativeSkillsOnStartup({ api });
      }
    },
  });
}
