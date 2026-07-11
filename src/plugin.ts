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
import { ReviewLogWriter } from "./review/log-writer.js";
import {
  readReviewLog,
  readReviewTriggerKeywords,
  writeReviewLogAtomic,
} from "./review/log.js";
import {
  normalizeReviewTriggerKeywords,
  type ReviewTriggerKeywords,
} from "./review/trigger-keywords.js";
import { createHookHandlers, type HookDeps } from "./hooks/index.js";
import { registerSkillTools } from "./skills/index.js";
import type { ResolvedSkillHarnessPluginConfig } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  intentsPath,
  legacyReviewLogPath,
  reviewLogPath,
  packageRoot as defaultPackageRoot,
  resolvePluginDataRoot,
  sessionsDirPath,
} from "./file-utils.js";

const PLUGIN_ID = "skill-harness";
const EXAMPLE_INTENT_ASSETS_DIR = path.join(
  "skills",
  "skill-harness",
  "assets",
);

function reviewKeywordSeedFromConfig(
  config: ResolvedSkillHarnessPluginConfig,
): Partial<ReviewTriggerKeywords> | undefined {
  const seed: Partial<ReviewTriggerKeywords> = {};
  if (config.review.triggers.successfulPattern.keywords !== undefined) {
    seed.successfulPattern = config.review.triggers.successfulPattern.keywords;
  }
  if (config.review.triggers.behaviorFix.keywords !== undefined) {
    seed.behaviorFix = config.review.triggers.behaviorFix.keywords;
  }
  if (config.review.triggers.entityContext.keywords !== undefined) {
    seed.entityContext = config.review.triggers.entityContext.keywords;
  }
  return Object.keys(seed).length > 0 ? seed : undefined;
}

function readReviewTriggerKeywordsFailOpen(
  logPath: string,
  triggerKeywordSeed?: Partial<ReviewTriggerKeywords>,
): ReviewTriggerKeywords {
  try {
    return readReviewTriggerKeywords(logPath, triggerKeywordSeed);
  } catch (err) {
    logger.warn("failed to read review trigger keywords", {
      error: err,
      path: logPath,
    });
    return normalizeReviewTriggerKeywords(triggerKeywordSeed);
  }
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

function migrateLegacyReviewLog(dataRoot: string): void {
  const targetPath = reviewLogPath(dataRoot);
  if (fs.existsSync(targetPath)) return;

  const sourcePath = legacyReviewLogPath(dataRoot);
  if (!fs.existsSync(sourcePath)) return;

  try {
    writeReviewLogAtomic(targetPath, readReviewLog(sourcePath));
  } catch (err) {
    logger.warn("failed to migrate legacy review log", {
      error: err,
      sourcePath,
      targetPath,
    });
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

  migrateLegacyReviewLog(dataRoot);
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
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const dataRoot = resolvePluginDataRoot(stateDir, PLUGIN_ID);
      initializePluginDataRoot({ dataRoot });

      const catalog = IntentCatalog.create(dataRoot);
      const tracker = SessionTracker.create(dataRoot);
      const statsAggregator = StatsAggregator.create(dataRoot);
      const logPath = reviewLogPath(dataRoot);
      let triggerKeywordCache = readReviewTriggerKeywordsFailOpen(
        logPath,
        reviewKeywordSeedFromConfig(config),
      );
      const refreshTriggerKeywordCache = () => {
        triggerKeywordCache = readReviewTriggerKeywordsFailOpen(
          logPath,
          reviewKeywordSeedFromConfig(config),
        );
      };
      const reviewLogWriter = ReviewLogWriter.create(dataRoot, {
        triggerKeywordSeed: () => reviewKeywordSeedFromConfig(config),
        onAfterWrite: refreshTriggerKeywordCache,
      });

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
        reviewLogWriter,
        triggerKeywords: () => triggerKeywordCache,
        dataRoot,
      };

      const handlers = createHookHandlers(deps);

      refreshLiveConfigFromRuntime();
      refreshTriggerKeywordCache();
      refreshRuntimeIntents();

      api.on("before_prompt_build", handlers.onBeforePromptBuild, {
        timeoutMs: config.timeoutMs * 3 + 1_500,
      });
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("tool_result_persist", handlers.onToolResultPersist);
      api.on("before_agent_finalize", handlers.onBeforeAgentFinalize);
      api.on("agent_end", handlers.onAgentEnd);
      api.on("session_end", handlers.onSessionEnd);
      registerSkillTools(api, {
        getIntents: (agentId) => catalog.filterForAgent(config, agentId),
      });
    },
  });
}
