import {
  createSubsystemLogger,
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "../api.js";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { clampInt, normalizePluginConfig } from "./config.js";
import { loadIntents } from "./intent-loader.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuery, extractRecentTurns } from "./query.js";
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
import type { IntentDefinition } from "./types.js";

export function createPlugin(api: OpenClawPluginApi) {
  return definePluginEntry({
    id: "intention-hint",
    name: "Intention Hint",
    description:
      "Pre-scans user intent before replies and injects routing hints via before_prompt_build hook.",
    register() {
      const logger = createSubsystemLogger("plugins/intention-hint");
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

      const pluginRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
      );
      let intents: IntentDefinition[] = [];
      const refreshIntents = () => {
        const dir = config.intentsDir;
        if (dir) {
          const resolvedDir = path.resolve(pluginRoot, dir);
          intents = loadIntents(resolvedDir);
          logger.debug(
            `Loaded ${intents.length} dynamic intents from ${resolvedDir}`,
          );
        } else {
          intents = [];
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
      const stopHotReload = () => {
        if (hotReloadTimer) {
          clearInterval(hotReloadTimer);
          hotReloadTimer = undefined;
        }
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

            const recentTurns = extractRecentTurns(event.messages);
            const latestUserMessage = event.prompt ?? "";

            const modelRef = getModelRef(api, effectiveAgentId, config, {
              modelProviderId: ctx.modelProviderId,
              modelId: ctx.modelId,
            });
            if (!modelRef) return undefined;

            if (intents.length === 0) {
              logger.debug("No intents loaded; skipping intention scan.");
              return undefined;
            }

            const result = await runIntentionSubagent({
              api,
              config,
              agentId: effectiveAgentId,
              sessionKey: resolvedSessionKey,
              sessionId: ctx.sessionId,
              conversation: recentTurns,
              latest: latestUserMessage,
              messageProvider: ctx.messageProvider,
              channelId: ctx.channelId,
              modelRef,
              intents,
            });
            logger.debug(
              `Intention subagent result: ${JSON.stringify(result)}`,
            );

            const promptPrefix = buildPromptPrefix(result, intents);
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
  buildQuery,
  extractRecentTurns,
  getModelRef,
  isEnabledForAgent,
  isEligibleInteractiveSession,
  shouldSkipIntentAnalysis,
  isAllowedChatType,
  isAllowedChatId,
  resolveStatusUpdateAgentId,
};
