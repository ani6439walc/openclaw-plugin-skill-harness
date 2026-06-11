import type { ResolvedIntentionHintPluginConfig } from "./types.js";
import type { OpenClawPluginApi } from "../api.js";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookAfterToolCallEvent,
  PluginHookAgentEndEvent,
} from "openclaw/plugin-sdk/types";
import { logger } from "../api.js";
import { defaultCatalog } from "./intent-loader.js";
import { defaultTracker } from "./session-tracker.js";
import {
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
} from "./conversation-extract.js";
import {
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  resolveStatusUpdateAgentId,
  shouldSkipIntentAnalysis,
  resolveCanonicalSessionKeyFromSessionId,
} from "./session.js";
import { getModelRef, runIntentionSubagent } from "./subagent.js";
import { buildPromptPrefix } from "./prompt.js";

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedIntentionHintPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
};

function recordTrackedSession(
  sessionId: string | undefined,
  data: Parameters<typeof defaultTracker.record>[1],
): void {
  if (!sessionId) return;
  if (!defaultTracker.hasIntentData(sessionId)) return;

  defaultTracker.record(sessionId, data);
  defaultTracker.write(sessionId);
}

export function createHookHandlers(deps: HookDeps) {
  const { api, config, refreshLiveConfigFromRuntime, refreshIntents } = deps;

  async function onBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    try {
      // Early return checks FIRST (before refresh calls)
      if (shouldSkipIntentAnalysis(ctx)) return;
      if (isInternalUserTurn(event)) return;

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

      // Use current config for early checks
      const currentConfig = config();
      if (!isEnabledForAgent(currentConfig, effectiveAgentId)) return;
      if (!isEligibleInteractiveSession(ctx)) return;

      const resolvedSessionKeyForChecks = resolvedSessionKey ?? ctx.sessionKey;
      if (
        !isAllowedChatType(currentConfig, {
          ...ctx,
          sessionKey: resolvedSessionKeyForChecks,
          mainKey: api.config.session?.mainKey,
        })
      ) {
        return;
      }
      if (
        !isAllowedChatId(currentConfig, {
          sessionKey: resolvedSessionKeyForChecks,
          messageProvider: ctx.messageProvider,
        })
      ) {
        return;
      }

      // THEN refresh config and intents
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();

      const allTurns = extractRecentTurns(event.messages);
      const latestUserMessage = event.prompt ?? "";

      const conversation = limitConversationTurns(
        allTurns,
        refreshedConfig.queryMode,
        refreshedConfig.contextWindow,
      );

      const modelRef = getModelRef(api, effectiveAgentId, refreshedConfig, {
        modelProviderId: ctx.modelProviderId,
        modelId: ctx.modelId,
      });
      if (!modelRef) return;

      refreshIntents();
      if (defaultCatalog.count === 0) {
        logger.debug("no intents loaded; skipping intention scan.");
        return;
      }

      logger.debug(
        `before_prompt_build hook triggered, ctx: ${JSON.stringify(ctx)}`,
      );

      const availableIntents = defaultCatalog.filterForAgent(
        refreshedConfig,
        effectiveAgentId,
      );
      const previousIntentResult = ctx.sessionId
        ? defaultTracker.getCurrentIntentResult(ctx.sessionId)
        : undefined;

      const result = await runIntentionSubagent({
        api,
        config: refreshedConfig,
        agentId: effectiveAgentId,
        sessionKey: resolvedSessionKey,
        sessionId: ctx.sessionId,
        conversation,
        previousIntentResult,
        latest: latestUserMessage,
        messageProvider: ctx.messageProvider,
        channelId: ctx.channelId,
        modelRef,
        intents: availableIntents,
      });

      if (!result) {
        logger.debug("intention subagent failed; skipping hint injection.");
        return;
      }

      logger.debug(`intention subagent result: ${JSON.stringify(result)}`);

      // Record session data for tracking
      const sessionId = ctx.sessionId;
      if (sessionId) {
        defaultTracker.rotate(sessionId);
        defaultTracker.record(sessionId, {
          sessionKey: resolvedSessionKey ?? ctx.sessionKey,
          agentId: effectiveAgentId,
          current: {
            input: latestUserMessage,
            intent: {
              input: conversation,
              result: result,
            },
            timestamps: { start: new Date().toISOString() },
          },
        });
        defaultTracker.write(sessionId);
      }

      const promptPrefix = buildPromptPrefix(
        result,
        availableIntents,
        refreshedConfig,
      );
      if (!promptPrefix) return;

      return { prependContext: promptPrefix };
    } catch (err) {
      logger.warn("before_prompt_build hook error", { error: err });
      return;
    }
  }

  async function onAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: { sessionId?: string; agentId?: string; sessionKey?: string },
  ): Promise<void> {
    const output = event.result ?? event.error ?? "";
    const outputStr =
      typeof output === "string" ? output : extractToolText(output);
    const truncatedOutput = outputStr.slice(0, 200);

    recordTrackedSession(ctx.sessionId, {
      current: {
        toolCalls: [
          {
            name: event.toolName,
            params: event.params,
            result: event.error ? undefined : truncatedOutput,
            error: event.error ? truncatedOutput : undefined,
            durationMs: event.durationMs,
          },
        ],
      },
    });
  }

  async function onAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: { sessionId?: string; agentId?: string; sessionKey?: string },
  ): Promise<void> {
    const turns = extractRecentTurns(
      event.messages as Array<{
        role?: string;
        content?: string;
      }>,
    );
    const lastAssistantTurn = turns
      .slice()
      .reverse()
      .find((t) => t.role === "assistant");

    recordTrackedSession(ctx.sessionId, {
      current: {
        result: lastAssistantTurn?.text,
        error: event.error,
        timestamps: { end: new Date().toISOString() },
      },
    });
  }

  return {
    onBeforePromptBuild,
    onAfterToolCall,
    onAgentEnd,
  };
}
