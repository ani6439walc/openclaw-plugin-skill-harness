import {
  definePluginEntry,
  logger,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "../api.js";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveConfig } from "./config.js";
import { IntentCatalog } from "./intents/index.js";
import { SessionTracker } from "./session/index.js";
import { StatsAggregator } from "./stats/index.js";
import { IntentReviewLogWriter } from "./review/log-writer.js";
import { KeywordCoverageWriter } from "./review/keyword-coverage-writer.js";

import {
  normalizeReviewTriggerKeywords,
  type ReviewTriggerKeywords,
} from "./review/trigger-keywords.js";
import { createHookHandlers, type HookDeps } from "./hooks/index.js";
import { createCurationQueue } from "./curation/index.js";
import { registerSkillTools } from "./skills/index.js";
import { SkillExperienceCatalog } from "./experiences/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  intentsPath,
  experiencesPath,
  keywordCoverageLogPath,
  reviewLogPath,
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

function readKeywordCoverageKeywordsFailOpen(
  writer: KeywordCoverageWriter,
): ReviewTriggerKeywords {
  try {
    return writer.readKeywords() ?? normalizeReviewTriggerKeywords({});
  } catch (err) {
    logger.warn("failed to read keyword coverage keywords", { error: err });
    return normalizeReviewTriggerKeywords({});
  }
}

function recoverCurationSchedulesFailOpen(params: {
  recover: () => Promise<void>;
}): void {
  void params.recover().catch((error) => {
    logger.warn("failed to recover curation schedules", { error });
  });
}

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

export function extractConfiguredAgentSkillsMap(
  config?: OpenClawConfig,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!config?.agents) return map;

  const defaults = Array.isArray(config.agents.defaults?.skills)
    ? config.agents.defaults.skills
    : undefined;

  if (defaults) {
    map.set("defaults", [...defaults]);
  }

  if (Array.isArray(config.agents.list)) {
    for (const agent of config.agents.list) {
      if (!agent?.id) continue;
      if (Array.isArray(agent.skills)) {
        map.set(agent.id.trim().toLowerCase(), [...agent.skills]);
      } else if (defaults) {
        map.set(agent.id.trim().toLowerCase(), [...defaults]);
      }
    }
  }

  return map;
}

