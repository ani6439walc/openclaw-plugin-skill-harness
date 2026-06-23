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
  runIntentInstructionSubagent,
  runIntentionSubagent,
  runTopicSwitchSubagent,
} from "./subagent.js";
import { buildPromptPrefix } from "./prompt.js";
import { FALLBACK_INTENT } from "./constants.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentionResult,
} from "./types.js";

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedIntentionHintPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
  catalog?: typeof defaultCatalog;
  tracker?: typeof defaultTracker;
  statsAggregator?: typeof defaultStatsAggregator;
  reviewQueue?: Pick<ReviewQueue, "enqueue">;
  reviewer?: typeof runReviewSubagent;
  classifier?: typeof runIntentionSubagent;
  topicChecker?: typeof runTopicSwitchSubagent;
  instructionWriter?: typeof runIntentInstructionSubagent;
  backlogWriter?: Pick<BacklogWriter, "record">;
};

function recordTrackedSession(
  tracker: typeof defaultTracker,
  sessionId: string | undefined,
  data: Parameters<typeof defaultTracker.record>[1],
): void {
  if (!sessionId) return;
  if (!tracker.hasIntentData(sessionId)) return;

  tracker.record(sessionId, data);
  tracker.write(sessionId);
}

function findIntentDefinition(
  catalog: typeof defaultCatalog,
  intent: string | undefined,
) {
  const intentId = intent?.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!intentId) return;
  return catalog
    .get()
    .find((entry) => entry.id.toLowerCase() === intentId.toLowerCase());
}

function findIntentBody(
  intents: readonly { id: string; definition: { prompt: string } }[],
  intent: string | undefined,
): string {
  const intentId = intent?.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!intentId) return FALLBACK_INTENT.prompt;
  return (
    intents.find((entry) => entry.id.toLowerCase() === intentId.toLowerCase())
      ?.definition.prompt ?? FALLBACK_INTENT.prompt
  );
}

function runInheritedIntentClassifier(
  latest: HistoricalIntentRecord,
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
): IntentionResult {
  return {
    intent: latest.intent,
    reason: "Topic unchanged; inherited previous intent",
    keywords: latest.keywords ? [...latest.keywords] : undefined,
    topic: latest.topic,
    topicChanged: false,
    topicChangeReason: topicContext.topicChangeReason,
    previousTopic: latest.topic,
    confidence: latest.confidence ?? 0.8,
    complexity: topicContext.complexity,
  };
}

function resolveIntentId(intent: string | undefined): string | undefined {
  return intent?.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase();
}

function normalizeKeywordForMatching(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

const normalizedIntentKeywords = new WeakMap<
  IntentCatalogEntry,
  Array<{ normalized: string; keyword: string }>
>();
const HIGH_RISK_KEYWORDS_REGEX =
  /\b(delete|remove|rm|deploy|publish|production|prod|credential|token|secret|key)\b/i;

function getNormalizedIntentKeywords(
  intent: IntentCatalogEntry,
): Array<{ normalized: string; keyword: string }> {
  const cached = normalizedIntentKeywords.get(intent);
  if (cached) return cached;

  const keywords = intent.definition.keywords.map((keyword) => ({
    normalized: normalizeKeywordForMatching(keyword),
    keyword: keyword.trim(),
  }));
  normalizedIntentKeywords.set(intent, keywords);
  return keywords;
}

function findExactKeywordIntent(
  latest: string,
  intents: readonly IntentCatalogEntry[],
): { intent: IntentCatalogEntry; keyword: string } | undefined {
  const normalizedLatest = normalizeKeywordForMatching(latest);
  if (!normalizedLatest) return;

  for (const intent of intents) {
    for (const keyword of getNormalizedIntentKeywords(intent)) {
      if (keyword.normalized === normalizedLatest) {
        return { intent, keyword: keyword.keyword };
      }
    }
  }
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      current[j + 1] =
        a[i] === b[j]
          ? previous[j]
          : Math.min(previous[j], previous[j + 1], current[j]) + 1;
    }
    previous = current;
  }

  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function scoreTopicKeywordSimilarity(
  topicKeyword: string,
  intentKeyword: string,
) {
  const topic = normalizeKeywordForMatching(topicKeyword);
  const intent = normalizeKeywordForMatching(intentKeyword);
  if (!topic || !intent) return 0;
  if (topic === intent) return 1;

  if (
    Math.min(topic.length, intent.length) >= 4 &&
    (topic.includes(intent) || intent.includes(topic))
  ) {
    return 0.9;
  }
  if (topic.length < 4 || intent.length < 4) return 0;

  return levenshteinSimilarity(topic, intent);
}

