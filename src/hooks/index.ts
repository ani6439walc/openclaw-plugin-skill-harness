import { normalizeForKeyword } from "../normalize.js";
import type { RecentTurn, ResolvedSkillHarnessPluginConfig } from "../types.js";
import { logger } from "../../api.js";
import { defaultCatalog } from "../intents/index.js";
import {
  defaultTracker,
  extractSkillInfo,
  resolveTurnEventId,
} from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { IntentReviewLogWriter } from "../review/log-writer.js";
import { checkReviewTriggers, type ReviewTrigger } from "../review/triggers.js";
import { runReviewSubagent } from "../review/subagent.js";
import type {
  IntentMarkdownReviewFinding,
  SelectedPlacementSkill,
  TriggerKeywordsReviewFinding,
} from "../review/types.js";
import type { SkillPlacementReviewCandidate } from "../review/types.js";
import {
  DEFAULT_REVIEW_TRIGGER_KEYWORDS,
  type ReviewTriggerKeywords,
  type TriggerKeywordTarget,
} from "../review/trigger-keywords.js";
import { discoverKeywordCoverageCandidates } from "../review/keyword-coverage.js";
import { enqueueReview } from "../review/queue.js";
import { runKeywordCoverageReview } from "../review/keyword-coverage-subagent.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  extractLatestUserMessage,
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
  attachHistoricalIntents,
  sanitizeConversationText,
  sanitizeHistoricalIntentInput,
  getQmdCandidateLimits,
  projectQmdIntentCandidates,
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
import { FALLBACK_INTENT, FALLBACK_INTENT_ID } from "../constants.js";
import { experiencesPath, intentsPath, packageRoot } from "../file-utils.js";
import type { QmdIntentHit } from "../qmd/intent-index.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import type { AvailableSkill, SkillInventoryItem } from "../skills/types.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentProjectionTelemetry,
  IntentTrigger,
  IntentionResult,
} from "../types.js";
import { emitPipelineEvent } from "./pipeline-events.js";
import type {
  HookDeps,
  PendingToolCall,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookMessageSendingEvent,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
} from "./types.js";
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

const MAX_PROJECTION_CANDIDATE_IDS = 128;
const MAX_PROJECTION_MATCHED_KEYWORDS = 32;
const MAX_PROJECTION_KEYWORD_CHARS = 200;
const KEYWORD_COVERAGE_TARGETS: readonly TriggerKeywordTarget[] = [
  "successful-pattern",
  "behavior-fix",
  "entity-context",
];
const KEYWORD_COVERAGE_RETRY_INTERVAL = 5;
const MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS = 12_000;

type CoverageRuntimeTargets = Partial<
  Record<
    TriggerKeywordTarget,
    { cursor: number; lastCompletedAcceptedTurn: number }
  >
>;