function wipeAgentSkillsConfig(config?: OpenClawConfig): void {
  if (!config?.agents) return;
  if (config.agents.defaults) {
    config.agents.defaults.skills = [];
  }
  if (Array.isArray(config.agents.list)) {
    for (const agent of config.agents.list) {
      if (agent) {
        agent.skills = [];
      }
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readRawOpenClawConfig(
  api: OpenClawPluginApi,
): Promise<OpenClawConfig | undefined> {
  let stateDir = "";
  if (api.runtime?.state?.resolveStateDir) {
    stateDir = api.runtime.state.resolveStateDir(process.env) || "";
  }
  if (!stateDir && process.env.HOME) {
    stateDir = path.join(process.env.HOME, ".openclaw");
  }
  if (!stateDir) return undefined;

  const configPath = path.join(stateDir, "openclaw.json");
  try {
    return JSON.parse(
      await fs.promises.readFile(configPath, "utf8"),
    ) as OpenClawConfig;
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    logger.warn("failed to read raw openclaw.json for skills fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export function createConfiguredAgentSkillsResolver(
  api: OpenClawPluginApi,
  configuredSkillsMap: Map<string, string[]>,
): (agentId: string) => Promise<string[]> {
  return async (agentId: string): Promise<string[]> => {
    const rawConfig = await readRawOpenClawConfig(api);
    if (rawConfig) {
      configuredSkillsMap.clear();
      for (const [key, val] of extractConfiguredAgentSkillsMap(rawConfig)) {
        configuredSkillsMap.set(key, val);
      }
    }

    wipeAgentSkillsConfig(api.config);
    if (api.runtime?.config?.current) {
      wipeAgentSkillsConfig(api.runtime.config.current() as OpenClawConfig);
    }

    const normalized = agentId.trim().toLowerCase();
    return (
      configuredSkillsMap.get(normalized) ??
      configuredSkillsMap.get("defaults") ??
      []
    );
  };
}

export function createPlugin(
  api: OpenClawPluginApi,
): OpenClawPluginDefinition & {
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} {
  let config = resolveConfig(api.pluginConfig as Record<string, unknown>);

  const refreshLiveConfigFromRuntime = () => {
    const livePluginConfig = resolveLivePluginConfigObject(
      api.runtime.config?.current
        ? () => api.runtime.config.current() as OpenClawConfig
        : undefined,
      PLUGIN_ID,
      api.pluginConfig as Record<string, unknown>,
    );
    config = resolveConfig(livePluginConfig ?? {});
  };

  return definePluginEntry({
    id: PLUGIN_ID,
    name: "Skill Harness",
    description:
      "Pre-scans user intent before replies and injects routing hints via before_prompt_build hook.",
    register() {
      const runtimeConfig = api.runtime?.config?.current
        ? (api.runtime.config.current() as OpenClawConfig)
        : undefined;

      const configuredSkillsMap = extractConfiguredAgentSkillsMap(api.config);
      const runtimeSkillsMap = extractConfiguredAgentSkillsMap(runtimeConfig);
      for (const [key, val] of runtimeSkillsMap.entries()) {
        const existing = configuredSkillsMap.get(key);
        if (!existing || existing.length === 0) {
          configuredSkillsMap.set(key, val);
        }
      }

      wipeAgentSkillsConfig(api.config);
      wipeAgentSkillsConfig(runtimeConfig);

      const getConfiguredAgentSkills = createConfiguredAgentSkillsResolver(
        api,
        configuredSkillsMap,
      );

      const stateDir = resolveStateDirFromApi(api, process.env);
      const dataRoot = resolvePluginDataRoot(stateDir, PLUGIN_ID);
      initializePluginDataRoot({ dataRoot });

      const catalog = IntentCatalog.create(dataRoot);
      const experienceCatalog = SkillExperienceCatalog.create(dataRoot);
      const tracker = SessionTracker.create(dataRoot);
      const statsAggregator = StatsAggregator.create(dataRoot);
      const curationQueue = createCurationQueue();
      const reviewPath = reviewLogPath(dataRoot);
      const keywordCoveragePath = keywordCoverageLogPath(dataRoot);

      const keywordCoverageWriter = KeywordCoverageWriter.create(dataRoot);
      let triggerKeywordCache = readKeywordCoverageKeywordsFailOpen(
        keywordCoverageWriter,
      );
      const refreshTriggerKeywordCache = () => {
        triggerKeywordCache = readKeywordCoverageKeywordsFailOpen(
          keywordCoverageWriter,
        );
      };

      const reviewLogWriter = IntentReviewLogWriter.create(dataRoot);

      const refreshRuntimeIntents = () => {
        catalog.load("intents");
      };

      const deps: HookDeps = {
        api,
        config: () => config,
        refreshLiveConfigFromRuntime,
        refreshIntents: refreshRuntimeIntents,
        catalog,
        tracker,
        statsAggregator,
        curationQueue,
        reviewLogWriter,
        keywordCoverageWriter,
        triggerKeywords: () => triggerKeywordCache,
        refreshTriggerKeywords: refreshTriggerKeywordCache,
        getConfiguredAgentSkills,

        bundledSkillsDir: path.join(defaultPackageRoot, "skills"),
        dataRoot,
      };

      const handlers = createHookHandlers(deps);

      refreshLiveConfigFromRuntime();
      refreshTriggerKeywordCache();
      refreshRuntimeIntents();

      api.on("before_prompt_build", handlers.onBeforePromptBuild, {
        timeoutMs: config.timeoutMs * 2 + 1_500,
      });
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("tool_result_persist", handlers.onToolResultPersist);
      api.on("before_agent_finalize", handlers.onBeforeAgentFinalize);
      api.on("agent_end", handlers.onAgentEnd);
      api.on("session_end", handlers.onSessionEnd);
      registerSkillTools(api, {
        getIntents: (agentId) => catalog.filterForAgent(config, agentId),
        experienceCatalog,
      });

      setImmediate(() => {
        recoverCurationSchedulesFailOpen({
          recover: handlers.recoverCurationSchedules,
        });
      });
    },
  });
}
