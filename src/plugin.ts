import {
  definePluginEntry,
  logger,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "../api.js";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { clampInt, normalizePluginConfig } from "./config.js";
import { IntentCatalog } from "./intent-loader.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyQueryFilters, extractRecentTurns } from "./query.js";
import {
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  resolveStatusUpdateAgentId,
  shouldSkipIntentAnalysis,
  resolveCanonicalSessionKeyFromSessionId,
} from "./session.js";
import {
  buildIntentionEmbeddedRunParams,
  buildIntentionPrompt,
  buildPromptPrefix,
  getModelRef,
  parseIntentionResult,
  runIntentionSubagent,
} from "./subagent.js";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const intentCatalog = new IntentCatalog(pluginRoot);

export function createPlugin(api: OpenClawPluginApi) {
  return definePluginEntry({
    id: "intention-hint",
    name: "Intention Hint",
    description:
      "Pre-scans user intent before replies and injects routing hints via before_prompt_build hook.",
    register() {
      let config = normalizePluginConfig(api.pluginConfig);

      const refreshLiveConfigFromRuntime = () => {
        const livePluginConfig = resolveLivePluginConfigObject(
          api.runtime.config?.current
            ? () => api.runtime.config.current() as OpenClawConfig
            : undefined,
          "intention-hint",
          api.pluginConfig as Record<string, unknown>,
        );
        config = normalizePluginConfig(livePluginConfig ?? {});
      };

      refreshLiveConfigFromRuntime();

      const refreshIntents = () => {
        const dir = config.intentsDir;
        if (dir) {
          intentCatalog.load(dir);
        } else {
          intentCatalog.reset();
        }
      };
      refreshIntents();

      let hotReloadTimer: ReturnType<typeof setInterval> | undefined;
      const startHotReload = () => {
        if (hotReloadTimer) return;
        if (!config.intentsHotReload || !config.intentsDir) return;
        hotReloadTimer = setInterval(() => {
          refreshIntents();
        }, config.intentsHotReloadIntervalMs);
      };
      startHotReload();

      api.on(
        "before_prompt_build",
        async (event, ctx) => {
          try {
            refreshLiveConfigFromRuntime();

            if (shouldSkipIntentAnalysis(ctx)) return undefined;

            const resolvedAgentId = resolveStatusUpdateAgentId(ctx);
            const resolvedSessionKey =
              ctx.sessionKey?.trim() ||
              (resolvedAgentId
                ? resolveCanonicalSessionKeyFromSessionId({
                    api,
                    agentId: resolvedAgentId,
                    sessionId: ctx.sessionId,
                  })
                : undefined);
            const effectiveAgentId = resolvedAgentId;

            if (!isEnabledForAgent(config, effectiveAgentId)) return undefined;
            if (!isEligibleInteractiveSession(ctx)) return undefined;
            logger.debug(
              `before_prompt_build hook triggered, ctx: ${JSON.stringify(ctx)}`,
            );
            if (
              !isAllowedChatType(config, {
                ...ctx,
                sessionKey: resolvedSessionKey ?? ctx.sessionKey,
                mainKey: api.config.session?.mainKey,
              })
            ) {
              return undefined;
            }
            if (
              !isAllowedChatId(config, {
                sessionKey: resolvedSessionKey ?? ctx.sessionKey,
                messageProvider: ctx.messageProvider,
              })
            ) {
              return undefined;
            }

            const allTurns = extractRecentTurns(event.messages);
            const latestUserMessage = event.prompt ?? "";

            const conversation = applyQueryFilters(allTurns, {
              queryMode: config.queryMode,
              recentUserTurns: config.recentUserTurns,
              recentAssistantTurns: config.recentAssistantTurns,
              recentUserChars: config.recentUserChars,
              recentAssistantChars: config.recentAssistantChars,
            });

            const modelRef = getModelRef(api, effectiveAgentId, config, {
              modelProviderId: ctx.modelProviderId,
              modelId: ctx.modelId,
            });
            if (!modelRef) return undefined;

            if (intentCatalog.count === 0) {
              logger.debug("No intents loaded; skipping intention scan.");
              return undefined;
            }

            const result = await runIntentionSubagent({
              api,
              config,
              agentId: effectiveAgentId,
              sessionKey: resolvedSessionKey,
              sessionId: ctx.sessionId,
              conversation,
              latest: latestUserMessage,
              messageProvider: ctx.messageProvider,
              channelId: ctx.channelId,
              modelRef,
              intents: intentCatalog.get(),
            });

            if (!result) {
              logger.debug("Intention subagent failed; skipping hint injection.");
              return undefined;
            }

            const promptPrefix = buildPromptPrefix(result, intentCatalog.get());
            if (!promptPrefix) return undefined;

            return { prependContext: promptPrefix };
          } catch {
            return undefined;
          }
        },
        { timeoutMs: config.timeoutMs + 250 },
      );

      logger.debug("registering intention-hint before_prompt_build hook");
    },
  });
}

export const __testing = {
  normalizePluginConfig,
  clampInt,
  buildIntentionPrompt,
  buildIntentionEmbeddedRunParams,
  parseIntentionResult,
  buildPromptPrefix,
  applyQueryFilters,
  extractRecentTurns,
  getModelRef,
  isEnabledForAgent,
  isEligibleInteractiveSession,
  shouldSkipIntentAnalysis,
  isAllowedChatType,
  isAllowedChatId,
  resolveStatusUpdateAgentId,
};
