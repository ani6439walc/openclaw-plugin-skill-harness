import type { ResolvedSkillHarnessPluginConfig } from "./types.js";
import type { EvolutionFinding } from "./evolution-types.js";
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
import { emitAgentEvent as emitHostAgentEvent } from "openclaw/plugin-sdk/agent-harness";
import { logger } from "../api.js";
import { defaultCatalog } from "./intent-loader.js";
import { defaultTracker } from "./session-tracker.js";
import { defaultStatsAggregator } from "./stats-aggregator.js";
import { defaultBacklogWriter, type BacklogWriter } from "./backlog-writer.js";
import { defaultReviewQueue, type ReviewQueue } from "./review-queue.js";
import { checkEvolutionTriggers } from "./trigger-checker.js";
import {
  runReviewSubagent,
  type ReviewSubagentResult,
} from "./review-subagent.js";
import {
  DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
  type EvolutionTriggerKeywords,
} from "./evolution-trigger-keywords.js";
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
  getInstructionModelRef,
  getModelRef,
  getReviewModelRef,
  runIntentInstructionSubagent,
  runIntentionSubagent,
  runTopicSwitchSubagent,
} from "./subagent.js";
import { buildDomainSkillsPromptPrefix, buildPromptPrefix } from "./prompt.js";
import {
  resolveAvailableSkills,
  resolveDomainSkills,
} from "./skill-catalog.js";
import { FALLBACK_INTENT } from "./constants.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentionResult,
} from "./types.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";

type PipelinePhase = "topic-triage" | "intent-classify" | "hint-generate";

type PipelineState = "started" | "completed" | "failed";

type PipelineMetadata = {
  domain?: string;
  keywords?: string[];
  topic?: string;
  changed?: boolean;
  complexity?: string;
  intent?: string;
  reason?: string;
  confidence?: number;
  result?: string;
  error?: string;
};

const LOW_THINKING_EFFORTS = new Set(["off", "minimal", "low"]);

function resolveReasoningEffort(
  ctx: PluginHookAgentContext,
): string | undefined {
  const value = (ctx as Record<string, unknown>).reasoningEffort;
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function isLowThinkingEffort(ctx: PluginHookAgentContext): boolean {
  const effort = resolveReasoningEffort(ctx);
  return effort ? LOW_THINKING_EFFORTS.has(effort) : false;
}

function shouldSkipAllForLowThinking(
  ctx: PluginHookAgentContext,
  config: ResolvedSkillHarnessPluginConfig,
): boolean {
  return config.lowThinkingMode === "off" && isLowThinkingEffort(ctx);
}

function shouldUseDeterministicLowThinkingMode(
  ctx: PluginHookAgentContext,
  config: ResolvedSkillHarnessPluginConfig,
): boolean {
  return config.lowThinkingMode === "fastpath-only" && isLowThinkingEffort(ctx);
}

function cleanPipelineEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedSkillHarnessPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
  catalog?: typeof defaultCatalog;
  tracker?: typeof defaultTracker;
  statsAggregator?: typeof defaultStatsAggregator;
  reviewQueue?: Pick<ReviewQueue, "enqueue">;
  reviewer?: (
    params: Parameters<typeof runReviewSubagent>[0],
  ) => Promise<ReviewSubagentResult | EvolutionFinding[] | undefined>;
  classifier?: typeof runIntentionSubagent;
  topicChecker?: typeof runTopicSwitchSubagent;
  instructionWriter?: typeof runIntentInstructionSubagent;
  backlogWriter?: Pick<BacklogWriter, "record">;
  triggerKeywords?: () => EvolutionTriggerKeywords;
  bundledSkillsDir?: string;
};

function readTriggerKeywordsFailOpen(
  reader?: () => EvolutionTriggerKeywords,
): EvolutionTriggerKeywords {
  if (!reader) return DEFAULT_EVOLUTION_TRIGGER_KEYWORDS;
  try {
    return reader();
  } catch (error) {
    logger.warn("failed to read evolution trigger keywords", { error });
    return DEFAULT_EVOLUTION_TRIGGER_KEYWORDS;
  }
}

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

function buildInheritedIntentResult(
  latest: HistoricalIntentRecord,
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
): IntentionResult {
  return {
    intent: latest.intent,
    reason: "Topic unchanged; inherited previous intent",
    keywords: latest.keywords ? [...latest.keywords] : undefined,
    domain: latest.domain ?? FALLBACK_INTENT.domain,
    topic: latest.topic,
    confidence: latest.confidence ?? 0.8,
    complexity: topicContext.complexity,
  };
}

