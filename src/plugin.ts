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
import { migrateKeywordStateOnce } from "./review/keyword-state-migration.js";
import {
  normalizeReviewTriggerKeywords,
  type ReviewTriggerKeywords,
} from "./review/trigger-keywords.js";
import { createHookHandlers, type HookDeps } from "./hooks/index.js";
import { registerSkillTools } from "./skills/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  intentsPath,
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
      const stateDir = resolveStateDirFromApi(api, process.env);
      const dataRoot = resolvePluginDataRoot(stateDir, PLUGIN_ID);
      initializePluginDataRoot({ dataRoot });

      const catalog = IntentCatalog.create(dataRoot);
      const tracker = SessionTracker.create(dataRoot);
      const statsAggregator = StatsAggregator.create(dataRoot);
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

      // Fail-open one-time cutover. Finalization waits for this before it writes runtime review state.
      const migrationPromise: Promise<void> = migrateKeywordStateOnce({
        reviewPath,
        keywordCoveragePath,
      })
        .then(() => {
          refreshTriggerKeywordCache();
        })
        .catch((error) => {
          logger.warn("keyword state migration failed", { error });
        });
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
        reviewLogWriter,
        keywordCoverageWriter,
        triggerKeywords: () => triggerKeywordCache,
        refreshTriggerKeywords: refreshTriggerKeywordCache,
        migrationPromise,
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