function findTopicKeywordSimilarityIntent(
  latest: string,
  domain: string,
  topicKeywords: readonly string[],
  intents: readonly IntentCatalogEntry[],
):
  | {
      intent: IntentCatalogEntry;
      topicKeyword: string;
      intentKeyword: string;
      score: number;
    }
  | undefined {
  if (HIGH_RISK_KEYWORDS_REGEX.test(latest)) return;

  let best:
    | {
        intent: IntentCatalogEntry;
        topicKeyword: string;
        intentKeyword: string;
        score: number;
      }
    | undefined;
  let secondBestScore = 0;

  for (const intent of intents) {
    if (intent.definition.domain !== domain) continue;

    let intentBest:
      | { topicKeyword: string; intentKeyword: string; score: number }
      | undefined;

    for (const topicKeyword of topicKeywords) {
      for (const intentKeyword of getNormalizedIntentKeywords(intent)) {
        const score = scoreTopicKeywordSimilarity(
          topicKeyword,
          intentKeyword.keyword,
        );
        if (!intentBest || score > intentBest.score) {
          intentBest = {
            topicKeyword,
            intentKeyword: intentKeyword.keyword,
            score,
          };
        }
      }
    }

    if (!intentBest) continue;
    if (!best || intentBest.score > best.score) {
      secondBestScore = best?.score ?? 0;
      best = { intent, ...intentBest };
    } else {
      secondBestScore = Math.max(secondBestScore, intentBest.score);
    }
  }

  if (!best || best.score < 0.8) return;
  // ponytail: simple ambiguity guard; replace with domain mapper if this grows.
  if (secondBestScore >= 0.8 && best.score - secondBestScore < 0.15) return;
  return best;
}

