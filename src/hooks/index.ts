import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookAfterToolCallEvent,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforeToolCallEvent,
  PluginHookSessionEndEvent,
  PluginHookSessionContext,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
} from "openclaw/plugin-sdk/types";
import { logger } from "../../api.js";
import { defaultCatalog } from "../intents/index.js";
import { defaultTracker, extractSkillInfo } from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { defaultReviewLogWriter } from "../review/log-writer.js";
import { enqueueReview } from "../review/queue.js";
import { checkReviewTriggers, type ReviewTrigger } from "../review/triggers.js";
import { runReviewSubagent } from "../review/subagent.js";
import type {
  IntentMarkdownReviewFinding,
  TriggerKeywordsReviewFinding,
} from "../review/types.js";
import type { SkillPlacementReviewCandidate } from "../review/types.js";
import {
  DEFAULT_REVIEW_TRIGGER_KEYWORDS,
  type ReviewTriggerKeywords,
  type TriggerKeywordTarget,
} from "../review/trigger-keywords.js";
import {
  discoverKeywordCoverageCandidates,
  runKeywordCoverageReview,
} from "../review/index.js";
import { createHash } from "node:crypto";
import {
  extractLatestUserMessage,
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
  attachHistoricalIntents,
  sanitizeHistoricalIntentInput,
  projectIntentCandidates,
  measureIntentCatalogCodePoints,
  type IntentProjection,
} from "../classification/index.js";
import {
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  resolveStatusUpdateAgentId,
  shouldSkipIntentAnalysis,
  shouldSkipSkillSystemContext,
  resolveCanonicalSessionKeyFromSessionId,
} from "../session/index.js";
import {
  getInstructionModelRef,
  getModelRef,
  getReviewModelRef,
  runIntentInstructionSubagent,
  runIntentionSubagent,
  runTopicSwitchSubagent,
} from "../classification/index.js";
import {
  buildDomainSkillsPromptPrefix,
  buildPromptPrefix,
} from "../classification/index.js";
import {
  resolveAvailableSkills,
  resolveAvailableSkillsWithRelated,
  resolveDomainSkills,
  resolveSkillInventory,
} from "../intents/index.js";
import { FALLBACK_INTENT, isIntentComplexity } from "../constants.js";
import { intentsPath } from "../file-utils.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentProjectionTelemetry,
  IntentTrigger,
  IntentionResult,
} from "../types.js";
import { emitPipelineEvent } from "./pipeline-events.js";
import type { HookDeps, PendingToolCall } from "./types.js";
import {
  isToolResultError,
  resolveToolCallKey,
  resolveToolResultText,
} from "./tool-tracking.js";
import { SKILL_HARNESS_SYSTEM_CONTEXT } from "./system-context.js";
export type { HookDeps } from "./types.js";

function sanitizeHistoricalIntentRecords(
  records: HistoricalIntentRecord[],
): HistoricalIntentRecord[] {
  return records.flatMap((record) => {
    const input = sanitizeHistoricalIntentInput(record.input);
    return input ? [{ ...record, input }] : [];
  });
}

const LOW_THINKING_EFFORTS = new Set(["off", "minimal", "low"]);
const INSTRUCTION_WRITER_MIN_CONFIDENCE = 0.8;
const TOPIC_PROJECTION_CONFIDENCE = 0.8;
const MAX_PROJECTION_CANDIDATE_IDS = 128;
const MAX_PROJECTION_MATCHED_KEYWORDS = 32;
const MAX_PROJECTION_KEYWORD_CHARS = 200;

function measureProjectionCatalogs(
  originalIntents: readonly IntentCatalogEntry[],
  candidateIntents: readonly IntentCatalogEntry[],
): Pick<
  IntentProjectionTelemetry,
  "originalCatalogCodePoints" | "candidateCatalogCodePoints"
> {
  try {
    return {
      originalCatalogCodePoints:
        measureIntentCatalogCodePoints(originalIntents),
      candidateCatalogCodePoints:
        measureIntentCatalogCodePoints(candidateIntents),
    };
  } catch (error) {
    logger.warn("failed to measure intent projection catalogs", { error });
    return {};
  }
}

function toIntentProjectionTelemetry(params: {
  projection: IntentProjection;
  originalIntents: readonly IntentCatalogEntry[];
  durationMs: number;
}): IntentProjectionTelemetry {
  const { projection, originalIntents, durationMs } = params;
  return {
    decision: projection.decision,
    effectiveInput: projection.decision,
    ...(projection.fallbackReason
      ? { fallbackReason: projection.fallbackReason }
      : {}),
    originalIntentCount: projection.originalIntentCount,
    candidateIntentCount: projection.candidateIntentCount,
    ...measureProjectionCatalogs(originalIntents, projection.candidateIntents),
    durationMs,
    candidateIntentIds: projection.candidateIntents
      .slice(0, MAX_PROJECTION_CANDIDATE_IDS)
      .map((intent) => intent.id),
    candidateSelections: projection.candidateSelections
      .slice(0, MAX_PROJECTION_CANDIDATE_IDS)
      .map((selection) => ({
        intentId: selection.intentId,
        selectionReasons: [...selection.selectionReasons],
        matchedKeywords: selection.matchedKeywords
          .slice(0, MAX_PROJECTION_MATCHED_KEYWORDS)
          .map((keyword) => keyword.slice(0, MAX_PROJECTION_KEYWORD_CHARS)),
      })),
    supportReasons: [...projection.supportReasons],
    selectionReasons: [...projection.selectionReasons],
    matchedKeywords: projection.matchedKeywords
      .slice(0, MAX_PROJECTION_MATCHED_KEYWORDS)
      .map((keyword) => keyword.slice(0, MAX_PROJECTION_KEYWORD_CHARS)),
  };
}

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

function readTriggerKeywordsFailOpen(
  reader?: () => ReviewTriggerKeywords,
): ReviewTriggerKeywords {
  if (!reader) return DEFAULT_REVIEW_TRIGGER_KEYWORDS;
  try {
    return reader();
  } catch (error) {
    logger.warn("failed to read review trigger keywords", { error });
    return DEFAULT_REVIEW_TRIGGER_KEYWORDS;
  }
}

