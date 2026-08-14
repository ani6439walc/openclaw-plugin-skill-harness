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
import {
  defaultTracker,
  extractSkillInfo,
  resolveTurnEventId,
  type SessionState,
} from "../session/index.js";
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
  getModelRef,
  getReviewModelRef,
  runIntentionSubagent,
  runTopicSwitchSubagent,
} from "../classification/index.js";
import {
  buildRoutingContext,
  formatConfiguredSkills,
} from "../classification/index.js";
import {
  listAvailableSkills,
  resolveAvailableSkills,
  resolveSkillInventory,
} from "../intents/index.js";
import { FALLBACK_INTENT, isIntentComplexity } from "../constants.js";
import { intentsPath } from "../file-utils.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import {
  evaluateCurationCadence,
  reconcileCurationSchedules,
  runCurationSubagent,
  sampleWithoutReplacement,
  selectColdStartCandidates,
  validateAndCommitCuration,
  type CuratedSkillCandidate,
} from "../curation/index.js";
import type { AvailableSkill } from "../skills/types.js";
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
  TurnAssociationRegistry,
  type TurnAssociation,
} from "./turn-associations.js";
import { ToolFallbackRegistry } from "./tool-fallback-registry.js";
import {
  isToolResultError,
  resolveToolCallKey,
  resolveToolResultText,
} from "./tool-tracking.js";
import {
  SKILL_HARNESS_INTENT_CONTEXT,
  SKILL_HARNESS_SYSTEM_CONTEXT,
} from "./system-context.js";
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

const TOPIC_PROJECTION_CONFIDENCE = 0.8;
const MAX_PROJECTION_CANDIDATE_IDS = 128;
const MAX_PROJECTION_MATCHED_KEYWORDS = 32;
const MAX_PROJECTION_KEYWORD_CHARS = 200;
const KEYWORD_COVERAGE_TARGETS: readonly TriggerKeywordTarget[] = [
  "successful-pattern",
  "behavior-fix",
  "entity-context",
];
const KEYWORD_COVERAGE_RETRY_INTERVAL = 5;

type CoverageRuntimeTargets = Partial<
  Record<
    TriggerKeywordTarget,
    { cursor: number; lastCompletedAcceptedTurn: number }
  >
>;

export function coverageEpochMilestone(params: {
  cadence: number;
  runtimeTargets: CoverageRuntimeTargets | undefined;
}): number {
  return (
    Math.max(
      0,
      ...KEYWORD_COVERAGE_TARGETS.map(
        (target) =>
          params.runtimeTargets?.[target]?.lastCompletedAcceptedTurn ?? 0,
      ),
    ) + params.cadence
  );
}

export function coverageWatermarkEligible(params: {
  acceptedTurn: number;
  cadence: number;
  runtimeTargets: CoverageRuntimeTargets | undefined;
}): boolean {
  const milestone = coverageEpochMilestone(params);
  if (params.acceptedTurn < milestone) return false;
  return (
    params.acceptedTurn === milestone ||
    (params.acceptedTurn - milestone) % KEYWORD_COVERAGE_RETRY_INTERVAL === 0
  );
}

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

