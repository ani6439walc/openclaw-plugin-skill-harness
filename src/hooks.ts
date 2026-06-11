import type { ResolvedIntentionHintPluginConfig } from "./types.js";
import type { OpenClawPluginApi } from "../api.js";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookAfterToolCallEvent,
  PluginHookAgentEndEvent,
  PluginHookSessionEndEvent,
  PluginHookSessionContext,
} from "openclaw/plugin-sdk/types";
import { logger } from "../api.js";
import { defaultCatalog } from "./intent-loader.js";
import { defaultTracker } from "./session-tracker.js";
import { defaultStatsAggregator } from "./stats-aggregator.js";
import { defaultBacklogWriter, type BacklogWriter } from "./backlog-writer.js";
import { defaultReviewQueue, type ReviewQueue } from "./review-queue.js";
import { checkEvolutionTriggers } from "./trigger-checker.js";
import { runReviewSubagent } from "./review-subagent.js";
import {
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
  attachHistoricalIntents,
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
import {
  getModelRef,
  getReviewModelRef,
  runIntentionSubagent,
} from "./subagent.js";
import { buildPromptPrefix } from "./prompt.js";

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedIntentionHintPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
  reviewQueue?: Pick<ReviewQueue, "enqueue">;
  reviewer?: typeof runReviewSubagent;
  backlogWriter?: Pick<BacklogWriter, "record">;
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

function findIntentDefinition(intent: string | undefined) {
  const intentId = intent?.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!intentId) return;
  return defaultCatalog
    .get()
    .find(
      (definition) => definition.id.toLowerCase() === intentId.toLowerCase(),
    );
}

const SESSION_END_REASONS_THAT_DELETE_FILE = new Set([
  "new",
  "reset",
  "idle",
  "daily",
  "compaction",
  "deleted",
]);

export function createHookHandlers(deps: HookDeps) {
  const { api, config, refreshLiveConfigFromRuntime, refreshIntents } = deps;
  const reviewQueue = deps.reviewQueue ?? defaultReviewQueue;
  const reviewer = deps.reviewer ?? runReviewSubagent;
  const backlogWriter = deps.backlogWriter ?? defaultBacklogWriter;

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

      const latestUserMessage = event.prompt ?? "";
      const historicalIntents = ctx.sessionId
        ? defaultTracker.getHistoricalIntentRecords(ctx.sessionId)
        : [];
      const allTurns = attachHistoricalIntents(
        extractRecentTurns(event.messages),
        historicalIntents,
      );

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

      const result = await runIntentionSubagent({
        api,
        config: refreshedConfig,
        agentId: effectiveAgentId,
        sessionKey: resolvedSessionKey,
        sessionId: ctx.sessionId,
        conversation,
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
    ctx: PluginHookAgentContext,
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

    if (!ctx.sessionId) return;
    const state = defaultTracker.getCurrentState(ctx.sessionId);
    if (!state) return;
    const intentDefinition = findIntentDefinition(state.intent?.result?.intent);
    defaultStatsAggregator.record(ctx.sessionId, state, intentDefinition);

    const resolvedConfig = config();
    const evolutionConfig = resolvedConfig.selfEvolution;
    if (!evolutionConfig.enabled) return;
    const baseSnapshot = defaultTracker.getReviewSnapshot(ctx.sessionId);
    if (!baseSnapshot) return;
    const snapshot = {
      ...baseSnapshot,
      matchedIntent: intentDefinition
        ? {
            ...intentDefinition,
            triggers: [...intentDefinition.triggers],
            examples: [...intentDefinition.examples],
          }
        : undefined,
      intentCatalog: defaultCatalog.get().map((definition) => ({
        id: definition.id,
        name: definition.name,
        triggers: [...definition.triggers],
        examples: [...definition.examples],
      })),
    };
    const triggers = checkEvolutionTriggers(
      snapshot.current,
      snapshot.turnNumber,
      evolutionConfig.triggers,
    );
    if (triggers.length === 0) return;

    const agentId = ctx.agentId ?? snapshot.agentId ?? "main";
    const modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
      modelProviderId: ctx.modelProviderId,
      modelId: ctx.modelId,
    });
    if (!modelRef) return;

    reviewQueue.enqueue(async () => {
      const findings = await reviewer({
        api,
        config: resolvedConfig,
        agentId,
        sessionKey: ctx.sessionKey ?? snapshot.sessionKey,
        messageProvider: ctx.messageProvider,
        modelRef,
        snapshot,
        triggers,
      });
      if (!findings) return;
      backlogWriter.record(
        snapshot.eventId,
        {
          sessionId: snapshot.sessionId,
          sessionKey: snapshot.sessionKey,
          agentId: snapshot.agentId,
          turnStart: snapshot.current.timestamps!.start!,
        },
        findings,
      );
    });
  }

  async function onSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    defaultTracker.cleanup(ctx.sessionId, {
      deleteFile: SESSION_END_REASONS_THAT_DELETE_FILE.has(event.reason ?? ""),
    });
    defaultTracker.cleanupExpired();
  }

  return {
    onBeforePromptBuild,
    onAfterToolCall,
    onAgentEnd,
    onSessionEnd,
  };
}