function recordTrackedSession(
  tracker: typeof defaultTracker,
  context: { sessionId?: string; sessionKey?: string },
  data: Parameters<typeof defaultTracker.record>[1],
): string | undefined {
  const sessionId = tracker.resolveCurrentSessionId(context);
  if (!sessionId) return;

  tracker.record(sessionId, data);
  tracker.write(sessionId);
  return sessionId;
}

function toPromptBuildResult(
  prependContext?: string,
): PluginHookBeforePromptBuildResult {
  return {
    ...(prependContext ? { prependContext } : {}),
    appendSystemContext: SKILL_HARNESS_SYSTEM_CONTEXT,
  };
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

function findIntentEntry<
  T extends { id: string; definition: { prompt: string; skills?: string[] } },
>(intents: readonly T[], intent: string | undefined): T | undefined {
  const intentId = intent?.match(/^([A-Za-z0-9_-]+)/)?.[1];
  if (!intentId) return;
  return intents.find(
    (entry) => entry.id.toLowerCase() === intentId.toLowerCase(),
  );
}

function buildInheritedIntentResult(
  latest: HistoricalIntentRecord,
  topicContext: NonNullable<Awaited<ReturnType<typeof runTopicSwitchSubagent>>>,
  domain: string,
): IntentionResult {
  return {
    intent: latest.intent,
    reason: "Topic unchanged; inherited previous intent",
    keywords: [...topicContext.keywords],
    domain,
    topic: topicContext.topic,
    confidence: latest.confidence ?? 0.8,
  };
}

const TOPIC_CONTINUITY_INHERIT_CONFIDENCE = 0.8;

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
  | {
      kind: "same-topic";
      trigger: IntentTrigger;
      result: IntentionResult;
      intentProjection?: undefined;
    }
  | {
      kind: "classified";
      trigger: IntentTrigger;
      result: IntentionResult;
      intentProjection?: IntentProjectionTelemetry;
    };

export function createHookHandlers(deps: HookDeps) {
  const { api, config, refreshLiveConfigFromRuntime, refreshIntents } = deps;
  const catalog = deps.catalog ?? defaultCatalog;
  const tracker = deps.tracker ?? defaultTracker;
  const statsAggregator = deps.statsAggregator ?? defaultStatsAggregator;
  const skillInventoryResolver =
    deps.skillInventoryResolver ?? resolveSkillInventory;
  const enqueueReviewTask = deps.reviewQueue?.enqueue ?? enqueueReview;
  const reviewer = deps.reviewer ?? runReviewSubagent;
  const classifier = deps.classifier ?? runIntentionSubagent;
  const topicChecker = deps.topicChecker ?? runTopicSwitchSubagent;
  const instructionWriter =
    deps.instructionWriter ?? runIntentInstructionSubagent;
  const reviewLogWriter = deps.reviewLogWriter ?? defaultReviewLogWriter;
  const coverageReviewer = deps.coverageReviewer ?? runKeywordCoverageReview;
  const keywordCoverageWriter = deps.keywordCoverageWriter;
  const bundledSkillsDir = deps.bundledSkillsDir;
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const recordedToolCalls = new Set<string>();
  const pendingSkillEpochKeys = new Set<string>();
  const pendingCoverageEpochKeys = new Set<string>();
  const COVERAGE_TARGETS: readonly TriggerKeywordTarget[] = [
    "successful-pattern",
    "behavior-fix",
    "entity-context",
  ];

  function resolvePromptBuildScope(
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

  function resolveTrackingContext(ctx: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
  }): { sessionId?: string; sessionKey?: string } {
    const sessionKey =
      ctx.sessionKey?.trim() ||
      (ctx.agentId
        ? resolveCanonicalSessionKeyFromSessionId({
            api,
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
          })
        : undefined);

    return { sessionId: ctx.sessionId, sessionKey };
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
    const latestUserMessage = extractLatestUserMessage(
      event.messages,
      event.prompt,
    );
    const historicalIntents = sanitizeHistoricalIntentRecords(
      ctx.sessionId ? tracker.getHistoricalIntentRecords(ctx.sessionId) : [],
    );
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
      dataRoot: deps.dataRoot,
    });
    emitPipelineEvent(
      params.ctx,
      params.resolvedSessionKey,
      "topic-triage",
      topicContext ? "completed" : "failed",
      topicContext
        ? {
            basis: topicContext.basis,
            domain: topicContext.domain,
            keywords: topicContext.keywords,
            topic: topicContext.topic,
            changed: isTopicContextChanged(topicContext),
            reason: resolveTopicChangeReason(topicContext),
            confidence: topicContext.confidence,
          }
        : { error: "topic checker returned no context" },
    );

    const latestHistoricalIntent =
      params.historicalIntents[params.historicalIntents.length - 1];
    const isSameTopic =
      topicContext !== undefined &&
      !isTopicContextChanged(topicContext) &&
      getTopicContextReason(topicContext) === "same-topic";
    if (
      isSameTopic &&
      topicContext.confidence >= TOPIC_CONTINUITY_INHERIT_CONFIDENCE &&
      latestHistoricalIntent
    ) {
      return {
        kind: "same-topic",
        trigger: "same-topic",
        result: buildInheritedIntentResult(
          latestHistoricalIntent,
          topicContext,
          findIntentDomain(
            params.availableIntents,
            latestHistoricalIntent.intent,
          ),
        ),
      };
    }

    let result: IntentionResult | undefined;
    let topicKeywordSimilarityMatched = false;
    if (
      topicContext &&
      topicContext.confidence >= TOPIC_PROJECTION_CONFIDENCE &&
      !isSameTopic
    ) {
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
        };
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "topic-triage",
          "completed",
          {
            basis: topicContext.basis,
            domain: result.domain,
            keywords: result.keywords,
            topic: result.topic,
            changed: isTopicContextChanged(topicContext),
            reason: result.topicChangeReason,
            confidence: topicContext.confidence,
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
            ...(isIntentComplexity(result.complexity)
              ? { complexity: result.complexity }
              : {}),
            confidence: result.confidence,
          },
        );
      }
    }
    let intentProjection: IntentProjectionTelemetry | undefined;
    if (!result) {
      const projectionStartedAtMs = Date.now();
      let projection: IntentProjection;
      try {
        projection = projectIntentCandidates({
          intents: params.availableIntents,
          latest: params.latestUserMessage,
          topicContext,
          latestHistoricalIntent,
        });
      } catch (error) {
        logger.warn("intent candidate projection failed; using full catalog", {
          error,
        });
        projection = {
          decision: "full-fallback",
          originalIntentCount: params.availableIntents.length,
          candidateIntentCount: params.availableIntents.length,
          effectiveIntents: [...params.availableIntents],
          candidateIntents: [...params.availableIntents],
          projected: false,
          supportReasons: [],
          selectionReasons: [],
          candidateSelections: [],
          matchedKeywords: [],
          fallbackReason: "selector-error",
        };
      }
      intentProjection = toIntentProjectionTelemetry({
        projection,
        originalIntents: params.availableIntents,
        durationMs: Math.max(0, Date.now() - projectionStartedAtMs),
      });
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "intent-classify",
        "started",
      );
      try {
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
          intents: projection.effectiveIntents,
          topicContext: topicContext ?? undefined,
          dataRoot: deps.dataRoot,
        });
      } catch (error) {
        recordPromptBuildSession({
          sessionId: params.ctx.sessionId,
          resolvedSessionKey: params.resolvedSessionKey,
          fallbackSessionKey: params.ctx.sessionKey,
          effectiveAgentId: params.effectiveAgentId,
          latestUserMessage: params.latestUserMessage,
          trigger: "classifier",
          intentProjection,
          conversation: params.conversation,
        });
        throw error;
      }
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "intent-classify",
        result ? "completed" : "failed",
        result
          ? {
              intent: result.intent,
              reason: result.reason,
              ...(isIntentComplexity(result.complexity)
                ? { complexity: result.complexity }
                : {}),
              confidence: result.confidence,
            }
          : { error: "classifier returned no result" },
      );
      if (!result) {
        recordPromptBuildSession({
          sessionId: params.ctx.sessionId,
          resolvedSessionKey: params.resolvedSessionKey,
          fallbackSessionKey: params.ctx.sessionKey,
          effectiveAgentId: params.effectiveAgentId,
          latestUserMessage: params.latestUserMessage,
          trigger: "classifier",
          intentProjection,
          conversation: params.conversation,
        });
      }
    }

    if (result) {
      const trigger: IntentTrigger = topicKeywordSimilarityMatched
        ? "topic-keyword-similarity"
        : "classifier";
      if (!topicKeywordSimilarityMatched) {
        applyTopicContextToResult(result, topicContext, latestHistoricalIntent);
      }
      result.domain = findIntentDomain(params.availableIntents, result.intent);
      return { kind: "classified", trigger, result, intentProjection };
    }
    return;
  }

  function recordPromptBuildSession(params: {
    sessionId?: string;
    resolvedSessionKey?: string;
    fallbackSessionKey?: string;
    effectiveAgentId: string;
    latestUserMessage: string;
    trigger: IntentTrigger;
    result?: IntentionResult;
    instructionText?: string;
    recommendedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): void {
    const sessionKey = params.resolvedSessionKey ?? params.fallbackSessionKey;
    const sessionId =
      params.sessionId ?? tracker.resolveCurrentSessionId({ sessionKey });
    if (!sessionId) return;

    tracker.rotate(sessionId);
    tracker.record(sessionId, {
      sessionKey,
      agentId: params.effectiveAgentId,
      current: {
        input: params.latestUserMessage,
        intent: {
          ...(params.result?.topicChangeReason
            ? { input: params.conversation }
            : {}),
          trigger: params.trigger,
          ...(params.result ? { result: params.result } : {}),
          instructionText: params.instructionText,
          recommendedSkills: params.recommendedSkills,
          ...(params.intentProjection
            ? { intentProjection: params.intentProjection }
            : {}),
        },
        timestamps: { start: new Date().toISOString() },
      },
    });
    tracker.write(sessionId);
  }

  function recordPromptBuildResult(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildScope>>;
    latestUserMessage: string;
    trigger: IntentTrigger;
    result: IntentionResult;
    instructionText?: string;
    recommendedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): void {
    recordPromptBuildSession({
      sessionId: params.ctx.sessionId,
      resolvedSessionKey: params.routing.resolvedSessionKey,
      fallbackSessionKey: params.ctx.sessionKey,
      effectiveAgentId: params.routing.effectiveAgentId,
      latestUserMessage: params.latestUserMessage,
      trigger: params.trigger,
      result: params.result,
      instructionText: params.instructionText,
      recommendedSkills: params.recommendedSkills,
      intentProjection: params.intentProjection,
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
    };
  }

  async function handleExactKeywordPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildScope>>;
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
      },
    );
    if (!params.refreshedConfig.instruction.enabled) {
      const domainSkills = await resolvePromptDomainSkills({
        agentId: params.routing.effectiveAgentId,
        domain: result.domain,
        availableIntents: params.availableIntents,
      });
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        trigger: "exact-keyword",
        result,
        recommendedSkills: domainSkills.map((skill) => skill.name),
        conversation: params.conversation,
      });
      return toPromptBuildResult(
        buildDomainSkillsPromptPrefix(result, domainSkills),
      );
    }

    const domainSkills = await resolvePromptDomainSkills({
      agentId: params.routing.effectiveAgentId,
      domain: result.domain,
      availableIntents: params.availableIntents,
    });
    recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      trigger: "exact-keyword",
      result,
      instructionText: params.exactKeywordMatch.hint,
      recommendedSkills: domainSkills.map((skill) => skill.name),
      conversation: params.conversation,
    });
    const promptPrefix = buildPromptPrefix(
      result,
      params.availableIntents,
      params.refreshedConfig,
      params.exactKeywordMatch.hint,
      domainSkills,
    );
    return toPromptBuildResult(promptPrefix);
  }

  async function handleClassifiedPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: NonNullable<ReturnType<typeof resolvePromptBuildScope>>;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
    classification: PromptBuildClassification;
    modelRef: NonNullable<ReturnType<typeof getModelRef>>;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const result = params.classification.result;
    logger.debug(`intention subagent result: ${JSON.stringify(result)}`);

    const recordAndReturnDomainSkillsPrefix = async () => {
      const domainSkills = await resolvePromptDomainSkills({
        agentId: params.routing.effectiveAgentId,
        domain: result.domain,
        availableIntents: params.availableIntents,
      });
      recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        trigger: params.classification.trigger,
        result,
        recommendedSkills: domainSkills.map((skill) => skill.name),
        intentProjection: params.classification.intentProjection,
        conversation: params.conversation,
      });
      return toPromptBuildResult(
        buildDomainSkillsPromptPrefix(result, domainSkills),
      );
    };

    if (params.classification.kind === "same-topic") {
      logger.debug("topic unchanged; recording inherited intent only.");
      return await recordAndReturnDomainSkillsPrefix();
    }

    // Safety fallback: skip intent instruction subagent and hint injection when topic unchanged
    if (!result.topicChangeReason) {
      logger.debug(
        "topic unchanged; skipping intent instruction subagent and hint injection.",
      );
      return await recordAndReturnDomainSkillsPrefix();
    }

    // Skip intent instruction subagent when confidence is too low
    if ((result.confidence ?? 0) < INSTRUCTION_WRITER_MIN_CONFIDENCE) {
      logger.debug(
        `confidence ${result.confidence} below ${INSTRUCTION_WRITER_MIN_CONFIDENCE}; skipping intent instruction subagent and hint injection.`,
      );
      return await recordAndReturnDomainSkillsPrefix();
    }

    if (!params.refreshedConfig.instruction.enabled) {
      logger.debug(
        "instruction writer disabled; injecting domain skills without generated hint.",
      );
      return await recordAndReturnDomainSkillsPrefix();
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
    if (!instructionModelRef) {
      logger.debug(
        "instruction writer model unavailable; injecting domain skills without generated hint.",
      );
      return await recordAndReturnDomainSkillsPrefix();
    }

    emitPipelineEvent(
      params.ctx,
      params.routing.resolvedSessionKey,
      "hint-generate",
      "started",
    );
    const intentEntry = findIntentEntry(params.availableIntents, result.intent);
    const intentBody = intentEntry?.definition.prompt ?? FALLBACK_INTENT.prompt;
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
      availableSkills: await resolveAvailableSkillsWithRelated({
        api,
        agentId: params.routing.effectiveAgentId,
        bundledSkillsDir,
        skillNames: intentEntry?.definition.skills,
      }),
      messageProvider: params.ctx.messageProvider,
      modelRef: instructionModelRef,
      dataRoot: deps.dataRoot,
    });
    const instructionText = instructionResult.instructionHint ?? undefined;
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
    } else if (instructionResult.instructionHint === null) {
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "hint-generate",
        "completed",
      );
    } else {
      const instructionError =
        instructionResult.error?.trim() ||
        "instruction writer produced invalid JSON";
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "hint-generate",
        "failed",
        {
          error: instructionError,
        },
      );
    }

    const domainSkills = await resolvePromptDomainSkills({
      agentId: params.routing.effectiveAgentId,
      domain: result.domain,
      availableIntents: params.availableIntents,
    });
    const additionalSkills = instructionResult.additionalCandidateSkills?.length
      ? await resolveAvailableSkills({
          api,
          agentId: params.routing.effectiveAgentId,
          bundledSkillsDir,
          skillNames: instructionResult.additionalCandidateSkills,
        })
      : [];
    const seenSkillNames = new Set(
      domainSkills.map((skill) => skill.name.toLowerCase()),
    );
    for (const skill of additionalSkills) {
      const normalizedName = skill.name.toLowerCase();
      if (seenSkillNames.has(normalizedName)) continue;
      seenSkillNames.add(normalizedName);
      domainSkills.push(skill);
    }

    recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      trigger: params.classification.trigger,
      result,
      instructionText,
      recommendedSkills: domainSkills.map((skill) => skill.name),
      intentProjection: params.classification.intentProjection,
      conversation: params.conversation,
    });

    const promptPrefix = buildPromptPrefix(
      result,
      params.availableIntents,
      params.refreshedConfig,
      instructionResult.instructionHint,
      domainSkills,
    );
    return toPromptBuildResult(promptPrefix);
  }

  async function runPromptBuildPipeline<T>(
    ctx: PluginHookAgentContext,
    sessionKey: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAtMs = Date.now();
    emitPipelineEvent(ctx, sessionKey, "pipeline", "started");
    try {
      const result = await operation();
      emitPipelineEvent(ctx, sessionKey, "pipeline", "completed", {
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
      return result;
    } catch (error) {
      emitPipelineEvent(ctx, sessionKey, "pipeline", "failed", {
        error: "skill-harness pipeline execution failed",
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
      throw error;
    }
  }

  async function onBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    let resolvedSessionKey = ctx.sessionKey;
    let staticContextEligible = false;
    try {
      const routing = resolvePromptBuildScope(ctx);
      if (!routing) return;
      resolvedSessionKey = routing.resolvedSessionKey ?? resolvedSessionKey;

      const resolvedContext = {
        ...ctx,
        sessionKey: resolvedSessionKey,
      };
      if (shouldSkipSkillSystemContext(resolvedContext)) return;

      staticContextEligible = true;
      if (shouldSkipIntentAnalysis(resolvedContext)) {
        return toPromptBuildResult();
      }
      if (isInternalUserTurn(event)) return toPromptBuildResult();
      if (!isEligibleInteractiveSession(resolvedContext)) {
        return toPromptBuildResult();
      }

      // THEN refresh config and intents
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      if (shouldSkipAllForLowThinking(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking mode is off; skipping intention scan for low reasoning effort.",
        );
        return toPromptBuildResult();
      }
      const { latestUserMessage, historicalIntents, conversation } =
        buildConversationContext(event, ctx, refreshedConfig);

      refreshIntents();
      if (catalog.count === 0) {
        logger.debug("no intents loaded; skipping intention scan.");
        return toPromptBuildResult();
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
        return await runPromptBuildPipeline(
          ctx,
          routing.resolvedSessionKey,
          () =>
            handleExactKeywordPromptBuild({
              ctx,
              routing,
              refreshedConfig,
              latestUserMessage,
              historicalIntents,
              conversation,
              availableIntents,
              exactKeywordMatch,
            }),
        );
      }

      if (shouldUseDeterministicLowThinkingMode(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking fastpath-only mode found no exact keyword match; skipping LLM-based intent analysis.",
        );
        return toPromptBuildResult();
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
      if (!modelRef) return toPromptBuildResult();

      return await runPromptBuildPipeline(
        ctx,
        routing.resolvedSessionKey,
        async () => {
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
            return toPromptBuildResult();
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
        },
      );
    } catch (err) {
      logger.warn("before_prompt_build hook error", { error: err });
      return staticContextEligible ? toPromptBuildResult() : undefined;
    }
  }

  async function onAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: { sessionId?: string; agentId?: string; sessionKey?: string },
  ): Promise<void> {
    const toolCallKey = resolveToolCallKey({
      toolCallId: event.toolCallId,
      runId: event.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (toolCallKey && recordedToolCalls.has(toolCallKey)) {
      recordedToolCalls.delete(toolCallKey);
      pendingToolCalls.delete(toolCallKey);
      return;
    }
    const failed =
      event.error !== undefined ||
      isToolResultError(event.result, event.toolName);
    const output = event.error ?? event.result ?? "";
    const outputStr =
      typeof output === "string" ? output : extractToolText(output);
    const truncatedOutput = outputStr.slice(0, 200);
    const skillUsed = failed
      ? undefined
      : extractSkillInfo(event.toolName, event.params, outputStr);

    recordTrackedSession(tracker, resolveTrackingContext(ctx), {
      current: {
        toolCalls: [
          {
            name: event.toolName,
            params: event.params,
            result: failed ? undefined : truncatedOutput,
            error: failed ? truncatedOutput : undefined,
            success: !failed,
            durationMs: event.durationMs,
          },
        ],
        skillsUsed: skillUsed ? [skillUsed] : undefined,
      },
    });
    if (toolCallKey) {
      recordedToolCalls.add(toolCallKey);
      pendingToolCalls.delete(toolCallKey);
    }
  }

  async function onBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    const toolCallKey = resolveToolCallKey({
      toolCallId: event.toolCallId,
      runId: event.runId ?? ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!toolCallKey) return;
    pendingToolCalls.set(toolCallKey, {
      name: event.toolName,
      params: event.params,
      ctx,
    });
  }

  function onToolResultPersist(
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ): void {
    const toolCallKey = resolveToolCallKey({
      toolCallId: event.toolCallId ?? ctx.toolCallId,
      sessionKey: ctx.sessionKey,
    });
    if (toolCallKey && recordedToolCalls.has(toolCallKey)) {
      recordedToolCalls.delete(toolCallKey);
      return;
    }

    const pending = toolCallKey ? pendingToolCalls.get(toolCallKey) : undefined;
    const toolName = event.toolName ?? ctx.toolName ?? pending?.name;
    if (!toolName) return;

    const outputStr = resolveToolResultText(event.message);
    const truncatedOutput = outputStr.slice(0, 200);
    const failed = isToolResultError(event.message, toolName);
    const error = failed ? truncatedOutput : undefined;
    const params = pending?.params ?? {};
    const trackingCtx = resolveTrackingContext({
      ...pending?.ctx,
      agentId: ctx.agentId ?? pending?.ctx.agentId,
      sessionKey: ctx.sessionKey ?? pending?.ctx.sessionKey,
    });
    const skillUsed = error
      ? undefined
      : extractSkillInfo(toolName, params, outputStr);

    recordTrackedSession(tracker, trackingCtx, {
      current: {
        toolCalls: [
          {
            name: toolName,
            params,
            result: failed ? undefined : truncatedOutput,
            error,
            success: !failed,
          },
        ],
        skillsUsed: skillUsed ? [skillUsed] : undefined,
      },
    });

    if (toolCallKey) {
      recordedToolCalls.add(toolCallKey);
      pendingToolCalls.delete(toolCallKey);
    }
  }

  function recordFinalResult(
    params: {
      messages?: unknown[];
      lastAssistantMessage?: string;
      error?: string;
    },
    ctx: PluginHookAgentContext,
  ): string | undefined {
    const turns = extractRecentTurns(
      (params.messages ?? []) as Array<{
        role?: string;
        content?: string;
      }>,
    );
    const lastAssistantTurn = turns
      .slice()
      .reverse()
      .find((t) => t.role === "assistant");

    return recordTrackedSession(tracker, resolveTrackingContext(ctx), {
      current: {
        result: lastAssistantTurn?.text ?? params.lastAssistantMessage,
        error: params.error,
        timestamps: { end: new Date().toISOString() },
      },
    });
  }

  async function recordAgentEndStats(sessionId: string) {
    const state = tracker.getCurrentState(sessionId);
    if (!state) return;

    const intentDefinition = findIntentDefinition(
      catalog,
      state.intent?.result?.intent,
    );
    const agentId = tracker.getAgentId(sessionId)?.trim();
    if (agentId && !statsAggregator.isRecordable(sessionId, state)) return;
    let skillInventory:
      | {
          agentId: string;
          skills: NonNullable<
            Awaited<ReturnType<typeof resolveSkillInventory>>
          >;
        }
      | undefined;
    if (agentId) {
      try {
        const skills = await skillInventoryResolver({
          api,
          agentId,
          bundledSkillsDir,
        });
        if (skills) skillInventory = { agentId, skills };
      } catch (error) {
        logger.warn("failed to resolve skill inventory for stats", { error });
      }
    }
    const recorded = skillInventory
      ? statsAggregator.record(sessionId, state, intentDefinition, {
          skillInventory,
        })
      : statsAggregator.record(sessionId, state, intentDefinition);
    if (!recorded) return;
    return {
      intentDefinition,
      agentId,
      skillInventoryObserved: skillInventory !== undefined,
    };
  }

  async function buildReviewSnapshot(
    baseSnapshot: NonNullable<ReturnType<typeof tracker.getReviewSnapshot>>,
    intentDefinition: ReturnType<typeof findIntentDefinition>,
    agentId: string,
    skillPlacementCandidate?: SkillPlacementReviewCandidate,
  ) {
    const availableSkillNames = [
      ...(intentDefinition?.definition.skills ?? []),
      ...(skillPlacementCandidate ? [skillPlacementCandidate.name] : []),
    ];
    return {
      ...baseSnapshot,
      ...(skillPlacementCandidate ? { agentId } : {}),
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
      availableSkills:
        availableSkillNames.length > 0
          ? await resolveAvailableSkills({
              api,
              agentId,
              bundledSkillsDir,
              skillNames: [...new Set(availableSkillNames)],
            })
          : [],
      ...(skillPlacementCandidate ? { skillPlacementCandidate } : {}),
      intentCatalog: catalog.get().map((entry) => ({
        id: entry.id,
        triggers: [...entry.definition.triggers],
        examples: [...entry.definition.examples],
        domain: entry.definition.domain,
        skills: [...(entry.definition.skills ?? [])],
        fastpath: {
          keywords: [...(entry.definition.fastpath?.keywords ?? [])],
          hint: entry.definition.fastpath?.hint,
        },
        ...(entry.definition.candidate
          ? {
              candidate: {
                ...entry.definition.candidate,
                ...(entry.definition.candidate.keywords
                  ? { keywords: [...entry.definition.candidate.keywords] }
                  : {}),
              },
            }
          : {}),
      })),
    };
  }

  function enqueueReviewRun(params: {
    ctx: PluginHookAgentContext;
    resolvedConfig: ResolvedSkillHarnessPluginConfig;
    agentId: string;
    modelRef: NonNullable<ReturnType<typeof getReviewModelRef>>;
    snapshot: Awaited<ReturnType<typeof buildReviewSnapshot>>;
    triggers: readonly ReviewTrigger[];
    skillPlacementCandidate?: SkillPlacementReviewCandidate;
  }): boolean {
    try {
      enqueueReviewTask(async () => {
        try {
          const reviewResult = await reviewer({
            api,
            config: params.resolvedConfig,
            agentId: params.agentId,
            intentDirectory: intentsPath(deps.dataRoot ?? "."),
            sessionKey: params.ctx.sessionKey ?? params.snapshot.sessionKey,
            messageProvider: params.ctx.messageProvider,
            modelRef: params.modelRef,
            snapshot: params.snapshot,
            triggers: params.triggers,
            dataRoot: deps.dataRoot,
          });
          if (!reviewResult) return;
          const keywordWriter = deps.keywordCoverageWriter;
          if (!keywordWriter) {
            // Backward compatibility: v5 path unchanged
            await reviewLogWriter.record(
              params.snapshot.eventId,
              {
                sessionId: params.snapshot.sessionId,
                sessionKey: params.snapshot.sessionKey,
                agentId: params.snapshot.agentId,
                turnStart: params.snapshot.current.timestamps!.start!,
              },
              reviewResult.findings,
              {
                triggers: params.triggers,
                outcome: reviewResult.outcome,
                changedIntentIds: reviewResult.changedIntentIds,
                validationErrors: reviewResult.validationErrors,
                noFindingReasonCounts: reviewResult.noFindingReasonCounts,
                schemaRejectionReasonCounts:
                  reviewResult.schemaRejectionReasonCounts,
                skillPlacementCandidate: params.skillPlacementCandidate,
              },
            );
          } else {
            // Split findings by targetKind
            const keywordFindings = reviewResult.findings.filter(
              (f): f is TriggerKeywordsReviewFinding =>
                f.targetKind === "trigger-keywords",
            );
            const intentFindings = reviewResult.findings.filter(
              (f): f is IntentMarkdownReviewFinding =>
                f.targetKind === "intent-markdown",
            );

            if (keywordFindings.length > 0) {
              // Only record keyword events for successful outcomes
              if (
                reviewResult.outcome === "applied" ||
                reviewResult.outcome === "nofinding"
              ) {
                await keywordWriter.recordKeywordEvent({
                  eventId: params.snapshot.eventId,
                  policy: "ordinary",
                  targets: [
                    ...new Set(keywordFindings.map((f) => f.targetTrigger)),
                  ],
                  mutations: keywordFindings.map((f) => ({
                    target: f.targetTrigger,
                    add: f.addKeywords,
                    remove: f.removeKeywords,
                  })),
                  outcome: reviewResult.outcome,
                });
                deps.refreshTriggerKeywords?.();
              }
            }

            await reviewLogWriter.record(
              params.snapshot.eventId,
              {
                sessionId: params.snapshot.sessionId,
                sessionKey: params.snapshot.sessionKey,
                agentId: params.snapshot.agentId,
                turnStart: params.snapshot.current.timestamps!.start!,
              },
              intentFindings,
              {
                triggers: params.triggers,
                outcome: reviewResult.outcome,
                changedIntentIds: reviewResult.changedIntentIds,
                validationErrors: reviewResult.validationErrors,
                noFindingReasonCounts: reviewResult.noFindingReasonCounts,
                schemaRejectionReasonCounts:
                  reviewResult.schemaRejectionReasonCounts,
                skillPlacementCandidate: params.skillPlacementCandidate,
              },
            );
          }
          if (reviewResult.changedIntentIds?.length) {
            deps.refreshIntents();
          }
        } finally {
          if (params.skillPlacementCandidate) {
            pendingSkillEpochKeys.delete(
              params.skillPlacementCandidate.epochKey,
            );
          }
        }
      });
      return true;
    } catch (error) {
      logger.warn("failed to enqueue Intent Review", { error });
      return false;
    }
  }

  function buildCoverageEpochKey(params: {
    acceptedTurn: number;
    cadence: number;
    keywordFingerprint: string;
  }): string {
    return createHash("sha256")
      .update(
        `coverage:${params.cadence}:${params.acceptedTurn}:${params.keywordFingerprint}`,
      )
      .digest("hex");
  }

  function fingerprintKeywords(keywords: ReviewTriggerKeywords): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          successfulPattern: keywords.successfulPattern,
          behaviorFix: keywords.behaviorFix,
          entityContext: keywords.entityContext,
        }),
      )
      .digest("hex");
  }

  function readCoverageCursors(
    runtimeTargets:
      | Partial<
          Record<
            TriggerKeywordTarget,
            { cursor: number; lastCompletedAcceptedTurn: number }
          >
        >
      | undefined,
  ): Record<TriggerKeywordTarget, number> {
    return {
      "successful-pattern": runtimeTargets?.["successful-pattern"]?.cursor ?? 0,
      "behavior-fix": runtimeTargets?.["behavior-fix"]?.cursor ?? 0,
      "entity-context": runtimeTargets?.["entity-context"]?.cursor ?? 0,
    };
  }

  function coverageWatermarkEligible(params: {
    acceptedTurn: number;
    cadence: number;
    runtimeTargets:
      | Partial<
          Record<
            TriggerKeywordTarget,
            { cursor: number; lastCompletedAcceptedTurn: number }
          >
        >
      | undefined;
  }): boolean {
    if (params.acceptedTurn < params.cadence) return false;
    const lastCompleted = Math.max(
      0,
      ...COVERAGE_TARGETS.map(
        (target) =>
          params.runtimeTargets?.[target]?.lastCompletedAcceptedTurn ?? 0,
      ),
    );
    if (params.acceptedTurn % params.cadence === 0) {
      return params.acceptedTurn >= lastCompleted + params.cadence;
    }
    // A released/failed first epoch is retried every five accepted turns.
    if (lastCompleted === 0 && params.acceptedTurn % 5 === 0) return true;
    // Require full cadence progress after the last completed epoch.
    return params.acceptedTurn >= lastCompleted + params.cadence;
  }

  function enqueueKeywordCoverageRun(params: {
    ctx: PluginHookAgentContext;
    resolvedConfig: ResolvedSkillHarnessPluginConfig;
    agentId: string;
    modelRef: NonNullable<ReturnType<typeof getReviewModelRef>>;
    acceptedTurn: number;
    epochKey: string;
  }): boolean {
    if (!keywordCoverageWriter || !deps.dataRoot) return false;
    try {
      enqueueReviewTask(async () => {
        try {
          const runtimeState = keywordCoverageWriter.readRuntimeState();
          if (!runtimeState) {
            await keywordCoverageWriter.releaseCoverageEpoch({
              epochKey: params.epochKey,
            });
            return;
          }

          const triggerKeywords =
            runtimeState.triggerKeywords ??
            readTriggerKeywordsFailOpen(deps.triggerKeywords);
          const cursor = readCoverageCursors(runtimeState.targets);
          const sessions =
            typeof tracker.listRetainedSessions === "function"
              ? tracker.listRetainedSessions()
              : [];
          const discovery = discoverKeywordCoverageCandidates({
            sessions,
            config: params.resolvedConfig.review.triggers,
            triggerKeywords,
            cursor,
          });

          const removalDocuments = COVERAGE_TARGETS.flatMap(
            (target) => discovery.removals[target] ?? [],
          );
          const documents =
            removalDocuments.length > 0
              ? removalDocuments
              : COVERAGE_TARGETS.flatMap(
                  (target) => discovery.additions[target] ?? [],
                );
          if (documents.length === 0) {
            await keywordCoverageWriter.completeCoverageEpoch({
              epochKey: params.epochKey,
              outcome: "nofinding",
              nextCursors: discovery.nextCursor,
            });
            return;
          }

          const reviewResult = await coverageReviewer({
            api,
            dataRoot: deps.dataRoot!,
            agentId: params.agentId,
            sessionId: params.ctx.sessionId,
            sessionKey: params.ctx.sessionKey,
            messageProvider: params.ctx.messageProvider,
            triggerKeywords,
            documents,
            cursor,
            config: {
              model: params.modelRef.model,
              modelFallback:
                params.resolvedConfig.review.modelFallback ??
                params.resolvedConfig.modelFallback,
              thinking: params.resolvedConfig.review.thinking,
              timeoutMs: params.resolvedConfig.review.timeoutMs,
            },
            modelRef: params.modelRef,
            pluginConfig: params.resolvedConfig,
          });

          if (!reviewResult) {
            await keywordCoverageWriter.releaseCoverageEpoch({
              epochKey: params.epochKey,
            });
            return;
          }

          const mutations = reviewResult.decisions
            .filter((decision) => decision.outcome === "finding")
            .map((decision) => ({
              target: decision.target,
              add: decision.addition ? [decision.addition.phrase] : [],
              remove: decision.removal ? [decision.removal.phrase] : [],
            }))
            .filter(
              (mutation) =>
                mutation.add.length > 0 || mutation.remove.length > 0,
            );

          const outcome = mutations.length > 0 ? "applied" : "nofinding";
          if (mutations.length > 0) {
            const writeResult = await keywordCoverageWriter.recordKeywordEvent({
              eventId: `coverage:${params.epochKey}`,
              policy: "coverage",
              targets: mutations.map((mutation) => mutation.target),
              mutations,
              outcome: "applied",
            });
            if (writeResult === "retryable-failure") {
              await keywordCoverageWriter.releaseCoverageEpoch({
                epochKey: params.epochKey,
              });
              return;
            }
            deps.refreshTriggerKeywords?.();
          }

          const completeResult =
            await keywordCoverageWriter.completeCoverageEpoch({
              epochKey: params.epochKey,
              outcome,
              nextCursors: discovery.nextCursor,
            });
          if (completeResult === "retryable-failure") {
            await keywordCoverageWriter.releaseCoverageEpoch({
              epochKey: params.epochKey,
            });
          }
        } catch (error) {
          logger.warn("keyword coverage epoch failed", { error });
          try {
            await keywordCoverageWriter.releaseCoverageEpoch({
              epochKey: params.epochKey,
            });
          } catch (releaseError) {
            logger.warn("failed to release keyword coverage epoch", {
              error: releaseError,
            });
          }
        } finally {
          pendingCoverageEpochKeys.delete(params.epochKey);
        }
      });
      return true;
    } catch (error) {
      logger.warn("failed to enqueue keyword coverage", { error });
      return false;
    }
  }

  async function maybeEnqueueKeywordCoverage(params: {
    ctx: PluginHookAgentContext;
    resolvedConfig: ResolvedSkillHarnessPluginConfig;
    acceptedTurn: number;
  }): Promise<void> {
    if (!keywordCoverageWriter || !deps.dataRoot) return;
    if (!params.resolvedConfig.review.enabled) return;

    try {
      const cadence =
        params.resolvedConfig.review.keywordCoverage.everyAcceptedTurns;
      const runtimeState = keywordCoverageWriter.readRuntimeState();
      if (!runtimeState) return;
      if (
        !coverageWatermarkEligible({
          acceptedTurn: params.acceptedTurn,
          cadence,
          runtimeTargets: runtimeState.targets,
        })
      ) {
        return;
      }

      const keywordFingerprint = fingerprintKeywords(
        runtimeState.triggerKeywords,
      );
      const epochKey = buildCoverageEpochKey({
        acceptedTurn: params.acceptedTurn,
        cadence,
        keywordFingerprint,
      });
      if (pendingCoverageEpochKeys.has(epochKey)) return;

      const agentId = params.ctx.agentId ?? "main";
      const modelRef = getReviewModelRef(api, agentId, params.resolvedConfig, {
        modelProviderId: params.ctx.modelProviderId,
        modelId: params.ctx.modelId,
      });
      if (!modelRef) return;

      const reserved = await keywordCoverageWriter.reserveCoverageEpoch({
        epochKey,
        targets: COVERAGE_TARGETS,
        acceptedTurn: params.acceptedTurn,
      });
      if (reserved !== "applied") return;

      pendingCoverageEpochKeys.add(epochKey);
      const enqueued = enqueueKeywordCoverageRun({
        ctx: params.ctx,
        resolvedConfig: params.resolvedConfig,
        agentId,
        modelRef,
        acceptedTurn: params.acceptedTurn,
        epochKey,
      });
      if (!enqueued) {
        pendingCoverageEpochKeys.delete(epochKey);
        await keywordCoverageWriter.releaseCoverageEpoch({ epochKey });
      }
    } catch (error) {
      logger.warn("failed to schedule keyword coverage", { error });
    }
  }

  async function finalizeTrackedTurn(
    trackedSessionId: string | undefined,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    if (!trackedSessionId) return;
    const agentEndStats = await recordAgentEndStats(trackedSessionId);
    if (!agentEndStats) return;

    const resolvedConfig = config();
    const reviewConfig = resolvedConfig.review;
    if (!reviewConfig.enabled) return;

    try {
      const acceptedTurn = statsAggregator.getAcceptedTurnCount?.();
      if (typeof acceptedTurn === "number") {
        await maybeEnqueueKeywordCoverage({
          ctx,
          resolvedConfig,
          acceptedTurn,
        });
      }
    } catch (error) {
      logger.warn("failed to evaluate keyword coverage schedule", { error });
    }

    const baseSnapshot = tracker.getReviewSnapshot(trackedSessionId);
    if (!baseSnapshot) return;
    const triggers: ReviewTrigger[] = checkReviewTriggers(
      baseSnapshot.current,
      baseSnapshot.turnNumber,
      reviewConfig.triggers,
      readTriggerKeywordsFailOpen(deps.triggerKeywords),
    );
    let skillPlacementCandidate: SkillPlacementReviewCandidate | undefined;
    let ownsReservation = false;
    try {
      if (
        reviewConfig.triggers.skillPlacement.enabled &&
        agentEndStats.agentId &&
        agentEndStats.skillInventoryObserved
      ) {
        const completedEpochKeys = reviewLogWriter.completedSkillEpochKeys?.();
        if (completedEpochKeys) {
          const excludedEpochKeys = new Set([
            ...completedEpochKeys,
            ...pendingSkillEpochKeys,
          ]);
          const selected = statsAggregator.selectSkillPlacementCandidate(
            agentEndStats.agentId,
            excludedEpochKeys,
          );
          if (selected) {
            pendingSkillEpochKeys.add(selected.epochKey);
            ownsReservation = true;
            const canonicalName = selected.name.trim().toLowerCase();
            skillPlacementCandidate = {
              ...selected,
              currentlyReferencedIntentIds: catalog
                .get()
                .filter((entry) =>
                  (entry.definition.skills ?? []).some(
                    (name) => name.trim().toLowerCase() === canonicalName,
                  ),
                )
                .map((entry) => entry.id),
            };
            triggers.push("skill-placement");
          }
        }
      }
      if (triggers.length === 0) return;

      let agentId = skillPlacementCandidate
        ? agentEndStats.agentId!
        : (ctx.agentId ?? baseSnapshot.agentId ?? "main");
      let modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
        modelProviderId: ctx.modelProviderId,
        modelId: ctx.modelId,
      });
      if (!modelRef) return;
      let snapshot = await buildReviewSnapshot(
        baseSnapshot,
        agentEndStats.intentDefinition,
        agentId,
        skillPlacementCandidate,
      );
      const placementSkillName = skillPlacementCandidate?.name
        .trim()
        .toLowerCase();
      if (
        placementSkillName &&
        !snapshot.availableSkills.some(
          (skill) => skill.name.trim().toLowerCase() === placementSkillName,
        )
      ) {
        pendingSkillEpochKeys.delete(skillPlacementCandidate!.epochKey);
        ownsReservation = false;
        skillPlacementCandidate = undefined;
        const placementTriggerIndex = triggers.indexOf("skill-placement");
        if (placementTriggerIndex >= 0)
          triggers.splice(placementTriggerIndex, 1);
        if (triggers.length === 0) return;

        agentId = ctx.agentId ?? baseSnapshot.agentId ?? "main";
        modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
          modelProviderId: ctx.modelProviderId,
          modelId: ctx.modelId,
        });
        if (!modelRef) return;
        snapshot = await buildReviewSnapshot(
          baseSnapshot,
          agentEndStats.intentDefinition,
          agentId,
          undefined,
        );
      }

      const enqueued = enqueueReviewRun({
        ctx,
        resolvedConfig,
        agentId,
        modelRef,
        snapshot,
        triggers,
        skillPlacementCandidate,
      });
      if (enqueued) ownsReservation = false;
    } catch (error) {
      logger.warn("failed to prepare Intent Review", { error });
    } finally {
      if (ownsReservation && skillPlacementCandidate) {
        pendingSkillEpochKeys.delete(skillPlacementCandidate.epochKey);
      }
    }
  }

  async function onAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    const trackedSessionId = recordFinalResult(
      { messages: event.messages, error: event.error },
      ctx,
    );
    await finalizeTrackedTurn(trackedSessionId, ctx);
  }

  async function onBeforeAgentFinalize(
    event: PluginHookBeforeAgentFinalizeEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentFinalizeResult | void> {
    const trackingCtx: PluginHookAgentContext = {
      ...ctx,
      sessionId: event.sessionId ?? ctx.sessionId,
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      modelId: event.model ?? ctx.modelId,
    };
    const trackedSessionId = recordFinalResult(
      {
        messages: event.messages,
        lastAssistantMessage: event.lastAssistantMessage,
      },
      trackingCtx,
    );
    await finalizeTrackedTurn(trackedSessionId, trackingCtx);
    return;
  }

  async function onSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    tracker.cleanup(ctx.sessionId, {
      deleteFile: false,
    });
    tracker.cleanupExpired();
  }

  return {
    onBeforePromptBuild,
    onBeforeToolCall,
    onAfterToolCall,
    onToolResultPersist,
    onBeforeAgentFinalize,
    onAgentEnd,
    onSessionEnd,
  };
}