function resolveIntentId(intent: string | undefined): string | undefined {
  return intent?.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase();
}

function findIntentDomain(
  intents: readonly IntentCatalogEntry[],
  intent: string | undefined,
): string {
  const intentId = resolveIntentId(intent);
  return (
    intents.find((entry) => entry.id.toLowerCase() === intentId)?.definition
      .domain ?? FALLBACK_INTENT.domain
  );
}

function normalizeKeywordForMatching(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

const normalizedFastpathKeywords = new WeakMap<
  IntentCatalogEntry,
  Array<{ normalized: string; keyword: string }>
>();
const HIGH_RISK_KEYWORDS_REGEX =
  /\b(delete|remove|rm|deploy|publish|production|prod|credential|token|secret|key)\b/i;

function getNormalizedFastpathKeywords(
  intent: IntentCatalogEntry,
): Array<{ normalized: string; keyword: string }> {
  const cached = normalizedFastpathKeywords.get(intent);
  if (cached) return cached;

  const keywords = intent.definition.fastpath.keywords.map((keyword) => ({
    normalized: normalizeKeywordForMatching(keyword),
    keyword: keyword.trim(),
  }));
  normalizedFastpathKeywords.set(intent, keywords);
  return keywords;
}

function findExactKeywordIntent(
  latest: string,
  intents: readonly IntentCatalogEntry[],
): { intent: IntentCatalogEntry; keyword: string; hint: string } | undefined {
  const normalizedLatest = normalizeKeywordForMatching(latest);
  if (!normalizedLatest) return;

  for (const intent of intents) {
    const hint = intent.definition.fastpath.hint;
    if (!hint) continue;

    for (const keyword of getNormalizedFastpathKeywords(intent)) {
      if (keyword.normalized === normalizedLatest) {
        return { intent, keyword: keyword.keyword, hint };
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
      for (const intentKeyword of getNormalizedFastpathKeywords(intent)) {
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

function getTopicContextReason(
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
): IntentionResult["topicChangeReason"] | "same-topic" | undefined {
  return (
    topicContext.reason ??
    (
      topicContext as {
        topicChangeReason?: IntentionResult["topicChangeReason"] | "same-topic";
      }
    ).topicChangeReason
  );
}

function isTopicContextChanged(
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
): boolean {
  return (
    topicContext.changed ??
    (topicContext as { topicChanged?: boolean }).topicChanged ??
    false
  );
}

function resolveTopicChangeReason(
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
): IntentionResult["topicChangeReason"] {
  const reason = getTopicContextReason(topicContext);
  return isTopicContextChanged(topicContext) && reason !== "same-topic"
    ? reason
    : undefined;
}

type PromptBuildClassification =
  | { kind: "same-topic"; result: IntentionResult }
  | { kind: "classified"; result: IntentionResult };

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
  const bundledSkillsDir = deps.bundledSkillsDir;

  function emitPipelineEvent(
    ctx: Pick<PluginHookAgentContext, "runId" | "sessionId">,
    sessionKey: string | undefined,
    phase: PipelinePhase,
    state: PipelineState,
    metadata: PipelineMetadata = {},
  ): void {
    const runId =
      ctx.runId?.trim() || sessionKey?.trim() || ctx.sessionId?.trim();
    if (!runId) {
      return;
    }

    try {
      emitHostAgentEvent({
        runId,
        sessionKey,
        stream: SKILL_HARNESS_EVENT_STREAM,
        data: cleanPipelineEventData({
          kind: SKILL_HARNESS_EVENT_KIND,
          phase,
          state,
          sessionKey,
          ...metadata,
        }),
      });
    } catch (err) {
      logger.warn("failed to emit skill-harness pipeline event", {
        phase,
        state,
        error: err,
      });
    }
  }

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
    refreshedConfig: ResolvedSkillHarnessPluginConfig,
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
      const topicChangeReason = resolveTopicChangeReason(topicContext);
      // Intent Classifier may override complexity; only use topicContext as fallback
      result.complexity = result.complexity ?? topicContext.complexity;
      // Intent Classifier may override keywords; only use topicContext as fallback
      const classifierKeywords = Array.isArray(result.keywords)
        ? result.keywords
        : undefined;
      result.keywords = classifierKeywords?.length
        ? classifierKeywords
        : [...topicContext.keywords];
      // Intent Classifier may override domain; only use topicContext as fallback
      const classifierDomain = result.domain?.trim();
      result.domain =
        classifierDomain || topicContext.domain || FALLBACK_INTENT.domain;
      result.topic = topicContext.topic;
      result.topicChangeReason = topicChangeReason;
      result.previousTopic = topicChangeReason
        ? latestHistoricalIntent?.topic
        : undefined;
    }
  }

  async function classifyPromptBuild(params: {
    ctx: PluginHookAgentContext;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    effectiveAgentId: string;
    resolvedSessionKey?: string;
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
    modelRef: { provider: string; model: string };
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
  }): Promise<PromptBuildClassification | undefined> {
    emitPipelineEvent(
      params.ctx,
      params.resolvedSessionKey,
      "topic-triage",
      "started",
    );
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
    emitPipelineEvent(
      params.ctx,
      params.resolvedSessionKey,
      "topic-triage",
      topicContext ? "completed" : "failed",
      topicContext
        ? {
            domain: topicContext.domain,
            keywords: topicContext.keywords,
            topic: topicContext.topic,
            changed: isTopicContextChanged(topicContext),
            reason: resolveTopicChangeReason(topicContext),
            complexity: topicContext.complexity,
          }
        : { error: "topic checker returned no context" },
    );

    const latestHistoricalIntent =
      params.historicalIntents[params.historicalIntents.length - 1];
    if (
      topicContext &&
      !isTopicContextChanged(topicContext) &&
      latestHistoricalIntent
    ) {
      return {
        kind: "same-topic",
        result: buildInheritedIntentResult(
          latestHistoricalIntent,
          topicContext,
        ),
      };
    }

    let result: IntentionResult | undefined;
    let topicKeywordSimilarityMatched = false;
    if (topicContext) {
      const topicKeywordSimilarityMatch = findTopicKeywordSimilarityIntent(
        params.latestUserMessage,
        topicContext.domain,
        topicContext.keywords,
        params.availableIntents,
      );
      if (topicKeywordSimilarityMatch) {
        const topicChangeReason = resolveTopicChangeReason(topicContext);
        topicKeywordSimilarityMatched = true;
        result = {
          intent: topicKeywordSimilarityMatch.intent.id,
          reason: `Topic keyword similarity match: ${topicKeywordSimilarityMatch.topicKeyword} -> ${topicKeywordSimilarityMatch.intentKeyword}`,
          keywords: [
            topicKeywordSimilarityMatch.topicKeyword,
            topicKeywordSimilarityMatch.intentKeyword,
          ],
          domain: topicContext.domain,
          topic: topicContext.topic,
          topicChangeReason,
          previousTopic: topicChangeReason
            ? latestHistoricalIntent?.topic
            : undefined,
          confidence: topicKeywordSimilarityMatch.score,
          complexity: topicContext.complexity,
        };
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "topic-triage",
          "completed",
          {
            domain: result.domain,
            keywords: result.keywords,
            topic: result.topic,
            changed: isTopicContextChanged(topicContext),
            reason: result.topicChangeReason,
            complexity: result.complexity,
          },
        );
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "intent-classify",
          "completed",
          {
            intent: result.intent,
            reason: result.reason,
            complexity: result.complexity,
            confidence: result.confidence,
          },
        );
      }
    }
    if (!result) {
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "intent-classify",
        "started",
      );
      result = await classifier({
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
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "intent-classify",
        result ? "completed" : "failed",
        result
          ? {
              intent: result.intent,
              reason: result.reason,
              complexity: result.complexity,
              confidence: result.confidence,
            }
          : { result: "classifier returned no result" },
      );
    }

    if (result) {
      if (!topicKeywordSimilarityMatched) {
        applyTopicContextToResult(result, topicContext, latestHistoricalIntent);
      }
      if (!topicContext) {
        result.domain = findIntentDomain(
          params.availableIntents,
          result.intent,
        );
      }
      return { kind: "classified", result };
    }
    return;
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
          ...(params.result.topicChangeReason
            ? { input: params.conversation }
            : {}),
          result: params.result,
          instructionText: params.instructionText,
        },
        timestamps: { start: new Date().toISOString() },
      },
    });
    tracker.write(params.sessionId);
  }

  function recordPromptBuildResult(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildRouting>>;
    latestUserMessage: string;
    result: IntentionResult;
    instructionText?: string;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): void {
    recordPromptBuildSession({
      sessionId: params.ctx.sessionId,
      resolvedSessionKey: params.routing.resolvedSessionKey,
      fallbackSessionKey: params.ctx.sessionKey,
      effectiveAgentId: params.routing.effectiveAgentId,
      latestUserMessage: params.latestUserMessage,
      result: params.result,
      instructionText: params.instructionText,
      conversation: params.conversation,
    });
  }

  async function resolvePromptDomainSkills(params: {
    agentId: string;
    domain: string;
    availableIntents: readonly IntentCatalogEntry[];
  }) {
    return await resolveDomainSkills({
      api,
      agentId: params.agentId,
      bundledSkillsDir,
      domain: params.domain,
      intents: params.availableIntents,
    });
  }

  function buildExactKeywordIntentResult(params: {
    exactKeywordMatch: NonNullable<ReturnType<typeof findExactKeywordIntent>>;
    latestHistoricalIntent?: HistoricalIntentRecord;
  }): IntentionResult {
    const sameIntent =
      resolveIntentId(params.latestHistoricalIntent?.intent) ===
      params.exactKeywordMatch.intent.id.toLowerCase();

    return {
      intent: params.exactKeywordMatch.intent.id,
      reason: `Exact keyword match: ${params.exactKeywordMatch.keyword}`,
      keywords: [params.exactKeywordMatch.keyword],
      domain: params.exactKeywordMatch.intent.definition.domain,
      topic: `Exact keyword match for ${params.exactKeywordMatch.intent.id}.`,
      previousTopic:
        params.latestHistoricalIntent && !sameIntent
          ? params.latestHistoricalIntent.topic
          : undefined,
      topicChangeReason: !params.latestHistoricalIntent
        ? "start"
        : sameIntent
          ? undefined
          : "match",
      confidence: 1,
      complexity: "low",
    };
  }

  async function handleExactKeywordPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildRouting>>;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
    exactKeywordMatch: NonNullable<ReturnType<typeof findExactKeywordIntent>>;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const latestHistoricalIntent =
      params.historicalIntents[params.historicalIntents.length - 1];
    const result = buildExactKeywordIntentResult({
      exactKeywordMatch: params.exactKeywordMatch,
      latestHistoricalIntent,
    });

    emitPipelineEvent(
      params.ctx,
      params.routing.resolvedSessionKey,
      "topic-triage",
      "completed",
      {
        domain: result.domain,
        keywords: result.keywords,
        topic: result.topic,
        changed: result.topicChangeReason !== undefined,
        reason: result.topicChangeReason,
        complexity: result.complexity,
      },
    );
    if (!params.refreshedConfig.instruction.enabled) {
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        result,
        conversation: params.conversation,
      });
      return {
        prependContext: buildDomainSkillsPromptPrefix(
          result,
          await resolvePromptDomainSkills({
            agentId: params.routing.effectiveAgentId,
            domain: result.domain,
            availableIntents: params.availableIntents,
          }),
        ),
      };
    }

    recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      result,
      instructionText: params.exactKeywordMatch.hint,
      conversation: params.conversation,
    });
    const promptPrefix = buildPromptPrefix(
      result,
      params.availableIntents,
      params.refreshedConfig,
      params.exactKeywordMatch.hint,
      await resolvePromptDomainSkills({
        agentId: params.routing.effectiveAgentId,
        domain: result.domain,
        availableIntents: params.availableIntents,
      }),
    );
    return promptPrefix ? { prependContext: promptPrefix } : undefined;
  }

  async function handleClassifiedPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildRouting>>;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
    classification: PromptBuildClassification;
    modelRef: NonNullable<ReturnType<typeof getModelRef>>;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const result = params.classification.result;
    logger.debug(`intention subagent result: ${JSON.stringify(result)}`);

    if (params.classification.kind === "same-topic") {
      logger.debug("topic unchanged; recording inherited intent only.");
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        result,
        conversation: params.conversation,
      });
      return {
        prependContext: buildDomainSkillsPromptPrefix(
          result,
          await resolvePromptDomainSkills({
            agentId: params.routing.effectiveAgentId,
            domain: result.domain,
            availableIntents: params.availableIntents,
          }),
        ),
      };
    }

    // Safety fallback: skip intent instruction subagent and hint injection when topic unchanged
    if (!result.topicChangeReason) {
      logger.debug(
        "topic unchanged; skipping intent instruction subagent and hint injection.",
      );
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        result,
        conversation: params.conversation,
      });
      return {
        prependContext: buildDomainSkillsPromptPrefix(
          result,
          await resolvePromptDomainSkills({
            agentId: params.routing.effectiveAgentId,
            domain: result.domain,
            availableIntents: params.availableIntents,
          }),
        ),
      };
    }

    // Skip intent instruction subagent when confidence is too low
    if ((result.confidence ?? 0) < 0.7) {
      logger.debug(
        `confidence ${result.confidence} below 0.7; skipping intent instruction subagent and hint injection.`,
      );
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        result,
        conversation: params.conversation,
      });
      return {
        prependContext: buildDomainSkillsPromptPrefix(
          result,
          await resolvePromptDomainSkills({
            agentId: params.routing.effectiveAgentId,
            domain: result.domain,
            availableIntents: params.availableIntents,
          }),
        ),
      };
    }

    if (!params.refreshedConfig.instruction.enabled) {
      logger.debug(
        "instruction writer disabled; injecting domain skills without generated hint.",
      );
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        result,
        conversation: params.conversation,
      });
      return {
        prependContext: buildDomainSkillsPromptPrefix(
          result,
          await resolvePromptDomainSkills({
            agentId: params.routing.effectiveAgentId,
            domain: result.domain,
            availableIntents: params.availableIntents,
          }),
        ),
      };
    }

    const instructionModelRef = getInstructionModelRef(
      api,
      params.routing.effectiveAgentId,
      params.refreshedConfig,
      {
        modelProviderId: params.ctx.modelProviderId,
        modelId: params.ctx.modelId,
      },
    );
    if (!instructionModelRef) return;

    emitPipelineEvent(
      params.ctx,
      params.routing.resolvedSessionKey,
      "hint-generate",
      "started",
    );
    const intentBody = findIntentBody(params.availableIntents, result.intent);
    const instructionResult = await instructionWriter({
      api,
      config: params.refreshedConfig,
      agentId: params.routing.effectiveAgentId,
      sessionKey: params.routing.resolvedSessionKey,
      sessionId: params.ctx.sessionId,
      conversation: params.conversation,
      latest: params.latestUserMessage,
      result,
      intentBody,
      availableSkills: await resolveAvailableSkills({
        api,
        agentId: params.routing.effectiveAgentId,
        bundledSkillsDir,
        intentBody,
      }),
      messageProvider: params.ctx.messageProvider,
      modelRef: instructionModelRef,
    });
    const instructionText = instructionResult.text;
    if (instructionText) {
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "hint-generate",
        "completed",
        {
          result: instructionText,
        },
      );
    } else {
      const instructionError =
        instructionResult.error ?? "instruction writer produced no text";
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "hint-generate",
        "failed",
        {
          reason: instructionError,
          error: instructionError,
        },
      );
    }

    recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      result,
      instructionText,
      conversation: params.conversation,
    });

    const promptPrefix = buildPromptPrefix(
      result,
      params.availableIntents,
      params.refreshedConfig,
      instructionText,
      await resolvePromptDomainSkills({
        agentId: params.routing.effectiveAgentId,
        domain: result.domain,
        availableIntents: params.availableIntents,
      }),
    );
    return promptPrefix ? { prependContext: promptPrefix } : undefined;
  }

  async function onBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    let resolvedSessionKey = ctx.sessionKey;
    try {
      // Early return checks FIRST (before refresh calls)
      if (shouldSkipIntentAnalysis(ctx)) return;
      if (isInternalUserTurn(event)) return;

      const routing = resolvePromptBuildRouting(ctx);
      if (!routing) return;
      resolvedSessionKey = routing.resolvedSessionKey ?? resolvedSessionKey;

      // THEN refresh config and intents
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      if (shouldSkipAllForLowThinking(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking mode is off; skipping intention scan for low reasoning effort.",
        );
        return;
      }
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
        return handleExactKeywordPromptBuild({
          ctx,
          routing,
          refreshedConfig,
          latestUserMessage,
          historicalIntents,
          conversation,
          availableIntents,
          exactKeywordMatch,
        });
      }

      if (shouldUseDeterministicLowThinkingMode(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking fastpath-only mode found no exact keyword match; skipping LLM-based intent analysis.",
        );
        return;
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

      const classification = await classifyPromptBuild({
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

      if (!classification) {
        logger.debug("intention subagent failed; skipping hint injection.");
        return;
      }

      return await handleClassifiedPromptBuild({
        ctx,
        routing,
        refreshedConfig,
        latestUserMessage,
        conversation,
        availableIntents,
        classification,
        modelRef,
      });
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

  function recordAgentEndResult(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): void {
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
  }

  function recordAgentEndStats(sessionId: string) {
    const state = tracker.getCurrentState(sessionId);
    if (!state) return;

    const intentDefinition = findIntentDefinition(
      catalog,
      state.intent?.result?.intent,
    );
    statsAggregator.record(sessionId, state, intentDefinition);
    return { intentDefinition };
  }

  async function buildEvolutionReviewSnapshot(
    baseSnapshot: NonNullable<ReturnType<typeof tracker.getReviewSnapshot>>,
    intentDefinition: ReturnType<typeof findIntentDefinition>,
    agentId: string,
  ) {
    return {
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
      availableSkills: intentDefinition
        ? await resolveAvailableSkills({
            api,
            agentId,
            bundledSkillsDir,
            intentBody: intentDefinition.definition.prompt,
          })
        : [],
      intentCatalog: catalog.get().map((entry) => ({
        id: entry.id,
        triggers: [...entry.definition.triggers],
        examples: [...entry.definition.examples],
        domain: entry.definition.domain,
        fastpath: {
          keywords: [...(entry.definition.fastpath?.keywords ?? [])],
          hint: entry.definition.fastpath?.hint,
        },
      })),
    };
  }

  function enqueueEvolutionReview(params: {
    ctx: PluginHookAgentContext;
    resolvedConfig: ResolvedSkillHarnessPluginConfig;
    agentId: string;
    modelRef: NonNullable<ReturnType<typeof getReviewModelRef>>;
    snapshot: Awaited<ReturnType<typeof buildEvolutionReviewSnapshot>>;
    triggers: ReturnType<typeof checkEvolutionTriggers>;
  }): void {
    reviewQueue.enqueue(async () => {
      const reviewResult = await reviewer({
        api,
        config: params.resolvedConfig,
        agentId: params.agentId,
        sessionKey: params.ctx.sessionKey ?? params.snapshot.sessionKey,
        messageProvider: params.ctx.messageProvider,
        modelRef: params.modelRef,
        snapshot: params.snapshot,
        triggers: params.triggers,
      });
      if (!reviewResult) return;
      const findings = Array.isArray(reviewResult)
        ? reviewResult
        : reviewResult.findings;
      const outcome = Array.isArray(reviewResult)
        ? findings.length > 0
          ? "wrote-items"
          : "nofinding"
        : reviewResult.outcome;
      const noFindingReasonCounts = Array.isArray(reviewResult)
        ? undefined
        : reviewResult.noFindingReasonCounts;
      const schemaRejectionReasonCounts = Array.isArray(reviewResult)
        ? undefined
        : reviewResult.schemaRejectionReasonCounts;
      await backlogWriter.record(
        params.snapshot.eventId,
        {
          sessionId: params.snapshot.sessionId,
          sessionKey: params.snapshot.sessionKey,
          agentId: params.snapshot.agentId,
          turnStart: params.snapshot.current.timestamps!.start!,
        },
        findings,
        {
          triggers: params.triggers,
          outcome,
          noFindingReasonCounts,
          schemaRejectionReasonCounts,
        },
      );
    });
  }

  async function onAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    recordAgentEndResult(event, ctx);

    if (!ctx.sessionId) return;
    const agentEndStats = recordAgentEndStats(ctx.sessionId);
    if (!agentEndStats) return;

    const resolvedConfig = config();
    const evolutionConfig = resolvedConfig.evolution;
    if (!evolutionConfig.enabled) return;
    const baseSnapshot = tracker.getReviewSnapshot(ctx.sessionId);
    if (!baseSnapshot) return;
    const agentId = ctx.agentId ?? baseSnapshot.agentId ?? "main";
    const snapshot = await buildEvolutionReviewSnapshot(
      baseSnapshot,
      agentEndStats.intentDefinition,
      agentId,
    );
    const triggers = checkEvolutionTriggers(
      snapshot.current,
      snapshot.turnNumber,
      evolutionConfig.triggers,
      readTriggerKeywordsFailOpen(deps.triggerKeywords),
    );
    if (triggers.length === 0) return;

    const modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
      modelProviderId: ctx.modelProviderId,
      modelId: ctx.modelId,
    });
    if (!modelRef) return;

    enqueueEvolutionReview({
      ctx,
      resolvedConfig,
      agentId,
      modelRef,
      snapshot,
      triggers,
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