function formatConversationExpansionContext(params: {
  conversation?: readonly RecentTurn[];
  latestHistoricalIntent?: HistoricalIntentRecord;
}): string | undefined {
  const parts: string[] = [];
  if (params.latestHistoricalIntent) {
    parts.push(`previous_intent=${params.latestHistoricalIntent.intent}`);
    if (params.latestHistoricalIntent.topic) {
      parts.push(`previous_topic=${params.latestHistoricalIntent.topic}`);
    }
  }
  if (params.conversation?.length) {
    const recent = params.conversation
      .slice(-3)
      .map((t) => `[${t.role}] ${t.text.trim().slice(0, 120)}`)
      .join(" ");
    parts.push(`recent_dialog=${recent}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function truncateSelectedPlacementSkillContent(content: string): {
  content: string;
  omittedCodePointCount?: number;
} {
  const codePoints = Array.from(content);
  if (codePoints.length <= MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS) {
    return { content };
  }
  const headLength = Math.floor(MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS / 2);
  const tailLength = MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS - headLength;
  return {
    content: `${codePoints.slice(0, headLength).join("")}\n\n${codePoints.slice(-tailLength).join("")}`,
    omittedCodePointCount:
      codePoints.length - MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS,
  };
}

async function resolveSelectedPlacementSkill(
  candidate: SkillPlacementReviewCandidate,
  availableSkills: readonly AvailableSkill[],
  skillInventory: readonly SkillInventoryItem[] | undefined,
): Promise<SelectedPlacementSkill | undefined> {
  const matchesInventory = skillInventory?.filter(
    (skill) =>
      skill.name.trim().toLowerCase() === candidate.name.trim().toLowerCase() &&
      skill.source === candidate.source &&
      skill.winnerFingerprint === candidate.winnerFingerprint &&
      skill.fingerprint === candidate.fingerprint,
  );
  if (matchesInventory?.length !== 1) return;
  const canonicalName = candidate.name.trim().toLowerCase();
  const matches = availableSkills.filter(
    (skill) => skill.name.trim().toLowerCase() === canonicalName,
  );
  if (matches.length !== 1) return;
  const selected = matches[0]!;
  try {
    const realpath = await fs.realpath(selected.location);
    const content = await fs.readFile(realpath);
    if (
      createHash("sha256").update(realpath).digest("hex") !==
        candidate.winnerFingerprint ||
      createHash("sha256").update(content).digest("hex") !==
        candidate.fingerprint
    ) {
      return;
    }
    const bounded = truncateSelectedPlacementSkillContent(
      content.toString("utf-8"),
    );
    return {
      name: selected.name,
      description: selected.description,
      ...bounded,
    };
  } catch (error) {
    logger.warn("failed to read selected placement skill", {
      error,
      skillName: selected.name,
    });
    return;
  }
}

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

function buildQmdIntentResult(params: {
  hit: QmdIntentHit;
  intent: IntentCatalogEntry;
  latestHistoricalIntent?: HistoricalIntentRecord;
}): IntentionResult {
  const sameIntent =
    resolveIntentId(params.latestHistoricalIntent?.intent) ===
    params.intent.id.toLowerCase();
  return {
    intent: params.intent.id,
    reason: `QMD ${params.hit.collection} match`,
    keywords: params.intent.definition.keywords.slice(0, 5),
    domain: params.intent.definition.domain,
    topic: `QMD match for ${params.intent.id}.`,
    topicChangeReason: !params.latestHistoricalIntent
      ? "start"
      : sameIntent
        ? undefined
        : "match",
    confidence: params.hit.score,
  };
}

function buildKeywordIntentResult(params: {
  hit: QmdIntentHit;
  intent: IntentCatalogEntry;
  latestHistoricalIntent?: HistoricalIntentRecord;
}): IntentionResult {
  const sameIntent =
    resolveIntentId(params.latestHistoricalIntent?.intent) ===
    params.intent.id.toLowerCase();
  return {
    intent: params.intent.id,
    reason: `Keyword match: ${params.intent.id}`,
    keywords: params.intent.definition.keywords.slice(0, 5),
    domain: params.intent.definition.domain,
    topic: `Keyword match for ${params.intent.id}.`,
    topicChangeReason: !params.latestHistoricalIntent
      ? "start"
      : sameIntent
        ? undefined
        : "match",
    confidence: params.hit.score,
  };
}

type PromptBuildClassification = {
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
  const clock = deps.clock ?? (() => new Date());
  const experienceCatalog =
    deps.experienceCatalog ??
    (deps.dataRoot ? new SkillExperienceCatalog(deps.dataRoot) : undefined);
  const qmdIntentIndex = deps.qmdIntentIndex;

  const reviewLogWriter: NonNullable<HookDeps["reviewLogWriter"]> =
    deps.reviewLogWriter ??
    new IntentReviewLogWriter(deps.dataRoot ?? packageRoot);
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
    recentTurns?: readonly RecentTurn[];
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
      recentTurns: params.recentTurns,
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
    const association =
      (runId ? turnAssociations.resolve(runId) : undefined) ??
      turnAssociations.resolveSession(params.sessionId ?? params.sessionKey) ??
      turnAssociations.resolveAnonymousSession(
        params.sessionId ?? params.sessionKey,
      );
    if (!association) return;
    if (
      (params.sessionId &&
        association.sessionId !== params.sessionId &&
        association.sessionKey !== params.sessionId) ||
      (params.sessionKey &&
        association.sessionKey !== params.sessionKey &&
        association.sessionId !== params.sessionKey)
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
      refreshedConfig.routing.classifier.queryMode,
      refreshedConfig.routing.classifier.contextWindow,
    );

    return { latestUserMessage, historicalIntents, conversation };
  }

  async function resolvePromptBuildClassification(params: {
    ctx: PluginHookAgentContext;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    effectiveAgentId: string;
    resolvedSessionKey?: string;
    association?: TurnAssociation;
    latestUserMessage: string;
    historicalIntents: HistoricalIntentRecord[];
    conversation: ReturnType<typeof limitConversationTurns>;
    modelRef: { provider: string; model: string } | undefined;
    availableIntents: readonly IntentCatalogEntry[];
  }): Promise<PromptBuildClassification | undefined> {
    const latestHistoricalIntent =
      params.historicalIntents[params.historicalIntents.length - 1];

    // Step 1: QMD Keyword Search (BM25 searchLex)
    let keywordHits: QmdIntentHit[] | undefined;
    if (qmdIntentIndex) {
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "qmd-keyword",
        "started",
      );
      keywordHits = await qmdIntentIndex.searchKeywords({
        query: params.latestUserMessage,
      });
      const topKeywordHit = keywordHits?.[0];
      const matchedKeywordIntent = topKeywordHit
        ? findIntentEntry(params.availableIntents, topKeywordHit.intentId)
        : undefined;
      if (
        topKeywordHit &&
        matchedKeywordIntent &&
        topKeywordHit.score >=
          params.refreshedConfig.routing.thresholds.directRouteMinScore
      ) {
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "qmd-keyword",
          "completed",
          {
            intent: matchedKeywordIntent.id,
            score: topKeywordHit.score,
            collection: topKeywordHit.collection,
          },
        );
        const result = buildKeywordIntentResult({
          hit: topKeywordHit,
          intent: matchedKeywordIntent,
          latestHistoricalIntent,
        });
        return {
          trigger: "keyword",
          result,
        };
      }
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "qmd-keyword",
        keywordHits === undefined ? "failed" : "completed",
        keywordHits === undefined
          ? { error: "QMD keyword index unavailable" }
          : topKeywordHit
            ? {
                score: topKeywordHit.score,
                collection: topKeywordHit.collection,
              }
            : {},
      );
    }

    // Step 2: QMD Hybrid Search (Triggers & Examples) with Context Expansion
    let qmdHits: QmdIntentHit[] | undefined;
    let topHit: QmdIntentHit | undefined;
    if (qmdIntentIndex) {
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "qmd-trigger-example",
        "started",
      );
      const limits = getQmdCandidateLimits(params.availableIntents.length);
      const expansionContext = formatConversationExpansionContext({
        conversation: params.conversation,
        latestHistoricalIntent,
      });
      qmdHits = await qmdIntentIndex.searchIntentTriggers({
        query: params.latestUserMessage,
        rawLimit: limits.rawLimit,
        ...(expansionContext ? { expansionContext } : {}),
      });
      topHit = qmdHits?.[0];
      const topIntent = topHit
        ? findIntentEntry(params.availableIntents, topHit.intentId)
        : undefined;
      if (
        topHit &&
        topIntent &&
        topHit.score >=
          params.refreshedConfig.routing.thresholds.directRouteMinScore
      ) {
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "qmd-trigger-example",
          "completed",
          {
            intent: topIntent.id,
            score: topHit.score,
            collection: topHit.collection,
          },
        );
        const result = buildQmdIntentResult({
          hit: topHit,
          intent: topIntent,
          latestHistoricalIntent,
        });
        return {
          trigger: "qmd-trigger",
          result,
        };
      }
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "qmd-trigger-example",
        qmdHits === undefined ? "failed" : "completed",
        qmdHits === undefined
          ? { error: "QMD intent trigger index unavailable" }
          : topHit
            ? { score: topHit.score, collection: topHit.collection }
            : {},
      );
    }

    // Step 3: Fallback Intent Classifier
    if (!params.modelRef) {
      return;
    }

    const projectionStartedAtMs = Date.now();
    let projection: IntentProjection;
    try {
      projection = projectQmdIntentCandidates({
        intents: params.availableIntents,
        qmdHits,
        histories: params.historicalIntents,
        minCandidateScore:
          params.refreshedConfig.routing.thresholds.minCandidateScore,
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
    const intentProjection = toIntentProjectionTelemetry({
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
    let result: IntentionResult | undefined;
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
      return;
    }

    result.domain = findIntentDomain(params.availableIntents, result.intent);
    return {
      trigger: "classifier",
      result,
      intentProjection,
    };
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
    experiences: ReturnType<SkillExperienceCatalog["listForSkills"]>;
  }> {
    const directSkills = await resolveAvailableSkills({
      api,
      agentId: params.routing.effectiveAgentId,
      bundledSkillsDir,
      skillNames: params.intent.definition.skills ?? [],
    });
    const candidates = directSkills.slice(0, 4);
    const experiences = experienceCatalog
      ? experienceCatalog.listForSkills(
          candidates.map((candidate) => candidate.name),
        )
      : [];
    return {
      candidates,
      experiences,
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

  async function handleResolvedIntentPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: readonly IntentCatalogEntry[];
    classification: PromptBuildClassification;
    configuredSkillsXml?: string;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const { trigger, result, intentProjection } = params.classification;
    logger.debug(`intention result (${trigger}): ${JSON.stringify(result)}`);

    await recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      trigger,
      result,
      intentProjection,
      conversation: params.conversation,
    });
    const intent = findIntentEntry(params.availableIntents, result.intent);
    if (!intent) {
      return toPromptBuildResult(undefined, params.configuredSkillsXml);
    }
    const routingContext = await resolveRoutingContext({
      routing: params.routing,
      result,
      intent,
    });
    await recordPromptBuildResult({
      ctx: params.ctx,
      routing: params.routing,
      latestUserMessage: params.latestUserMessage,
      trigger,
      result,
      recommendedSkills: routingContext.candidates.map((skill) => skill.name),
      intentProjection,
      conversation: params.conversation,
    });
    return toPromptBuildResult(
      buildRoutingContext({
        result,
        guidance: intent.definition.guidance,
        candidates: routingContext.candidates,
        experiences: routingContext.experiences,
      }),
      params.configuredSkillsXml,
    );
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
      const { latestUserMessage, historicalIntents, conversation } =
        buildConversationContext(event, ctx, refreshedConfig);
      routing.association = await prepareTrackingTurn({
        ctx,
        routing,
        latestUserMessage,
        recentTurns: extractRecentTurns(event.messages),
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

      const availableIntents = catalog.get();

      const modelRef = getModelRef(
        api,
        routing.effectiveAgentId,
        refreshedConfig,
        {
          modelProviderId: ctx.modelProviderId,
          modelId: ctx.modelId,
        },
      );

      return await runPromptBuildPipeline(
        ctx,
        routing.resolvedSessionKey,
        async () => {
          const classification = await resolvePromptBuildClassification({
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
            logger.debug(
              "intent resolution yielded no result; skipping routing context injection.",
            );
            return toPromptBuildResult(undefined, configuredSkillsXml);
          }

          return await handleResolvedIntentPromptBuild({
            ctx,
            routing,
            refreshedConfig,
            latestUserMessage,
            conversation,
            availableIntents,
            classification,
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
    const assistantObj = lastAssistantMessage as
      Record<string, unknown> | undefined;
    const content = lastAssistantMessage?.content;
    const result =
      typeof content === "string"
        ? content.trim()
        : content !== undefined
          ? resolveToolResultText({ content })
          : typeof assistantObj?.text === "string"
            ? assistantObj.text.trim()
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
    const availableSkillNames = skillPlacementCandidate
      ? [skillPlacementCandidate.name]
      : [...(intentDefinition?.definition.skills ?? [])];
    const resolvedAvailableSkills =
      availableSkillNames.length > 0
        ? await resolveAvailableSkills({
            api,
            agentId,
            bundledSkillsDir,
            skillNames: [...new Set(availableSkillNames)],
          })
        : [];
    const skillInventory = skillPlacementCandidate
      ? await skillInventoryResolver({ api, agentId, bundledSkillsDir })
      : undefined;
    const selectedPlacementSkill = skillPlacementCandidate
      ? await resolveSelectedPlacementSkill(
          skillPlacementCandidate,
          resolvedAvailableSkills,
          skillInventory,
        )
      : undefined;
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
      availableSkills: skillPlacementCandidate ? [] : resolvedAvailableSkills,
      ...(skillPlacementCandidate ? { skillPlacementCandidate } : {}),
      ...(selectedPlacementSkill ? { selectedPlacementSkill } : {}),
      intentCatalog: catalog.get().map((entry) => ({
        id: entry.id,
        triggers: [...entry.definition.triggers],
        examples: [...entry.definition.examples],
        domain: entry.definition.domain,
        guidance: entry.definition.guidance,
        skills: [...(entry.definition.skills ?? [])],
        keywords: [...entry.definition.keywords],
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
          const observedSkillNames = new Set(
            (params.snapshot.current.skillsUsed ?? []).map((skill) =>
              skill.name.trim().toLowerCase(),
            ),
          );
          let allowedExperienceSkills: string[] = [];
          try {
            const inventory = await skillInventoryResolver({
              api,
              agentId: params.agentId,
              bundledSkillsDir,
            });
            allowedExperienceSkills = (inventory ?? [])
              .map((skill) => skill.name.trim().toLowerCase())
              .filter((skill) => observedSkillNames.has(skill));
          } catch (error) {
            logger.warn("failed to resolve review experience skill inventory", {
              error,
            });
          }
          const reviewResult = await reviewer({
            api,
            config: params.resolvedConfig,
            agentId: params.agentId,
            intentDirectory: intentsPath(deps.dataRoot ?? "."),
            experienceDirectory: experiencesPath(deps.dataRoot ?? "."),
            allowedExperienceSkills,
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
                changedExperienceIds: reviewResult.changedExperienceIds,
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
            const experienceFindings = reviewResult.findings.filter(
              (f) => f.targetKind === "skill-experience",
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
              experienceFindings.length > 0 ||
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
                [...intentFindings, ...experienceFindings],
                {
                  triggers: [
                    ...intentTriggers,
                    ...experienceFindings.map((finding) => finding.trigger),
                  ],
                  outcome: reviewResult.outcome,
                  changedIntentIds: reviewResult.changedIntentIds,
                  changedExperienceIds: reviewResult.changedExperienceIds,
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
                params.resolvedConfig.routing.classifier.modelFallback,
              thinking: params.resolvedConfig.review.thinking,
              timeoutMs: params.resolvedConfig.review.timeoutSeconds * 1_000,
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

  async function finalizeTrackedTurn(
    association: TurnAssociation | undefined,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    if (!association) return;
    const agentEndStats = await recordAgentEndStats(association);
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
      if (placementSkillName && !snapshot.selectedPlacementSkill) {
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
    const eventRunId = event.runId;
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

  async function onMessageSending(
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    logger.info("onMessageSending hook triggered", {
      ctxSessionId: ctx.sessionId,
      ctxSessionKey: ctx.sessionKey,
      ctxRunId: ctx.runId,
    });
    const association = resolveAssociatedTurn({
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    logger.info("onMessageSending association resolved", { association });
    if (!association) return;
    const stagedEntries = toolFallbacks.listForAssociation(association);
    const stagedToolFallbacks = stagedEntries.map(
      ([, staged]) => staged.fallback,
    );
    const messageContent = (event as { content?: unknown })?.content;
    const resultText =
      typeof messageContent === "string"
        ? messageContent.trim()
        : event !== undefined
          ? resolveToolResultText(event)
          : undefined;
    const finalized = await tracker.finalizeTurnFromAgentEnd({
      sessionId: association.sessionId,
      expectedTurnKey: association.turnKey,
      stagedToolFallbacks,
      result: resultText || undefined,
      endedAt: new Date().toISOString(),
    });
    logger.info("onMessageSending turn finalization result", { finalized });
    if (finalized === "applied" || finalized === "already-finalized") {
      turnAssociations.markAssociationTerminal(association);
      toolFallbacks.markAssociationTerminal(association);
      for (const [toolCallId] of stagedEntries) {
        toolFallbacks.delete(toolCallId);
        pendingToolCalls.delete(toolCallId);
        recordedToolCalls.add(toolCallId);
      }
      await finalizeTrackedTurn(association, ctx);
    }
  }

  async function onSessionEnd(
    _event: PluginHookSessionEndEvent,
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
    onMessageSending,
    onAgentEnd,
    onSessionEnd,
  };
}