function toPromptBuildResult(
  prependContext?: string,
  configuredSkillsXml?: string,
  includeIntentContext = true,
): PluginHookBeforePromptBuildResult {
  const systemContext = includeIntentContext
    ? `${SKILL_HARNESS_SYSTEM_CONTEXT}\n\n${SKILL_HARNESS_INTENT_CONTEXT}`
    : SKILL_HARNESS_SYSTEM_CONTEXT;
  const appendSystemContext = configuredSkillsXml
    ? `${systemContext}\n\n${configuredSkillsXml}`
    : systemContext;
  return {
    ...(prependContext ? { prependContext } : {}),
    appendSystemContext,
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
  T extends { id: string; definition: { guidance: string; skills?: string[] } },
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
): { intent: IntentCatalogEntry; keyword: string } | undefined {
  const normalizedLatest = normalizeKeywordForMatching(latest);
  if (!normalizedLatest) return;

  for (const intent of intents) {
    for (const keyword of getNormalizedFastpathKeywords(intent)) {
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
  const curator = deps.curator ?? runCurationSubagent;
  const clock = deps.clock ?? (() => new Date());
  const chooseWithoutReplacement =
    deps.sampleWithoutReplacement ?? sampleWithoutReplacement;
  const experienceCatalog =
    deps.experienceCatalog ??
    (deps.dataRoot ? SkillExperienceCatalog.create(deps.dataRoot) : undefined);

  const reviewLogWriter: NonNullable<HookDeps["reviewLogWriter"]> =
    deps.reviewLogWriter ?? defaultReviewLogWriter;
  const coverageReviewer = deps.coverageReviewer ?? runKeywordCoverageReview;
  const keywordCoverageWriter = deps.keywordCoverageWriter;
  const bundledSkillsDir = deps.bundledSkillsDir;
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const toolFallbacks = deps.toolFallbacks ?? new ToolFallbackRegistry();
  const recordedToolCalls = new Set<string>();
  const pendingSkillEpochKeys = new Set<string>();
  const pendingCoverageEpochKeys = new Set<string>();
  const turnAssociations =
    deps.turnAssociations ?? new TurnAssociationRegistry();

  interface PromptBuildIdentity {
    effectiveAgentId: string;
    resolvedSessionKey?: string;
    association?: TurnAssociation;
  }

  function resolvePromptBuildIdentity(
    ctx: PluginHookAgentContext,
  ): PromptBuildIdentity {
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

    return { effectiveAgentId: resolvedAgentId, resolvedSessionKey };
  }

  async function prepareTrackingTurn(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    latestUserMessage: string;
  }): Promise<TurnAssociation | undefined> {
    const sessionId =
      params.ctx.sessionId ??
      tracker.resolveCurrentSessionId({
        sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
      });
    if (!sessionId) return;
    const runId = params.ctx.runId?.trim();
    const reservation = runId
      ? turnAssociations.reserve(runId)
      : turnAssociations.reserveAnonymous();
    if (reservation.status === "full" || reservation.status === "ambiguous") {
      return;
    }
    if (reservation.status === "invalid") return;
    if (reservation.status === "existing") {
      if (reservation.association.sessionId !== sessionId) {
        turnAssociations.bindExisting(runId, {
          sessionId,
          turnKey: reservation.association.turnKey,
        });
        return;
      }
      return reservation.association;
    }

    const prepared = await tracker.preparePromptTurn({
      sessionId,
      sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
      agentId: params.routing.effectiveAgentId,
      runId,
      input: params.latestUserMessage,
      startedAt: new Date().toISOString(),
    });
    if (prepared.status === "retryable-failure") {
      if (reservation.status === "reserved") {
        turnAssociations.release(reservation.token);
      }
      return;
    }
    const association = {
      sessionId,
      sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
      turnKey: prepared.identity.turnKey,
    };
    const bound =
      reservation.status === "reserved"
        ? runId
          ? turnAssociations.bind(reservation.token, runId, association)
          : turnAssociations.bindAnonymous(reservation.token, association)
        : turnAssociations.bindExisting(runId, association);
    return bound === "bound" ? association : undefined;
  }

  function resolveAssociatedTurn(params: {
    eventRunId?: string;
    contextRunId?: string;
    sessionId?: string;
    sessionKey?: string;
  }): TurnAssociation | undefined {
    const eventRunId = params.eventRunId?.trim();
    const contextRunId = params.contextRunId?.trim();
    if (eventRunId && contextRunId && eventRunId !== contextRunId) return;
    const runId = eventRunId || contextRunId;
    const association = runId
      ? turnAssociations.resolve(runId)
      : turnAssociations.resolveSession(params.sessionId ?? params.sessionKey);
    if (
      !association ||
      (params.sessionId && association.sessionId !== params.sessionId) ||
      (params.sessionKey && association.sessionKey !== params.sessionKey)
    ) {
      return;
    }
    return association;
  }

  function isPromptBuildChatAllowed(
    ctx: PluginHookAgentContext,
    resolvedSessionKey?: string,
  ): boolean {
    const currentConfig = config();
    const resolvedSessionKeyForChecks = resolvedSessionKey ?? ctx.sessionKey;
    if (
      !isAllowedChatType(currentConfig, {
        ...ctx,
        sessionKey: resolvedSessionKeyForChecks,
        mainKey: api.config.session?.mainKey,
      })
    ) {
      return false;
    }
    if (
      !isAllowedChatId(currentConfig, {
        sessionKey: resolvedSessionKeyForChecks,
        messageProvider: ctx.messageProvider,
      })
    ) {
      return false;
    }
    return true;
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
    association?: TurnAssociation;
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
        await recordPromptBuildSession({
          association: params.association,
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
        await recordPromptBuildSession({
          association: params.association,
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

  async function recordPromptBuildSession(params: {
    association?: TurnAssociation;
    latestUserMessage: string;
    trigger: IntentTrigger;
    result?: IntentionResult;
    recommendedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): Promise<void> {
    if (!params.association) return;
    await tracker.mergeTurnAndPersist({
      sessionId: params.association.sessionId,
      expectedTurnKey: params.association.turnKey,
      maxWaitMs: 0,
      data: {
        input: params.latestUserMessage,
        intent: {
          ...(params.result?.topicChangeReason
            ? { input: params.conversation }
            : {}),
          trigger: params.trigger,
          ...(params.result ? { result: params.result } : {}),
          recommendedSkills: params.recommendedSkills,
          ...(params.intentProjection
            ? { intentProjection: params.intentProjection }
            : {}),
        },
      },
    });
  }

  async function recordPromptBuildResult(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    latestUserMessage: string;
    trigger: IntentTrigger;
    result: IntentionResult;
    recommendedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): Promise<void> {
    await recordPromptBuildSession({
      association: params.routing.association,
      latestUserMessage: params.latestUserMessage,
      trigger: params.trigger,
      result: params.result,
      recommendedSkills: params.recommendedSkills,
      intentProjection: params.intentProjection,
      conversation: params.conversation,
    });
  }

  async function resolveRoutingContext(params: {
    routing: PromptBuildIdentity;
    result: IntentionResult;
    intent: IntentCatalogEntry;
  }): Promise<{
    candidates: AvailableSkill[];
    provenance: CuratedSkillCandidate[];
    experiences: ReturnType<SkillExperienceCatalog["listForSkills"]>;
    durable: boolean;
  }> {
    const directSkills = await resolveAvailableSkills({
      api,
      agentId: params.routing.effectiveAgentId,
      bundledSkillsDir,
      skillNames: params.intent.definition.skills ?? [],
    });
    const selection = selectColdStartCandidates({
      agentId: params.routing.effectiveAgentId,
      intentId: params.intent.id,
      declaredSkillNames: params.intent.definition.skills ?? [],
      inventory: directSkills,
      sessions: tracker.listRetainedSessions(),
      nowMs: clock().getTime(),
      retentionMs: 14 * 24 * 60 * 60 * 1_000,
      sampleWithoutReplacement: chooseWithoutReplacement,
    });
    const fallback = selection.ranked.slice(0, 4);
    const resolveCandidates = async (
      candidates: readonly CuratedSkillCandidate[],
    ): Promise<AvailableSkill[]> => {
      const resolved = await resolveAvailableSkills({
        api,
        agentId: params.routing.effectiveAgentId,
        bundledSkillsDir,
        skillNames: candidates.map((candidate) => candidate.name),
      });
      const byIdentity = new Map(
        resolved.map((skill) => [skill.name.trim().toLowerCase(), skill]),
      );
      return candidates.flatMap((candidate) => {
        const skill = byIdentity.get(candidate.name.trim().toLowerCase());
        return skill ? [skill] : [];
      });
    };
    const fallbackCandidates = await resolveCandidates(fallback);
    const association = params.routing.association;
    if (!association) {
      return {
        candidates: fallbackCandidates,
        provenance: fallback,
        experiences: [],
        durable: false,
      };
    }
    const coldStart = await tracker.ensureColdStart({
      sessionId: association.sessionId,
      turnKey: association.turnKey,
      intentId: params.intent.id,
      topicChangeReason: params.result.topicChangeReason,
      trustworthySameTopic:
        params.result.topicChangeReason === undefined &&
        (params.result.confidence ?? 0) >= TOPIC_CONTINUITY_INHERIT_CONFIDENCE,
      trustworthyTopicEvidence:
        (params.result.confidence ?? 0) >= TOPIC_CONTINUITY_INHERIT_CONFIDENCE,
      draftCandidates: selection.selected,
      now: clock().toISOString(),
    });
    if (coldStart.status !== "applied" && coldStart.status !== "reused") {
      return {
        candidates: fallbackCandidates,
        provenance: fallback,
        experiences: [],
        durable: false,
      };
    }
    const provenance = coldStart.curation.candidates;
    const candidates = await resolveCandidates(provenance);
    const candidateNames = candidates.map((candidate) => candidate.name);
    const experiences = experienceCatalog
      ? coldStart.curation.experienceRefs.flatMap((identity) => {
          const experience = experienceCatalog.resolve(identity);
          return experience &&
            candidateNames.some(
              (name) => name.trim().toLowerCase() === experience.skill,
            )
            ? [experience]
            : [];
        })
      : [];
    const committed = await tracker.commitPromptRecommendation({
      sessionId: association.sessionId,
      turnKey: association.turnKey,
      expectedTopicEpoch: coldStart.curation.topicEpoch,
      expectedRevision: coldStart.curation.revision,
      recommendedSkills: candidateNames,
      recommendationState: {
        topicEpoch: coldStart.curation.topicEpoch,
        curationRevision: coldStart.curation.revision,
        candidates: provenance,
      },
    });
    if (committed !== "applied") {
      return {
        candidates: fallbackCandidates,
        provenance: fallback,
        experiences: [],
        durable: false,
      };
    }
    return { candidates, provenance, experiences, durable: true };
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

  async function resolveConfiguredSkillsXml(
    agentId: string,
  ): Promise<string | undefined> {
    try {
      let configuredSkillNames: string[] = [];
      if (deps.getConfiguredAgentSkills) {
        try {
          configuredSkillNames = await deps.getConfiguredAgentSkills(agentId);
        } catch (error) {
          logger.warn("failed to retrieve configured agent skill names", {
            agentId,
            error,
          });
        }
      }

      let explicitSkills: Awaited<ReturnType<typeof resolveAvailableSkills>> =
        [];
      try {
        explicitSkills = await resolveAvailableSkills({
          api,
          agentId,
          bundledSkillsDir,
          skillNames: configuredSkillNames,
        });
      } catch (error) {
        logger.warn("failed to resolve explicitly configured agent skills", {
          agentId,
          configuredSkillNames,
          error,
        });
      }

      let workspaceSkills: Awaited<ReturnType<typeof listAvailableSkills>> = [];
      try {
        workspaceSkills = await listAvailableSkills({
          api,
          agentId,
          bundledSkillsDir,
          source: "workspace",
          usageStats: {},
        });
      } catch (error) {
        logger.warn("failed to resolve workspace agent skills", {
          agentId,
          error,
        });
      }

      const skills = [...explicitSkills];
      const seen = new Set(
        explicitSkills.map((skill) => skill.name.trim().toLowerCase()),
      );
      for (const skill of workspaceSkills) {
        const normalizedName = skill.name.trim().toLowerCase();
        if (seen.has(normalizedName)) continue;
        skills.push(skill);
        seen.add(normalizedName);
      }
      if (!skills.length) {
        logger.info(
          "no configured or workspace agent skills could be resolved",
          { agentId, configuredSkillNames },
        );
        return undefined;
      }
      logger.info(
        "resolved configured and workspace agent skills for prompt build",
        {
          agentId,
          configuredSkillNames,
          workspaceSkills: workspaceSkills.map((skill) => skill.name),
          resolvedSkills: skills.map((s) => s.name),
        },
      );
      return formatConfiguredSkills(skills);
    } catch (error) {
      logger.warn(
        "failed to resolve configured agent skills for prompt build",
        { error },
      );
      return undefined;
    }
  }

  async function handleExactKeywordPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
    exactKeywordMatch: NonNullable<ReturnType<typeof findExactKeywordIntent>>;
    configuredSkillsXml?: string;
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
    await recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      trigger: "exact-keyword",
      result,
      conversation: params.conversation,
    });
    const routingContext = await resolveRoutingContext({
      routing: params.routing,
      result,
      intent: params.exactKeywordMatch.intent,
    });
    if (!routingContext.durable) {
      await recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        trigger: "exact-keyword",
        result,
        recommendedSkills: routingContext.candidates.map((skill) => skill.name),
        conversation: params.conversation,
      });
    }
    return toPromptBuildResult(
      buildRoutingContext({
        result,
        guidance: params.exactKeywordMatch.intent.definition.guidance,
        candidates: routingContext.candidates,
        experiences: routingContext.experiences,
      }),
      params.configuredSkillsXml,
    );
  }

  async function handleClassifiedPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: ReturnType<typeof catalog.filterForAgent>;
    classification: PromptBuildClassification;
    modelRef: NonNullable<ReturnType<typeof getModelRef>>;
    configuredSkillsXml?: string;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const result = params.classification.result;
    logger.debug(`intention subagent result: ${JSON.stringify(result)}`);

    const recordAndReturnRoutingContext = async () => {
      await recordPromptBuildResult({
        ctx: params.ctx,
        routing: params.routing,
        latestUserMessage: params.latestUserMessage,
        trigger: params.classification.trigger,
        result,
        intentProjection: params.classification.intentProjection,
        conversation: params.conversation,
      });
      const intent = findIntentEntry(params.availableIntents, result.intent);
      if (!intent)
        return toPromptBuildResult(undefined, params.configuredSkillsXml);
      const routingContext = await resolveRoutingContext({
        routing: params.routing,
        result,
        intent,
      });
      if (!routingContext.durable) {
        await recordPromptBuildResult({
          ctx: params.ctx,
          routing: params.routing,
          latestUserMessage: params.latestUserMessage,
          trigger: params.classification.trigger,
          result,
          recommendedSkills: routingContext.candidates.map(
            (skill) => skill.name,
          ),
          intentProjection: params.classification.intentProjection,
          conversation: params.conversation,
        });
      }
      return toPromptBuildResult(
        buildRoutingContext({
          result,
          guidance: intent.definition.guidance,
          candidates: routingContext.candidates,
          experiences: routingContext.experiences,
        }),
        params.configuredSkillsXml,
      );
    };

    return await recordAndReturnRoutingContext();
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
    let configuredSkillsXml: string | undefined;
    let intentContextEnabled = false;
    try {
      const routing = resolvePromptBuildIdentity(ctx);
      resolvedSessionKey = routing.resolvedSessionKey ?? resolvedSessionKey;

      const resolvedContext = {
        ...ctx,
        sessionKey: resolvedSessionKey,
      };
      if (shouldSkipSkillSystemContext(resolvedContext)) return;

      staticContextEligible = true;
      intentContextEnabled = isEnabledForAgent(
        config(),
        routing.effectiveAgentId,
      );
      configuredSkillsXml = await resolveConfiguredSkillsXml(
        routing.effectiveAgentId,
      );

      if (!intentContextEnabled) {
        return toPromptBuildResult(undefined, configuredSkillsXml, false);
      }
      if (!isPromptBuildChatAllowed(resolvedContext, resolvedSessionKey)) {
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }
      if (shouldSkipIntentAnalysis(resolvedContext)) {
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }
      if (isInternalUserTurn(event)) {
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }
      if (!isEligibleInteractiveSession(resolvedContext)) {
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }

      // THEN refresh config and intents
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      if (shouldSkipAllForLowThinking(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking mode is off; skipping intention scan for low reasoning effort.",
        );
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }
      const { latestUserMessage, historicalIntents, conversation } =
        buildConversationContext(event, ctx, refreshedConfig);
      routing.association = await prepareTrackingTurn({
        ctx,
        routing,
        latestUserMessage,
      });
      if (!routing.association) {
        return toPromptBuildResult(undefined, configuredSkillsXml);
      }

      refreshIntents();
      if (catalog.count === 0) {
        logger.debug("no intents loaded; skipping intention scan.");
        return toPromptBuildResult(undefined, configuredSkillsXml);
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
              configuredSkillsXml,
            }),
        );
      }

      if (shouldUseDeterministicLowThinkingMode(ctx, refreshedConfig)) {
        logger.debug(
          "low thinking fastpath-only mode found no exact keyword match; skipping LLM-based intent analysis.",
        );
        return toPromptBuildResult(undefined, configuredSkillsXml);
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
      if (!modelRef) return toPromptBuildResult(undefined, configuredSkillsXml);

      return await runPromptBuildPipeline(
        ctx,
        routing.resolvedSessionKey,
        async () => {
          const classification = await classifyPromptBuild({
            ctx,
            refreshedConfig,
            effectiveAgentId: routing.effectiveAgentId,
            resolvedSessionKey: routing.resolvedSessionKey,
            association: routing.association,
            latestUserMessage,
            historicalIntents,
            conversation,
            modelRef,
            availableIntents,
          });

          if (!classification) {
            logger.debug("intention subagent failed; skipping hint injection.");
            return toPromptBuildResult(undefined, configuredSkillsXml);
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
            configuredSkillsXml,
          });
        },
      );
    } catch (err) {
      logger.warn("before_prompt_build hook error", { error: err });
      return staticContextEligible
        ? toPromptBuildResult(
            undefined,
            configuredSkillsXml,
            intentContextEnabled,
          )
        : undefined;
    }
  }

  async function onAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: {
      sessionId?: string;
      agentId?: string;
      sessionKey?: string;
      runId?: string;
    },
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
    const association = resolveAssociatedTurn({
      eventRunId: event.runId,
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association) return;
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

    const merged = await tracker.mergeTurnAndPersist({
      sessionId: association.sessionId,
      expectedTurnKey: association.turnKey,
      maxWaitMs: 0,
      data: {
        toolCalls: [
          {
            toolCallId: event.toolCallId,
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
    if (toolCallKey && merged === "applied") {
      recordedToolCalls.add(toolCallKey);
      pendingToolCalls.delete(toolCallKey);
      toolFallbacks.delete(toolCallKey);
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
    const association = resolveAssociatedTurn({
      eventRunId: event.runId,
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association) return;
    pendingToolCalls.set(toolCallKey, {
      name: event.toolName,
      params: event.params,
      ctx,
      association,
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
    if (!toolCallKey || recordedToolCalls.has(toolCallKey)) return;
    const pending = toolCallKey ? pendingToolCalls.get(toolCallKey) : undefined;
    const toolName = event.toolName ?? ctx.toolName ?? pending?.name;
    if (!toolName || !pending) return;

    const outputStr = resolveToolResultText(event.message);
    const truncatedOutput = outputStr.slice(0, 200);
    const failed = isToolResultError(event.message, toolName);
    const error = failed ? truncatedOutput : undefined;
    const params = pending?.params ?? {};
    const skillUsed = failed
      ? undefined
      : extractSkillInfo(toolName, params, outputStr);
    const staged = toolFallbacks.stage(toolCallKey, {
      association: pending.association,
      skillUsed,
      fallback: {
        toolCallId: toolCallKey,
        name: toolName,
        params,
        result: failed ? undefined : truncatedOutput,
        error,
        success: !failed,
      },
    });
    if (staged === "full" || staged === "ambiguous") {
      logger.warn("discarded persisted tool fallback", {
        reason: staged,
        toolName,
      });
    }
  }

  function extractAgentEndPayload(params: {
    messages?: unknown[];
    lastAssistantMessage?: string;
    error?: string;
  }): { result?: string; error?: string } {
    const lastAssistantMessage = (params.messages ?? [])
      .slice()
      .reverse()
      .find(
        (message): message is { role: "assistant"; content?: unknown } =>
          typeof message === "object" &&
          message !== null &&
          (message as { role?: unknown }).role === "assistant",
      );
    const content = lastAssistantMessage?.content;
    const result =
      typeof content === "string"
        ? content.trim()
        : content !== undefined
          ? resolveToolResultText({ content })
          : undefined;

    return {
      result: result || params.lastAssistantMessage,
      error: params.error,
    };
  }

  async function recordAgentEndStats(association: TurnAssociation) {
    const { sessionId, turnKey } = association;
    const state = tracker.getTurnState(sessionId, turnKey);
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
            const keywordTriggered = params.triggers.some(
              (trigger) =>
                trigger === "successful-pattern" ||
                trigger === "behavior-fix" ||
                trigger === "entity-context",
            );
            const intentTriggers = params.triggers.filter(
              (trigger) =>
                trigger !== "successful-pattern" &&
                trigger !== "behavior-fix" &&
                trigger !== "entity-context",
            );

            if (keywordTriggered) {
              await reviewLogWriter.recordHistoricalKeywordAudit?.(
                params.snapshot.eventId,
                {
                  sessionId: params.snapshot.sessionId,
                  sessionKey: params.snapshot.sessionKey,
                  agentId: params.snapshot.agentId,
                  turnStart: params.snapshot.current.timestamps!.start!,
                },
                keywordFindings,
                {
                  triggers: params.triggers,
                  outcome: reviewResult.outcome,
                  noFindingReasonCounts: reviewResult.noFindingReasonCounts,
                  schemaRejectionReasonCounts:
                    reviewResult.schemaRejectionReasonCounts,
                },
              );
            }

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

            if (
              intentTriggers.length > 0 ||
              intentFindings.length > 0 ||
              params.skillPlacementCandidate
            ) {
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
                  triggers: intentTriggers,
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

          const removalDocuments = KEYWORD_COVERAGE_TARGETS.flatMap(
            (target) => discovery.removals[target] ?? [],
          );
          const documents =
            removalDocuments.length > 0
              ? removalDocuments
              : KEYWORD_COVERAGE_TARGETS.flatMap(
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

      const milestone = coverageEpochMilestone({
        cadence,
        runtimeTargets: runtimeState.targets,
      });
      const keywordFingerprint = fingerprintKeywords(
        runtimeState.triggerKeywords,
      );
      const epochKey = buildCoverageEpochKey({
        acceptedTurn: milestone,
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
        targets: KEYWORD_COVERAGE_TARGETS,
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

  function enqueueCurationKey(
    key: string,
    identity: {
      sessionId: string;
      schedulingTurnKey: string;
      expectedTopicEpoch: number;
      expectedRevision: number;
    },
  ): boolean {
    const curationQueue = deps.curationQueue;
    if (!curationQueue) return false;
    return curationQueue.enqueue(key, async () => {
      await runQueuedCuration(identity);
    });
  }

  async function runQueuedCuration(identity: {
    sessionId: string;
    schedulingTurnKey: string;
    expectedTopicEpoch: number;
    expectedRevision: number;
  }): Promise<void> {
    const resolvedConfig = config();
    if (!resolvedConfig.curation.enabled || !deps.dataRoot) {
      await tracker.finishCurationSchedule({
        sessionId: identity.sessionId,
        turnKey: identity.schedulingTurnKey,
        expectedTopicEpoch: identity.expectedTopicEpoch,
        expectedRevision: identity.expectedRevision,
        outcome: "obsolete",
        now: clock().toISOString(),
      });
      return;
    }

    const pending = (await tracker.listPendingCurationSchedules()).find(
      (entry) =>
        entry.sessionId === identity.sessionId &&
        entry.schedule.schedulingTurnKey === identity.schedulingTurnKey &&
        entry.schedule.expectedTopicEpoch === identity.expectedTopicEpoch &&
        entry.schedule.expectedRevision === identity.expectedRevision &&
        entry.schedule.status === "pending",
    );
    if (!pending) return;

    const session = tracker
      .listRetainedSessions()
      .find((candidate) => candidate.sessionId === identity.sessionId);
    const expected = session?.curation;
    if (
      !session?.agentId ||
      !expected ||
      expected.topicEpoch !== identity.expectedTopicEpoch ||
      expected.revision !== identity.expectedRevision
    ) {
      await tracker.finishCurationSchedule({
        sessionId: identity.sessionId,
        turnKey: identity.schedulingTurnKey,
        expectedTopicEpoch: identity.expectedTopicEpoch,
        expectedRevision: identity.expectedRevision,
        outcome: "obsolete",
        now: clock().toISOString(),
      });
      return;
    }

    const acceptedEventIds = statsAggregator.listProcessedEventIds();
    const allTurns = [...(session.history ?? []), session.current];
    const acceptedTurns = allTurns.filter((turn) => {
      const eventId = resolveTurnEventId(identity.sessionId, turn);
      return eventId !== undefined && acceptedEventIds.has(eventId);
    });
    const schedulingIndex = acceptedTurns.findIndex(
      (turn) => turn.turnKey === identity.schedulingTurnKey,
    );
    if (schedulingIndex < 0) {
      await tracker.finishCurationSchedule({
        sessionId: identity.sessionId,
        turnKey: identity.schedulingTurnKey,
        expectedTopicEpoch: identity.expectedTopicEpoch,
        expectedRevision: identity.expectedRevision,
        outcome: "obsolete",
        now: clock().toISOString(),
      });
      return;
    }

    const conversationTurns = acceptedTurns
      .slice(0, schedulingIndex + 1)
      .flatMap((turn) => {
        if (!turn.input) return [];
        return [
          {
            role: "user",
            text: turn.input,
            ...(turn.intent?.result
              ? {
                  historicalIntent: {
                    intent: turn.intent.result.intent,
                    domain: turn.intent.result.domain,
                    topic: turn.intent.result.topic,
                    keywords: turn.intent.result.keywords,
                  },
                }
              : {}),
          },
        ];
      });

    const visibleSkills = await listAvailableSkills({
      api,
      agentId: session.agentId,
      bundledSkillsDir,
      usageStats: {},
    });
    const activeExperienceCatalog =
      experienceCatalog ?? SkillExperienceCatalog.create(deps.dataRoot);

    let proposal;
    try {
      proposal = await curator({
        api,
        config: resolvedConfig,
        agentId: session.agentId,
        sessionId: identity.sessionId,
        dataRoot: deps.dataRoot,
        curation: expected,
        conversation: conversationTurns,
        candidates: visibleSkills,
        experienceIdentities: expected.experienceRefs,
      });
    } catch (error) {
      logger.warn("curation subagent failed", { error });
      proposal = undefined;
    }

    if (!proposal) {
      await tracker.finishCurationSchedule({
        sessionId: identity.sessionId,
        turnKey: identity.schedulingTurnKey,
        expectedTopicEpoch: identity.expectedTopicEpoch,
        expectedRevision: identity.expectedRevision,
        outcome: "failed",
        now: clock().toISOString(),
      });
      return;
    }

    await validateAndCommitCuration({
      schedule: pending,
      expected,
      proposal,
      visibleSkills,
      experienceCatalog: activeExperienceCatalog,
      completedTurnCursor: schedulingIndex + 1,
      finalizedTurns: acceptedTurns,
      acceptedEventIds,
      now: clock().toISOString(),
      commit: tracker.commitCurationSchedule.bind(tracker),
      finish: tracker.finishCurationSchedule.bind(tracker),
    });
  }

  async function maybeScheduleCuration(
    association: TurnAssociation,
    resolvedConfig: ResolvedSkillHarnessPluginConfig,
  ): Promise<void> {
    const curationQueue = deps.curationQueue;
    if (!curationQueue || !resolvedConfig.curation.enabled) return;

    const current = tracker.getTurnState(
      association.sessionId,
      association.turnKey,
    );
    if (!current?.intent?.recommendationState) return;

    try {
      const session = tracker
        .listRetainedSessions()
        .find((candidate) => candidate.sessionId === association.sessionId);
      const curation = session?.curation;
      if (!curation) return;
      const cadence = evaluateCurationCadence({
        curation,
        finalizedTurns: [...(session.history ?? []), session.current],
      });
      if (!cadence.eligible || !cadence.schedulingTurnKey) return;

      const reserved = await tracker.reserveCurationSchedule({
        sessionId: association.sessionId,
        turnKey: cadence.schedulingTurnKey,
        expectedTopicEpoch: curation.topicEpoch,
        expectedRevision: curation.revision,
        now: clock().toISOString(),
      });
      if (reserved !== "reserved") return;

      const key = `curation:${association.sessionId}:${cadence.schedulingTurnKey}:${curation.topicEpoch}:${curation.revision}`;
      enqueueCurationKey(key, {
        sessionId: association.sessionId,
        schedulingTurnKey: cadence.schedulingTurnKey,
        expectedTopicEpoch: curation.topicEpoch,
        expectedRevision: curation.revision,
      });
    } catch (error) {
      logger.warn("failed to schedule curation", { error });
    }
  }

  async function recoverCurationSchedules(): Promise<void> {
    const curationQueue = deps.curationQueue;
    if (!curationQueue) return;
    const resolvedConfig = config();
    if (!resolvedConfig.curation.enabled) return;

    try {
      const acceptedEventIds = statsAggregator.listProcessedEventIds();
      const missing = reconcileCurationSchedules({
        sessions: tracker.listRetainedSessions(),
        acceptedEventIds,
      });
      for (const candidate of missing) {
        const reserved = await tracker.reserveCurationSchedule({
          sessionId: candidate.sessionId,
          turnKey: candidate.turnKey,
          expectedTopicEpoch: candidate.expectedTopicEpoch,
          expectedRevision: candidate.expectedRevision,
          now: clock().toISOString(),
        });
        if (reserved !== "reserved" && reserved !== "already-pending") continue;
        const key = `curation:${candidate.sessionId}:${candidate.turnKey}:${candidate.expectedTopicEpoch}:${candidate.expectedRevision}`;
        enqueueCurationKey(key, {
          sessionId: candidate.sessionId,
          schedulingTurnKey: candidate.turnKey,
          expectedTopicEpoch: candidate.expectedTopicEpoch,
          expectedRevision: candidate.expectedRevision,
        });
      }

      const pending = await tracker.listPendingCurationSchedules();
      for (const entry of pending) {
        const key = `curation:${entry.sessionId}:${entry.schedule.schedulingTurnKey}:${entry.schedule.expectedTopicEpoch}:${entry.schedule.expectedRevision}`;
        enqueueCurationKey(key, {
          sessionId: entry.sessionId,
          schedulingTurnKey: entry.schedule.schedulingTurnKey,
          expectedTopicEpoch: entry.schedule.expectedTopicEpoch,
          expectedRevision: entry.schedule.expectedRevision,
        });
      }
    } catch (error) {
      logger.warn("failed to recover curation schedules", { error });
    }
  }

  async function finalizeTrackedTurn(
    association: TurnAssociation | undefined,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    if (!association) return;
    const agentEndStats = await recordAgentEndStats(association);
    if (!agentEndStats) return;

    const resolvedConfig = config();
    await maybeScheduleCuration(association, resolvedConfig);
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

    const baseSnapshot = tracker.getReviewSnapshotForTurn(
      association.sessionId,
      association.turnKey,
    );
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
    const eventRunId = (event as { runId?: string }).runId;
    const association = resolveAssociatedTurn({
      eventRunId,
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association) return;
    const stagedEntries = toolFallbacks.listForAssociation(association);
    const stagedToolFallbacks = stagedEntries.map(
      ([, staged]) => staged.fallback,
    );
    const payload = extractAgentEndPayload({
      messages: event.messages,
      error: event.error,
    });
    const finalized = await tracker.finalizeTurnFromAgentEnd({
      sessionId: association.sessionId,
      expectedTurnKey: association.turnKey,
      stagedToolFallbacks,
      result: payload.result,
      error: payload.error,
      endedAt: new Date().toISOString(),
    });
    if (finalized !== "applied" && finalized !== "already-finalized") return;
    turnAssociations.markAssociationTerminal(association);
    toolFallbacks.markAssociationTerminal(association);
    if (finalized === "already-finalized") {
      if (stagedEntries.length > 0) {
        const durableTurn = tracker.getTurnState(
          association.sessionId,
          association.turnKey,
        );
        const fallbacksAreDurable = stagedEntries.every(([, staged]) =>
          durableTurn?.toolCalls?.some(
            (call) => call.toolCallId === staged.fallback.toolCallId,
          ),
        );
        if (fallbacksAreDurable) {
          for (const [toolCallId] of stagedEntries) {
            toolFallbacks.delete(toolCallId);
            pendingToolCalls.delete(toolCallId);
            recordedToolCalls.add(toolCallId);
          }
        }
      }
      return;
    }
    for (const [toolCallId] of stagedEntries) {
      toolFallbacks.delete(toolCallId);
      pendingToolCalls.delete(toolCallId);
      recordedToolCalls.add(toolCallId);
    }
    await finalizeTrackedTurn(association, ctx);
  }

  async function onBeforeAgentFinalize(
    event: PluginHookBeforeAgentFinalizeEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentFinalizeResult | void> {
    const eventRunId = event.runId?.trim();
    const association = resolveAssociatedTurn({
      eventRunId,
      contextRunId: ctx.runId,
      sessionId: event.sessionId ?? ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association) return;
    const entries = toolFallbacks.listForAssociation(association);
    for (const [toolCallId, staged] of entries) {
      const merged = await tracker.mergeTurnAndPersist({
        sessionId: association.sessionId,
        expectedTurnKey: association.turnKey,
        maxWaitMs: 0,
        data: {
          toolCalls: [staged.fallback],
          skillsUsed: staged.skillUsed ? [staged.skillUsed] : undefined,
        },
      });
      if (merged === "applied") {
        toolFallbacks.delete(toolCallId);
        pendingToolCalls.delete(toolCallId);
        recordedToolCalls.add(toolCallId);
      }
    }
    return;
  }

  async function onSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    turnAssociations.removeSession(ctx.sessionId);
    toolFallbacks.removeSession(ctx.sessionId);
    for (const [toolCallId, pending] of pendingToolCalls) {
      if (pending.association.sessionId === ctx.sessionId) {
        pendingToolCalls.delete(toolCallId);
        recordedToolCalls.delete(toolCallId);
      }
    }
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
    recoverCurationSchedules,
  };
}