function collectIntentDomains(
  intents: readonly IntentCatalogEntry[],
): string[] {
  return [...new Set(intents.map((intent) => intent.definition.domain))].sort();
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
  const catalog = deps.catalog ?? defaultCatalog;
  const tracker = deps.tracker ?? defaultTracker;
  const statsAggregator = deps.statsAggregator ?? defaultStatsAggregator;
  const reviewQueue = deps.reviewQueue ?? defaultReviewQueue;
  const reviewer = deps.reviewer ?? runReviewSubagent;
  const classifier = deps.classifier ?? runIntentionSubagent;
  const topicChecker = deps.topicChecker ?? runTopicSwitchSubagent;
  const instructionWriter =
    deps.instructionWriter ?? runIntentInstructionSubagent;
  const backlogWriter = deps.backlogWriter ?? defaultBacklogWriter;

  function resolvePromptBuildRouting(
    ctx: PluginHookAgentContext,
  ): { effectiveAgentId: string; resolvedSessionKey?: string } | undefined {
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

    // Use current config for early checks. These must run before refreshing live config.
    const currentConfig = config();
    if (!isEnabledForAgent(currentConfig, resolvedAgentId)) return;
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

    return { effectiveAgentId: resolvedAgentId, resolvedSessionKey };
  }

  function buildConversationContext(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
    refreshedConfig: ResolvedIntentionHintPluginConfig,
  ): {
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
  } {
    const latestUserMessage = event.prompt ?? "";
    const historicalIntents = ctx.sessionId
      ? tracker.getHistoricalIntentRecords(ctx.sessionId)
      : [];
    const allTurns = attachHistoricalIntents(
      extractRecentTurns(event.messages),
      historicalIntents,
      { latestInput: latestUserMessage },
    );
    const conversation = limitConversationTurns(
      allTurns,
      refreshedConfig.queryMode,
      refreshedConfig.contextWindow,
    );

    return { latestUserMessage, historicalIntents, conversation };
  }

  function applyTopicContextToResult(
    result: IntentionResult,
    topicContext: Awaited<ReturnType<typeof runTopicSwitchSubagent>>,
    latestHistoricalIntent: HistoricalIntentRecord | undefined,
  ): void {
    if (topicContext) {
      result.complexity = topicContext.complexity;
      result.keywords = [...topicContext.keywords];
      result.topic = topicContext.topic;
      result.topicChanged = topicContext.topicChanged;
      result.topicChangeReason = topicContext.topicChangeReason;
      result.previousTopic = latestHistoricalIntent?.topic;
    }
  }

  async function classifyPromptBuild(params: {
    ctx: PluginHookAgentContext;
    refreshedConfig: ResolvedIntentionHintPluginConfig;
    effectiveAgentId: string;
    resolvedSessionKey?: string;
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
    modelRef: { provider: string; model: string };
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
  }): Promise<IntentionResult | undefined> {
    const topicContext = await topicChecker({
      api,
      config: params.refreshedConfig,
      agentId: params.effectiveAgentId,
      sessionKey: params.resolvedSessionKey,
      sessionId: params.ctx.sessionId,
      conversation: params.conversation,
      latest: params.latestUserMessage,
      domains: collectIntentDomains(params.availableIntents),
      history: params.historicalIntents,
      messageProvider: params.ctx.messageProvider,
      modelRef: params.modelRef,
    });

    const latestHistoricalIntent =
      params.historicalIntents[params.historicalIntents.length - 1];
    const useInheritedIntentClassifier =
      topicContext?.topicChanged === false && latestHistoricalIntent;

    let result: IntentionResult | undefined;
    let topicKeywordSimilarityMatched = false;
    if (useInheritedIntentClassifier) {
      result = runInheritedIntentClassifier(
        latestHistoricalIntent,
        topicContext,
      );
    } else {
      if (topicContext) {
        const topicKeywordSimilarityMatch = findTopicKeywordSimilarityIntent(
          params.latestUserMessage,
          topicContext.domain,
          topicContext.keywords,
          params.availableIntents,
        );
        if (topicKeywordSimilarityMatch) {
          topicKeywordSimilarityMatched = true;
          result = {
            intent: topicKeywordSimilarityMatch.intent.id,
            reason: `Topic keyword similarity match: ${topicKeywordSimilarityMatch.topicKeyword} -> ${topicKeywordSimilarityMatch.intentKeyword}`,
            keywords: [
              topicKeywordSimilarityMatch.topicKeyword,
              topicKeywordSimilarityMatch.intentKeyword,
            ],
            topic: topicContext.topic,
            topicChanged: topicContext.topicChanged,
            topicChangeReason: topicContext.topicChangeReason,
            previousTopic: latestHistoricalIntent?.topic,
            confidence: topicKeywordSimilarityMatch.score,
            complexity: topicContext.complexity,
          };
        }
      }
      result ??= await classifier({
        api,
        config: params.refreshedConfig,
        agentId: params.effectiveAgentId,
        sessionKey: params.resolvedSessionKey,
        sessionId: params.ctx.sessionId,
        conversation: params.conversation,
        latest: params.latestUserMessage,
        messageProvider: params.ctx.messageProvider,
        channelId: params.ctx.channelId,
        modelRef: params.modelRef,
        intents: params.availableIntents,
        topicContext: topicContext ?? undefined,
      });
    }

    if (result) {
      if (!topicKeywordSimilarityMatched) {
        applyTopicContextToResult(result, topicContext, latestHistoricalIntent);
      }
    }
    return result;
  }

  function recordPromptBuildSession(params: {
    sessionId?: string;
    resolvedSessionKey?: string;
    fallbackSessionKey?: string;
    effectiveAgentId: string;
    latestUserMessage: string;
    result: IntentionResult;
    instructionText?: string;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): void {
    if (!params.sessionId) return;

    tracker.rotate(params.sessionId);
    tracker.record(params.sessionId, {
      sessionKey: params.resolvedSessionKey ?? params.fallbackSessionKey,
      agentId: params.effectiveAgentId,
      current: {
        input: params.latestUserMessage,
        intent: {
          ...(params.result.topicChangeReason === "same-topic"
            ? {}
            : { input: params.conversation }),
          result: params.result,
          instructionText: params.instructionText,
        },
        timestamps: { start: new Date().toISOString() },
      },
    });
    tracker.write(params.sessionId);
  }

  async function onBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    try {
      // Early return checks FIRST (before refresh calls)
      if (shouldSkipIntentAnalysis(ctx)) return;
      if (isInternalUserTurn(event)) return;

      const routing = resolvePromptBuildRouting(ctx);
      if (!routing) return;

      // THEN refresh config and intents
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      const { latestUserMessage, historicalIntents, conversation } =
        buildConversationContext(event, ctx, refreshedConfig);

      refreshIntents();
      if (catalog.count === 0) {
        logger.debug("no intents loaded; skipping intention scan.");
        return;
      }

      logger.debug(
        `before_prompt_build hook triggered, ctx: ${JSON.stringify(ctx)}`,
      );

      const availableIntents = catalog.filterForAgent(
        refreshedConfig,
        routing.effectiveAgentId,
      );
      const exactKeywordMatch = findExactKeywordIntent(
        latestUserMessage,
        availableIntents,
      );
      if (exactKeywordMatch) {
        const latestHistoricalIntent =
          historicalIntents[historicalIntents.length - 1];
        const sameIntent =
          resolveIntentId(latestHistoricalIntent?.intent) ===
          exactKeywordMatch.intent.id.toLowerCase();
        const result: IntentionResult = {
          intent: exactKeywordMatch.intent.id,
          reason: `Exact keyword match: ${exactKeywordMatch.keyword}`,
          keywords: [exactKeywordMatch.keyword],
          topic: `Exact keyword match for ${exactKeywordMatch.intent.id}.`,
          previousTopic: latestHistoricalIntent?.topic,
          topicChanged: latestHistoricalIntent ? !sameIntent : true,
          topicChangeReason: !latestHistoricalIntent
            ? "initial"
            : sameIntent
              ? "same-topic"
              : "keyword-match",
          confidence: 1,
          complexity: "low",
        };
        recordPromptBuildSession({
          sessionId: ctx.sessionId,
          resolvedSessionKey: routing.resolvedSessionKey,
          fallbackSessionKey: ctx.sessionKey,
          effectiveAgentId: routing.effectiveAgentId,
          latestUserMessage,
          result,
          conversation,
        });
        const promptPrefix = buildPromptPrefix(
          result,
          availableIntents,
          refreshedConfig,
        );
        if (!promptPrefix) return;
        return { prependContext: promptPrefix };
      }

      const modelRef = getModelRef(
        api,
        routing.effectiveAgentId,
        refreshedConfig,
        {
          modelProviderId: ctx.modelProviderId,
          modelId: ctx.modelId,
        },
      );
      if (!modelRef) return;

      const result = await classifyPromptBuild({
        ctx,
        refreshedConfig,
        effectiveAgentId: routing.effectiveAgentId,
        resolvedSessionKey: routing.resolvedSessionKey,
        latestUserMessage,
        historicalIntents,
        conversation,
        modelRef,
        availableIntents,
      });

      if (!result) {
        logger.debug("intention subagent failed; skipping hint injection.");
        return;
      }

      logger.debug(`intention subagent result: ${JSON.stringify(result)}`);

      // Skip intent instruction subagent and hint injection when topic unchanged
      if (result.topicChanged === false) {
        logger.debug(
          "topic unchanged; skipping intent instruction subagent and hint injection.",
        );
        recordPromptBuildSession({
          sessionId: ctx.sessionId,
          resolvedSessionKey: routing.resolvedSessionKey,
          fallbackSessionKey: ctx.sessionKey,
          effectiveAgentId: routing.effectiveAgentId,
          latestUserMessage,
          result,
          conversation,
        });
        return;
      }

      // Skip intent instruction subagent when confidence is too low
      if ((result.confidence ?? 0) < 0.7) {
        logger.debug(
          `confidence ${result.confidence} below 0.7; skipping intent instruction subagent and hint injection.`,
        );
        recordPromptBuildSession({
          sessionId: ctx.sessionId,
          resolvedSessionKey: routing.resolvedSessionKey,
          fallbackSessionKey: ctx.sessionKey,
          effectiveAgentId: routing.effectiveAgentId,
          latestUserMessage,
          result,
          conversation,
        });
        return;
      }

      const instructionText = await instructionWriter({
        api,
        config: refreshedConfig,
        agentId: routing.effectiveAgentId,
        sessionKey: routing.resolvedSessionKey,
        sessionId: ctx.sessionId,
        conversation,
        latest: latestUserMessage,
        result,
        intentBody: findIntentBody(availableIntents, result.intent),
        messageProvider: ctx.messageProvider,
        modelRef,
      });

      recordPromptBuildSession({
        sessionId: ctx.sessionId,
        resolvedSessionKey: routing.resolvedSessionKey,
        fallbackSessionKey: ctx.sessionKey,
        effectiveAgentId: routing.effectiveAgentId,
        latestUserMessage,
        result,
        instructionText,
        conversation,
      });

      const promptPrefix = buildPromptPrefix(
        result,
        availableIntents,
        refreshedConfig,
        instructionText,
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

    recordTrackedSession(tracker, ctx.sessionId, {
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

    recordTrackedSession(tracker, ctx.sessionId, {
      current: {
        result: lastAssistantTurn?.text,
        error: event.error,
        timestamps: { end: new Date().toISOString() },
      },
    });

    if (!ctx.sessionId) return;
    const state = tracker.getCurrentState(ctx.sessionId);
    if (!state) return;
    const intentDefinition = findIntentDefinition(
      catalog,
      state.intent?.result?.intent,
    );
    statsAggregator.record(ctx.sessionId, state, intentDefinition);

    const resolvedConfig = config();
    const evolutionConfig = resolvedConfig.evolution;
    if (!evolutionConfig.enabled) return;
    const baseSnapshot = tracker.getReviewSnapshot(ctx.sessionId);
    if (!baseSnapshot) return;
    const snapshot = {
      ...baseSnapshot,
      matchedIntent: intentDefinition
        ? {
            id: intentDefinition.id,
            definition: {
              ...intentDefinition.definition,
              triggers: [...intentDefinition.definition.triggers],
              examples: [...intentDefinition.definition.examples],
            },
          }
        : undefined,
      intentCatalog: catalog.get().map((entry) => ({
        id: entry.id,
        triggers: [...entry.definition.triggers],
        examples: [...entry.definition.examples],
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
      await backlogWriter.record(
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
    tracker.cleanup(ctx.sessionId, {
      deleteFile: SESSION_END_REASONS_THAT_DELETE_FILE.has(event.reason ?? ""),
    });
    tracker.cleanupExpired();
  }

  return {
    onBeforePromptBuild,
    onAfterToolCall,
    onAgentEnd,
    onSessionEnd,
  };
}
