import {
  isAgentLifecycleYieldedWaiting,
  resolveAgentRunLifecycleTerminalFacts,
} from "openclaw/plugin-sdk/agent-lifecycle";
import type { RelationDecision } from "../skills/related.js";
import {
  expandRelatedCandidates,
  collectRelationEvidence,
} from "../skills/related.js";
import { resolveRelationGraph } from "../skills/relation-graph.js";
import { canonicalIdentity, roundToDecimals } from "../normalize.js";
import type {
  InputSkillDiscovery,
  SkillCollectionKind,
} from "../session/index.js";
import type { RecentTurn, ResolvedSkillHarnessPluginConfig } from "../types.js";
import { logger } from "../../api.js";
import {
  formatErrorDiagnostic,
  safeErrorClassification,
} from "../error-diagnostics.js";
import { defaultTracker, extractSkillInfo } from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { IntentReviewLogWriter } from "../review/log-writer.js";
import { isRelationReviewDue } from "../review/triggers.js";
import type { getReviewModelRef } from "../review/subagent.js";
import type { ReviewSnapshot } from "../review/types.js";
import {
  createIntentReviewScheduler,
  isReviewSessionActive,
  resolveReviewSessionKey,
} from "../review/scheduler.js";
import { createBackgroundRunner } from "../subagent-runtime.js";
import {
  extractLatestUserMessage,
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
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
  runJevUnifiedRouting,
  type JevUnifiedRoutingParams,
  buildRoutingContext,
  formatWorkingSetSkills,
} from "../classification/index.js";
import {
  listAvailableSkills,
  resolveAvailableSkills,
  resolveSkillInventory,
} from "../skills/index.js";
import { packageRoot } from "../file-utils.js";
import { prepareRelationReviewContext } from "../review/relations.js";
import type {
  RelationReviewContext,
  RelationPreparationSummary,
} from "../review/relations.js";
import type { AvailableSkill } from "../skills/types.js";
import { matchAvailableSkillNamesWithTokens } from "../skills/name-index.js";
import {
  buildCandidateSkillsUnionPool,
  buildSkillCandidateSuperset,
  type SkillDiscoveryCandidate,
} from "../skills/candidate-pool.js";
import type { RoutingLlmResult } from "../types.js";
import {
  emitPipelineEvent,
  type SkillCandidatePoolFallbackReason,
} from "./pipeline-events.js";
import type {
  AgentLifecycleEvent,
  AttemptContext,
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
  SKILL_HARNESS_ROUTING_CONTEXT,
  SKILL_HARNESS_SYSTEM_CONTEXT,
} from "./system-context.js";
export type { HookDeps } from "./types.js";

import {
  PromptExecutions,
  type PromptRequestOwner,
} from "./prompt-executions.js";
import { promptRoutingBudgetMs, withPromptDeadline } from "./prompt-budget.js";

type TurnFinalizationPhase =
  "finalize" | "inventory" | "stats" | "review-preparation";
type TurnFinalizationPhaseObserver = (phase: TurnFinalizationPhase) => void;

interface ObservedAttempt {
  result?: string;
  error?: string;
  success: boolean;
  ctx: AttemptContext;
}

function attemptKey(association: TurnAssociation): string {
  return `${association.sessionId}\0${association.turnKey}`;
}

function extractTerminalReplyText(reply: unknown): string | undefined {
  if (
    !reply ||
    typeof reply !== "object" ||
    !("disposition" in reply) ||
    reply.disposition !== "visible" ||
    !("text" in reply) ||
    typeof reply.text !== "string"
  )
    return;
  return reply.text.trim() || undefined;
}

function eventError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/(bearer\s+)\S+/giu, "$1[redacted]")
    .replace(
      /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu,
      "$1=[redacted]",
    )
    .slice(0, 240);
}

export function formatConversationExpansionContext(params: {
  conversation?: readonly RecentTurn[];
  candidateTokens?: readonly string[];
}): string | undefined {
  const hasConversation = Boolean(
    params.conversation && params.conversation.length > 0,
  );
  const hasTokens = Boolean(
    params.candidateTokens && params.candidateTokens.length > 0,
  );

  if (!hasConversation && !hasTokens) {
    return undefined;
  }

  const sections: string[] = [
    "You are expanding a query for conversational assistant skill & intent routing.\n" +
      "- Ground the expansion in the ongoing conversation: resolve pronouns, slang, abbreviations, and elliptical expressions using the conversation context.\n" +
      "- Stay faithful to the user's actual intent and context; do not introduce unrelated topics or invent scenarios not grounded in the query or conversation history.\n" +
      "- Write search queries from the user's perspective (search query or direct question); do not write third-person descriptions of the user (avoid '使用者...', 'User asks...').\n" +
      "- Strictly preserve the user's primary language and script (e.g. Traditional Chinese queries must produce Traditional Chinese expansions; never translate into English unless the user query is English).",
  ];

  if (hasTokens && params.candidateTokens) {
    sections.push(
      `Detected candidate skill terms in user query:\n${params.candidateTokens.join(", ")}`,
    );
  }

  if (hasConversation && params.conversation) {
    const conversationLines = params.conversation
      .map((t) => `- [${t.role}] ${t.text.trim()}`)
      .join("\n");
    sections.push(`Recent conversation:\n${conversationLines}`);
  }

  return sections.join("\n\n");
}

function toPromptBuildResult(
  prependContext?: string,
  workingSetSkillsXml?: string,
  includeRoutingContext = true,
): PluginHookBeforePromptBuildResult {
  const systemContext = includeRoutingContext
    ? `${SKILL_HARNESS_SYSTEM_CONTEXT}\n\n${SKILL_HARNESS_ROUTING_CONTEXT}`
    : SKILL_HARNESS_SYSTEM_CONTEXT;
  const appendSystemContext = workingSetSkillsXml
    ? `${systemContext}\n\n${workingSetSkillsXml}`
    : systemContext;
  return {
    ...(prependContext ? { prependContext } : {}),
    appendSystemContext,
  };
}

export function createHookHandlers(deps: HookDeps) {
  const { api, config, refreshLiveConfigFromRuntime } = deps;
  const tracker = deps.tracker ?? defaultTracker;
  const statsAggregator = deps.statsAggregator ?? defaultStatsAggregator;
  const skillInventoryResolver =
    deps.skillInventoryResolver ?? resolveSkillInventory;
  const loadReviewSubagent =
    deps.loadReviewSubagent ?? (() => import("../review/subagent.js"));
  const reviewer: NonNullable<HookDeps["reviewer"]> =
    deps.reviewer ??
    (async (params) => {
      if (params.abortSignal?.aborted) return;
      const { runReviewSubagent } = await loadReviewSubagent();
      if (params.abortSignal?.aborted) return;
      return runReviewSubagent(params);
    });
  const classifier = deps.classifier;
  const routingSelector = deps.routingSelector ?? deps.routingSubagent;
  const effectiveRoutingSelector: (
    params: JevUnifiedRoutingParams,
  ) => Promise<RoutingLlmResult | undefined> =
    routingSelector ??
    (classifier
      ? async (callParams: JevUnifiedRoutingParams) => {
          const classified = await classifier({
            api: callParams.api,
            config: callParams.config,
            agentId: callParams.agentId,
            sessionKey: callParams.sessionKey,
            sessionId: callParams.sessionId,
            conversation: callParams.conversation,
            latest: callParams.latest,
            messageProvider: callParams.messageProvider,
            channelId: callParams.channelId,
            modelRef: callParams.modelRef,
            candidateSkills: callParams.candidateSkills,
            candidateSources: callParams.candidateSources,
            relatedEvidence: callParams.relatedEvidence,
            relationEvidence: callParams.relationEvidence,
            dataRoot: callParams.dataRoot,
            signal: callParams.signal,
            assertActive: callParams.assertActive,
          });
          if (!classified) return undefined;
          return {
            ...(classified.relationDecisions
              ? { relationDecisions: classified.relationDecisions }
              : {}),
            skills: classified.skills ?? [],
            confidence: classified.confidence ?? 1.0,
            reason: classified.reason ?? "Selected relevant candidate skills",
          };
        }
      : runJevUnifiedRouting);
  const qmdSkillIndex = deps.qmdSkillIndex;

  const reviewLogWriter: NonNullable<HookDeps["reviewLogWriter"]> =
    deps.reviewLogWriter ??
    new IntentReviewLogWriter(deps.dataRoot ?? packageRoot);
  const bundledSkillsDir = deps.bundledSkillsDir;
  const nativeBundledSkillsDir = deps.nativeBundledSkillsDir;
  const sharedRoots = () => deps.getSharedRoots?.() ?? [];
  const observedAttempts = new Map<string, ObservedAttempt>();
  const maxObservedAttempts = 4096;
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const toolFallbacks = deps.toolFallbacks ?? new ToolFallbackRegistry();
  const recordedToolCalls = new Map<string, string>();
  const maxRecordedToolCalls = 4096;
  function rememberToolCall(key: string, sessionId: string): void {
    recordedToolCalls.set(key, sessionId);
    if (recordedToolCalls.size > maxRecordedToolCalls) {
      const oldest = recordedToolCalls.keys().next().value;
      if (oldest !== undefined) recordedToolCalls.delete(oldest);
    }
  }
  const promptExecutions = new PromptExecutions<string | undefined>(
    api.lifecycle?.signal,
  );
  const anonymousPreparations = new Map<string, Promise<unknown>>();
  const turnAssociations =
    deps.turnAssociations ?? new TurnAssociationRegistry();

  const reviewScheduler =
    deps.reviewScheduler ??
    createIntentReviewScheduler({
      signal: api.lifecycle?.signal,
      runInBackgroundContext: createBackgroundRunner(api.lifecycle),
      isSystemActive: (candidate) =>
        isReviewSessionActive(turnAssociations, candidate),
    });

  reviewScheduler.setRunner(async (candidate, abortSignal) => {
    const getNeighborOffset = reviewLogWriter.inspectionOffsetsForEvent(
      candidate.snapshot.eventId,
    );
    if (!getNeighborOffset) return;
    let relationContext: RelationReviewContext | undefined;
    let relationPreparation: RelationPreparationSummary = {
      status: "skipped",
      reason: "no-data-root",
      requestedSeeds: 0,
      capturedSeeds: 0,
      capturedExtras: 0,
      existingNeighborAttempts: 0,
      discoveryAttempts: 0,
      skippedCaptureCount: 0,
    };
    if (deps.dataRoot) {
      const seedNames = [
        ...new Set([
          ...(candidate.snapshot.current.matchedSkills ?? []),
          ...(candidate.snapshot.current.skillsUsed ?? []).map(
            (skill) => skill.name,
          ),
        ]),
      ];
      try {
        relationContext = await prepareRelationReviewContext({
          dataRoot: deps.dataRoot,
          seedNames,
          getVisibleSkills: async () =>
            (deps.reviewSkillResolver ?? listAvailableSkills)({
              api,
              agentId: candidate.agentId,
              bundledSkillsDir,
              nativeBundledSkillsDir: await nativeBundledSkillsDir,
              sharedRoots: sharedRoots(),
              usageStats: {},
              cacheTtlMs: 0,
            }),
          getNeighborOffset,
          onPreparation: (summary) => {
            relationPreparation = summary;
          },
          signal: abortSignal,
        });
      } catch {
        if (abortSignal.aborted) return;
        relationPreparation = {
          ...relationPreparation,
          status: "skipped",
          reason: "preparation-failed",
          requestedSeeds: seedNames.length,
        };
        logger.warn(
          `review relation evidence unavailable ${JSON.stringify({
            reason: "preparation-failed",
          })}`,
        );
      }
    }
    abortSignal.throwIfAborted();
    const source = {
      sessionId: candidate.snapshot.sessionId,
      sessionKey: candidate.snapshot.sessionKey,
      agentId: candidate.snapshot.agentId,
      turnStart: candidate.snapshot.current.timestamps!.start!,
    };
    if (!relationContext) {
      await reviewLogWriter.record(candidate.snapshot.eventId, source, [], {
        outcome: "skipped",
        relationPreparation,
        relationSearchCount: 0,
      });
      return;
    }
    const reviewResult = await reviewer({
      reviewToolRegistry: deps.reviewToolRegistry,
      api,
      config: candidate.resolvedConfig,
      agentId: candidate.agentId,
      relationContext,
      sessionKey: resolveReviewSessionKey(candidate),
      messageProvider: candidate.ctx.messageProvider,
      modelRef: candidate.modelRef,
      snapshot: candidate.snapshot,
      abortSignal,
    });
    if (
      !reviewResult ||
      (abortSignal.aborted && !reviewResult.changedRelationCount)
    )
      return;
    await reviewLogWriter.record(
      candidate.snapshot.eventId,
      source,
      reviewResult.findings,
      {
        outcome: reviewResult.outcome,
        ...(reviewResult.changedRelationCount !== undefined
          ? { changedRelationCount: reviewResult.changedRelationCount }
          : {}),
        ...(reviewResult.relationBatchId
          ? { relationBatchId: reviewResult.relationBatchId }
          : {}),
        ...(reviewResult.relationOutcome
          ? { relationOutcome: reviewResult.relationOutcome }
          : {}),
        validationErrors: reviewResult.validationErrors,
        noFindingReasonCounts: reviewResult.noFindingReasonCounts,
        schemaRejectionReasonCounts: reviewResult.schemaRejectionReasonCounts,
        relationPreparation:
          relationContext?.preparation ?? relationPreparation,
        relationReview: reviewResult.relationReview,
        relationSearchCount: reviewResult.relationSearchCount,
        relationInspectionCursor: relationContext?.inspectionCursor,
      },
    );
  });

  interface PromptBuildIdentity {
    effectiveAgentId: string;
    resolvedSessionKey?: string;
    association?: TurnAssociation;
    request?: PromptRequestOwner<string | undefined>;
  }

  async function resolvePromptBuildIdentity(
    ctx: PluginHookAgentContext,
    request: PromptRequestOwner<string | undefined> | undefined,
    nativeAdmission: boolean,
  ): Promise<PromptBuildIdentity> {
    const resolvedAgentId = resolveStatusUpdateAgentId(ctx);
    let resolvedSessionKey = ctx.sessionKey?.trim() || undefined;
    if (!resolvedSessionKey && resolvedAgentId) {
      if (request?.state === "finalized") {
        resolvedSessionKey = request.resolvedSessionKey;
      } else if (!nativeAdmission || request) {
        const lookup = () =>
          resolveCanonicalSessionKeyFromSessionId({
            api,
            agentId: resolvedAgentId,
            sessionId: ctx.sessionId,
          });
        resolvedSessionKey = request
          ? await promptExecutions.lookupRequest(request, lookup)
          : await promptExecutions.track(lookup());
      }
    }
    resolvedSessionKey = resolvedSessionKey?.trim() || undefined;
    if (
      !resolvedSessionKey &&
      resolvedAgentId &&
      ctx.sessionId &&
      request?.admissionId !== undefined
    ) {
      resolvedSessionKey =
        tracker
          .getNativeTurnIdentity?.(
            ctx.sessionId,
            resolvedAgentId,
            request.admissionId,
          )
          ?.sessionKey?.trim() || undefined;
    }
    return { effectiveAgentId: resolvedAgentId, resolvedSessionKey, request };
  }

  async function prepareTrackingTurn(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    latestUserMessage: string;
    recentTurns?: readonly RecentTurn[];
  }): Promise<TurnAssociation | undefined> {
    const sessionId =
      params.routing.request?.sessionId ??
      params.ctx.sessionId ??
      tracker.resolveCurrentSessionId({
        sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
      });
    if (!sessionId) return;
    promptExecutions.assertActive();
    const runId = params.ctx.runId?.trim();
    const request = params.routing.request;
    if (request?.admissionId !== undefined) {
      const hostSessionKey =
        params.routing.resolvedSessionKey ||
        params.ctx.sessionKey?.trim() ||
        undefined;
      const assertActive = (allowFinalized = false) => {
        promptExecutions.assertRequestCurrent(request, allowFinalized);
        params.ctx.hookInvocation?.assertActive();
      };
      const preparedAssociation = await promptExecutions.prepareRequest(
        request,
        async () => {
          assertActive();
          const prepared = await tracker.preparePromptTurn({
            sessionId,
            sessionKey: hostSessionKey,
            agentId: params.routing.effectiveAgentId,
            forceNew: true,
            nativeAdmissionId: request.admissionId,
            input: params.latestUserMessage,
            startedAt: new Date().toISOString(),
            recentTurns: params.recentTurns,
            assertActive,
          });
          assertActive(
            "identity" in prepared && prepared.identity.finalized === true,
          );
          if (!("identity" in prepared)) return;
          return {
            sessionId,
            sessionKey: hostSessionKey || prepared.identity.sessionKey,
            turnKey: prepared.identity.turnKey,
            ...(prepared.identity.finalized
              ? { finalized: true as const }
              : {}),
          };
        },
      );
      assertActive(preparedAssociation?.finalized === true);
      if (!preparedAssociation) return;
      const association = {
        ...preparedAssociation,
        sessionKey: hostSessionKey || preparedAssociation.sessionKey,
      };
      if (runId) {
        // An ambiguous run alias must not conflate independent admissions.
        turnAssociations.bindNativeRun(runId, request, association);
      } else {
        const reservation = turnAssociations.reserveAnonymous();
        if (reservation.status === "reserved")
          turnAssociations.bindAnonymous(reservation.token, association);
      }
      if (association.finalized) {
        request.association = association;
        promptExecutions.finalizeAssociation(association);
        turnAssociations.markAssociationTerminal(association);
        toolFallbacks.markAssociationTerminal(association);
        return;
      }
      return association;
    }
    if (!runId) {
      const previous =
        anonymousPreparations.get(sessionId) ?? Promise.resolve();
      const work = promptExecutions.track(
        previous
          .catch(() => {})
          .then(() => prepareTrackingTurnReserved(params, sessionId, runId)),
      );
      anonymousPreparations.set(sessionId, work);
      try {
        return await work;
      } finally {
        if (anonymousPreparations.get(sessionId) === work)
          anonymousPreparations.delete(sessionId);
      }
    }
    return promptExecutions.track(
      prepareTrackingTurnReserved(params, sessionId, runId),
    );
  }

  async function prepareTrackingTurnReserved(
    params: {
      ctx: PluginHookAgentContext;
      routing: PromptBuildIdentity;
      latestUserMessage: string;
      recentTurns?: readonly RecentTurn[];
    },
    sessionId: string,
    runId: string | undefined,
  ): Promise<TurnAssociation | undefined> {
    promptExecutions.assertActive();
    if (params.routing.request)
      promptExecutions.assertRequestCurrent(params.routing.request);
    params.ctx.hookInvocation?.assertActive();
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

    try {
      const prepared = await tracker.preparePromptTurn({
        sessionId,
        sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
        agentId: params.routing.effectiveAgentId,
        runId,
        input: params.latestUserMessage,
        startedAt: new Date().toISOString(),
        recentTurns: params.recentTurns,
        assertActive: () => {
          promptExecutions.assertActive();
          if (params.routing.request)
            promptExecutions.assertRequestCurrent(params.routing.request);
          params.ctx.hookInvocation?.assertActive();
        },
      });
      promptExecutions.assertActive();
      if (params.routing.request)
        promptExecutions.assertRequestCurrent(params.routing.request);
      params.ctx.hookInvocation?.assertActive();
      if (!("identity" in prepared)) {
        if (reservation.status === "reserved") {
          turnAssociations.release(reservation.token);
        }
        return;
      }
      const association: TurnAssociation = {
        sessionId,
        sessionKey:
          params.routing.resolvedSessionKey ||
          params.ctx.sessionKey?.trim() ||
          prepared.identity.sessionKey ||
          undefined,
        turnKey: prepared.identity.turnKey,
        ...(prepared.identity.finalized ? { finalized: true as const } : {}),
      };
      const bound =
        reservation.status === "reserved"
          ? runId
            ? turnAssociations.bind(reservation.token, runId, association)
            : turnAssociations.bindAnonymous(reservation.token, association)
          : turnAssociations.bindExisting(runId, association);
      if (bound !== "bound") return;
      if (association.finalized) {
        promptExecutions.finalizeAssociation(association);
        turnAssociations.markAssociationTerminal(association);
        toolFallbacks.markAssociationTerminal(association);
        return;
      }
      return association;
    } catch (error) {
      if (reservation.status === "reserved") {
        turnAssociations.release(reservation.token);
      }
      throw error;
    }
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
    const sessionKey = params.sessionKey?.trim();
    const sessionIdentity = params.sessionId ?? sessionKey;
    const unseenRun =
      runId && !turnAssociations.hasRun(runId) ? runId : undefined;
    const association = runId
      ? !unseenRun
        ? turnAssociations.resolve(runId)
        : turnAssociations.unknownRunFallbackEnabled
          ? turnAssociations.resolveAnonymousSession(sessionIdentity)
          : undefined
      : turnAssociations.resolveSession(sessionIdentity);
    if (!association) return;
    if (
      (params.sessionId &&
        association.sessionId !== params.sessionId &&
        association.sessionKey !== params.sessionId) ||
      (sessionKey &&
        association.sessionKey !== sessionKey &&
        association.sessionId !== sessionKey)
    ) {
      return;
    }
    if (unseenRun && !turnAssociations.pinAnonymousRun(unseenRun, association))
      return;
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
    _ctx: PluginHookAgentContext,
    refreshedConfig: ResolvedSkillHarnessPluginConfig,
  ): {
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
  } {
    const latestUserMessage =
      typeof event.currentUserMessage === "string"
        ? event.currentUserMessage.trim()
        : extractLatestUserMessage(event.messages, event.prompt);
    const conversation = limitConversationTurns(
      extractRecentTurns(event.messages),
      refreshedConfig.routing.queryMode,
      refreshedConfig.routing.contextWindow,
    );

    return { latestUserMessage, conversation };
  }

  async function recordPromptBuildSession(params: {
    association?: TurnAssociation;
    latestUserMessage: string;
    matchedSkills?: readonly AvailableSkill[];
    inputSkillDiscovery?: InputSkillDiscovery;
    confidence: number;
    assertActive: () => void;
  }): Promise<void> {
    params.assertActive();
    if (!params.association) return;
    const result = await tracker.mergeTurnAndPersist({
      assertActive: params.assertActive,
      currentTurnOnly: true,
      sessionId: params.association.sessionId,
      expectedTurnKey: params.association.turnKey,
      maxWaitMs: 0,
      data: {
        input: params.latestUserMessage,
        matchedSkills: params.matchedSkills?.map((skill) => skill.name) ?? [],
        inputSkillDiscovery: params.inputSkillDiscovery,
        confidence: params.confidence,
      },
    });
    params.assertActive();
    if (result === "stale") throw new Error("Prompt turn is no longer current");
  }

  function normalizeSkillCollection(
    collection: string,
  ): SkillCollectionKind | undefined {
    const norm = collection.trim().toLowerCase();
    if (norm === "skill-meta" || norm === "meta") return "meta";
    if (norm === "skill-body" || norm === "body") return "body";
    if (norm === "skill-references" || norm === "references")
      return "references";
    return undefined;
  }

  type SkillCandidateDiscoveryResult = {
    visibleSkills: AvailableSkill[];
    nameCandidates: SkillDiscoveryCandidate[];
    retrievalCandidates: SkillDiscoveryCandidate[];
    retrievalSemanticScores: number[];
    retrievalCollections: Record<SkillCollectionKind, number>;
    fallbackReason?: SkillCandidatePoolFallbackReason;
    startedAtMs: number;
  };

  async function discoverSkillCandidates(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): Promise<SkillCandidateDiscoveryResult> {
    const startedAtMs = Date.now();
    const policy = params.refreshedConfig.routing.skills;
    const retrievalCollections: Record<SkillCollectionKind, number> = {
      meta: 0,
      body: 0,
      references: 0,
    };

    let visibleSkills: AvailableSkill[] = [];
    try {
      visibleSkills = await listAvailableSkills({
        api,
        agentId: params.routing.effectiveAgentId,
        bundledSkillsDir,
        nativeBundledSkillsDir: await nativeBundledSkillsDir,
        sharedRoots: sharedRoots(),
        usageStats: {},
      });
    } catch (error) {
      logger.warn(formatErrorDiagnostic("listAvailableSkills failed", error));
    }
    params.ctx.hookInvocation?.assertActive();

    let nameCandidates: SkillDiscoveryCandidate[] = [];
    let matchedTokens: string[] = [];
    let fallbackReason: SkillCandidatePoolFallbackReason | undefined;
    let nameMatchStatus: "completed" | "error" = "completed";
    let nameMatchError: string | undefined;
    const nameMatchStartedAtMs = Date.now();

    try {
      const nameMatchResult = matchAvailableSkillNamesWithTokens({
        skills: visibleSkills,
        input: params.latestUserMessage,
        options: policy.nameMatch,
      });
      nameCandidates = nameMatchResult.candidates.map((candidate) => ({
        ...candidate,
        collections: ["meta" as const],
        topCollection: "meta" as const,
      }));
      matchedTokens = nameMatchResult.matchedTokens;
    } catch (error) {
      nameMatchStatus = "error";
      nameMatchError = eventError(error);
      fallbackReason = "name-channel-unavailable";
      logger.warn(
        formatErrorDiagnostic("skill name candidate matching failed", error),
      );
    } finally {
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "name-match",
        "completed",
        {
          status: nameMatchStatus,
          result: nameCandidates.map((candidate) => candidate.skillName),
          reason: matchedTokens,
          confidence: nameCandidates.length
            ? Math.max(...nameCandidates.map((candidate) => candidate.score))
            : undefined,
          ...(nameMatchError ? { error: nameMatchError } : {}),
          candidateCount: nameCandidates.length,
          matches: nameCandidates.map((candidate) => ({
            name: candidate.skillName,
            score: candidate.score,
          })),
          durationMs: Math.max(0, Date.now() - nameMatchStartedAtMs),
        },
      );
    }

    let retrievalCandidates: SkillDiscoveryCandidate[] = [];
    let retrievalSemanticScores: number[] = [];

    const expansionContext = formatConversationExpansionContext({
      conversation: params.conversation,
      candidateTokens: matchedTokens,
    });

    const searchSkills = async () => {
      const searchStartedAtMs = Date.now();
      let status: "completed" | "unavailable" | "timeout" | "error" =
        "unavailable";
      let searchError: string | undefined;
      let searchReason: string | undefined;
      let searchConfidence: number | undefined;
      let hits: { id: string; semanticScore: number | null }[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!qmdSkillIndex) {
          fallbackReason = "retrieval-unavailable";
          searchError = "qmd skill index unavailable";
          return;
        }
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), policy.search.timeoutMs);
        });
        const outcome = await Promise.race([
          qmdSkillIndex
            .search({
              agentId: params.routing.effectiveAgentId,
              query: params.latestUserMessage,
              limit: policy.maxInjectedSkills,
              includeEvidence: true,
              ...(expansionContext ? { expansionContext } : {}),
            })
            .then((hits) => ({ hits }))
            .catch((error) => ({ error })),
          timeout,
        ]);
        if (outcome === "timeout") {
          status = "timeout";
          fallbackReason = "retrieval-timeout";
          searchError = "qmd skill search timed out";
        } else if ("error" in outcome) {
          throw outcome.error;
        } else if (outcome.hits === undefined) {
          fallbackReason = "retrieval-unavailable";
          searchError = "qmd skill index unavailable";
        } else {
          status = "completed";
          hits = outcome.hits.map((hit) => ({
            id: hit.name,
            semanticScore: hit.semanticScore ?? null,
          }));
          retrievalSemanticScores = outcome.hits.flatMap((hit) =>
            hit.semanticScore === undefined ? [] : [hit.semanticScore],
          );
          retrievalCandidates = outcome.hits.flatMap((hit) => {
            if (
              hit.semanticScore === undefined ||
              roundToDecimals(hit.semanticScore, 2) <
                roundToDecimals(policy.search.minCandidateScore, 2)
            ) {
              return [];
            }
            const collections = [
              ...new Set(
                (hit.evidence ?? [])
                  .map((e) => normalizeSkillCollection(e.collection))
                  .filter((c): c is SkillCollectionKind => c !== undefined),
              ),
            ];
            const topCollection = hit.evidence?.[0]
              ? normalizeSkillCollection(hit.evidence[0].collection)
              : collections[0];

            return [
              {
                skillName: hit.name,
                score: hit.semanticScore,
                source: "direct-retrieval" as const,
                collections: collections.length > 0 ? collections : undefined,
                topCollection,
                evidence: hit.evidence,
              },
            ];
          });
          for (const candidate of retrievalCandidates) {
            for (const col of candidate.collections ?? []) {
              retrievalCollections[col] += 1;
            }
          }
          const topHit = outcome.hits.find((hit) =>
            retrievalCandidates.some(
              (candidate) => candidate.skillName === hit.name,
            ),
          );
          if (topHit) {
            searchReason = `#1 ${topHit.name} · RRF ${topHit.score.toFixed(4)}`;
            searchConfidence = topHit.semanticScore;
          }
        }
      } catch (error) {
        status = "error";
        searchError = eventError(error);
        fallbackReason = "retrieval-unavailable";
        logger.warn(
          formatErrorDiagnostic("skill candidate retrieval failed", error),
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        emitPipelineEvent(
          params.ctx,
          params.routing.resolvedSessionKey,
          "search",
          "completed",
          {
            status,
            result: retrievalCandidates.map((candidate) => candidate.skillName),
            ...(searchReason ? { reason: searchReason } : {}),
            ...(searchConfidence === undefined
              ? {}
              : { confidence: searchConfidence }),
            ...(searchError ? { error: searchError } : {}),
            minCandidateScore: policy.search.minCandidateScore,
            hits,
            candidateCount: retrievalCandidates.length,
            collectionHits: retrievalCollections,
            durationMs: Math.max(0, Date.now() - searchStartedAtMs),
          },
        );
      }
    };

    await searchSkills();

    return {
      visibleSkills,
      nameCandidates,
      retrievalCandidates,
      retrievalSemanticScores,
      retrievalCollections,
      fallbackReason,
      startedAtMs,
    };
  }

  async function resolveWorkingSetSkillsXml(
    agentId: string,
  ): Promise<string | undefined> {
    try {
      let workingSetSkillNames: string[] = [];
      if (deps.getWorkingSetSkills) {
        try {
          workingSetSkillNames = await deps.getWorkingSetSkills(agentId);
        } catch (error) {
          logger.warn(
            `failed to retrieve working-set agent skill names ${JSON.stringify({
              errorType: error instanceof Error ? "Error" : typeof error,
              workingSetSkillCount: 0,
            })}`,
          );
        }
      }

      let explicitSkills: Awaited<ReturnType<typeof resolveAvailableSkills>> =
        [];
      try {
        explicitSkills = await resolveAvailableSkills({
          api,
          agentId,
          bundledSkillsDir,
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
          skillNames: workingSetSkillNames,
        });
      } catch (error) {
        logger.warn(
          `failed to resolve working-set agent skills ${JSON.stringify({
            errorType: error instanceof Error ? "Error" : typeof error,
            workingSetSkillCount: workingSetSkillNames.length,
          })}`,
        );
      }

      async function loadDiscoveredSkills(
        source: "workspace" | "workshop",
      ): Promise<Awaited<ReturnType<typeof listAvailableSkills>>> {
        try {
          return await listAvailableSkills({
            api,
            agentId,
            bundledSkillsDir,
            nativeBundledSkillsDir: await nativeBundledSkillsDir,
            sharedRoots: sharedRoots(),
            source,
            usageStats: {},
          });
        } catch (error) {
          logger.warn(
            `${
              source === "workspace"
                ? "failed to resolve workspace agent skills"
                : "failed to resolve agent workshop skills"
            } ${JSON.stringify({
              errorType: error instanceof Error ? "Error" : typeof error,
              [source === "workspace"
                ? "workspaceSkillCount"
                : "workshopSkillCount"]: 0,
            })}`,
          );
          return [];
        }
      }

      const includeWorkspaceSkills =
        deps.config?.().skills?.includeWorkspaceSkills ?? true;
      const includeWorkshopSkills =
        deps.config?.().skills?.includeWorkshopSkills ?? true;

      const [workspaceSkills, workshopSkills] = await Promise.all([
        includeWorkspaceSkills ? loadDiscoveredSkills("workspace") : [],
        includeWorkshopSkills ? loadDiscoveredSkills("workshop") : [],
      ]);

      const skills = [...explicitSkills];
      const seen = new Set(
        explicitSkills.map((skill) => skill.name.trim().toLowerCase()),
      );
      for (const discoveredSkills of [workspaceSkills, workshopSkills]) {
        for (const skill of discoveredSkills) {
          const normalizedName = skill.name.trim().toLowerCase();
          if (seen.has(normalizedName)) continue;
          skills.push(skill);
          seen.add(normalizedName);
        }
      }
      if (!skills.length) {
        logger.info(
          `no working-set, workspace, or workshop agent skills could be resolved ${JSON.stringify({ workingSetSkillCount: 0 })}`,
        );
        return undefined;
      }
      const workingSetSkillsXml = formatWorkingSetSkills(skills);
      logger.info(
        `working-set skills static context emitted ${JSON.stringify({
          workingSetSkillCount: skills.length,
          staticHeader: workingSetSkillsXml.includes("### Working set skills"),
          workingSetWrapper: workingSetSkillsXml.includes(
            "<working_set_skills>",
          ),
          workingSetSkillTag: workingSetSkillsXml.includes("<skill "),
        })}`,
      );
      return workingSetSkillsXml;
    } catch (error) {
      logger.warn(
        `failed to resolve working-set agent skills for prompt build ${JSON.stringify(
          {
            errorType: error instanceof Error ? "Error" : typeof error,
            workingSetSkillCount: 0,
          },
        )}`,
      );
      return undefined;
    }
  }

  async function runPromptBuildPipeline<T>(
    ctx: PluginHookAgentContext,
    sessionKey: string | undefined,
    timeoutMs: number,
    operation: (
      ctx: PluginHookAgentContext,
      assertActive: () => void,
      signal: AbortSignal,
    ) => Promise<T>,
    parentSignal: AbortSignal,
  ): Promise<T> {
    const startedAtMs = Date.now();
    emitPipelineEvent(ctx, sessionKey, "pipeline", "started");
    try {
      const result = await withPromptDeadline(
        timeoutMs,
        () => ctx.hookInvocation?.assertActive(),
        (assertActive, signal) =>
          promptExecutions.track(
            operation(
              { ...ctx, hookInvocation: { assertActive } },
              assertActive,
              signal,
            ),
          ),
        parentSignal,
      );
      ctx.hookInvocation?.assertActive();
      if (parentSignal.aborted)
        throw new Error("Skill Harness prompt operation cancelled");
      emitPipelineEvent(ctx, sessionKey, "pipeline", "completed", {
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
      return result;
    } catch (error) {
      emitPipelineEvent(ctx, sessionKey, "pipeline", "failed", {
        error: eventError(error),
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
    let workingSetSkillsXml: string | undefined;
    let intentContextEnabled = false;
    let request: PromptRequestOwner<string | undefined> | undefined;
    try {
      ctx.hookInvocation?.assertActive();
      // Preserve static-only fallback after dynamic shutdown for a supplied key.
      // A lookup already pending at shutdown still fails its original fences.
      if (promptExecutions.isStopped) {
        if (
          !ctx.sessionKey?.trim() ||
          shouldSkipSkillSystemContext(ctx) ||
          ctx.inputProvenance?.kind === "inter_session" ||
          ctx.inputProvenance?.kind === "internal_system" ||
          (event.currentUserMessage === undefined && isInternalUserTurn(event))
        )
          return;
        const staticContext = await resolveWorkingSetSkillsXml(
          resolveStatusUpdateAgentId(ctx),
        );
        ctx.hookInvocation?.assertActive();
        return toPromptBuildResult(undefined, staticContext);
      }
      promptExecutions.assertActive();
      const admissionId =
        typeof event.currentUserMessageId === "string"
          ? event.currentUserMessageId
          : undefined;
      const ownerSessionId =
        ctx.sessionId ??
        tracker.resolveCurrentSessionId?.({ sessionKey: ctx.sessionKey });
      const runId = ctx.runId?.trim() || undefined;
      const legacyInput =
        admissionId === undefined && !runId
          ? buildConversationContext(
              event,
              ctx,
              config(),
            ).latestUserMessage.trim()
          : undefined;
      request = ownerSessionId
        ? promptExecutions.claimRequest(
            {
              agentId: resolveStatusUpdateAgentId(ctx),
              sessionId: ownerSessionId,
              admissionId,
              runId,
              legacyInput,
            },
            (agentId, sessionId, id) =>
              tracker.getNativeTurnIdentity?.(sessionId, agentId, id),
          )
        : undefined;
      if (admissionId !== undefined && ctx.runId) {
        // This is an event-rejection fence, not a turn reservation or admission.
        turnAssociations.claimNativeRun(
          ctx.runId,
          request ?? {},
          ownerSessionId,
        );
      }
      const nativeRequest =
        request?.admissionId !== undefined ? request : undefined;
      const replay =
        nativeRequest?.retainedReplay ??
        (nativeRequest?.state !== "current"
          ? nativeRequest?.association
          : undefined);
      const bindNativeReplay = (
        owner: PromptRequestOwner<string | undefined>,
        replay: TurnAssociation,
        sessionKey: string | undefined,
      ) => {
        if (runId) {
          turnAssociations.bindNativeRun(runId, owner, {
            ...replay,
            sessionKey: sessionKey || replay.sessionKey,
          });
        }
        if (replay.finalized) turnAssociations.markAssociationTerminal(replay);
      };
      const assertRequestActive = (allowFinalized = false) => {
        ctx.hookInvocation?.assertActive();
        promptExecutions.assertActive();
        if (request && !replay)
          promptExecutions.assertRequestCurrent(request, allowFinalized);
      };
      assertRequestActive(true);
      const routing = await resolvePromptBuildIdentity(
        ctx,
        replay ? undefined : request,
        !replay && admissionId !== undefined,
      );
      assertRequestActive(true);
      if (nativeRequest && replay) {
        // Settled lifecycle can finalize the retained owner during the SDK lookup.
        const currentReplay =
          nativeRequest.retainedReplay ?? nativeRequest.association ?? replay;
        routing.resolvedSessionKey ||= currentReplay.sessionKey;
        bindNativeReplay(
          nativeRequest,
          currentReplay,
          routing.resolvedSessionKey,
        );
        if (nativeRequest.retainedReplay) return;
      }
      if (request) request.resolvedSessionKey = routing.resolvedSessionKey;
      resolvedSessionKey = routing.resolvedSessionKey ?? resolvedSessionKey;

      const resolvedContext = {
        ...ctx,
        sessionKey: resolvedSessionKey,
      };
      if (shouldSkipSkillSystemContext(resolvedContext)) return;
      if (
        ctx.inputProvenance?.kind === "inter_session" ||
        ctx.inputProvenance?.kind === "internal_system" ||
        (event.currentUserMessage === undefined && isInternalUserTurn(event))
      )
        return;

      ctx.hookInvocation?.assertActive();
      staticContextEligible = true;
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      workingSetSkillsXml = await promptExecutions.track(
        resolveWorkingSetSkillsXml(routing.effectiveAgentId),
      );
      assertRequestActive(true);
      if (
        admissionId !== undefined &&
        (!request || replay || request.state === "finalized")
      ) {
        if (!replay && nativeRequest?.association)
          bindNativeReplay(
            nativeRequest,
            nativeRequest.association,
            routing.resolvedSessionKey,
          );
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }
      intentContextEnabled = isEnabledForAgent(
        refreshedConfig,
        routing.effectiveAgentId,
      );

      if (!intentContextEnabled) {
        return toPromptBuildResult(undefined, workingSetSkillsXml, false);
      }
      if (!isPromptBuildChatAllowed(resolvedContext, resolvedSessionKey)) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }
      if (shouldSkipIntentAnalysis(resolvedContext)) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }
      if (!isEligibleInteractiveSession(resolvedContext)) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      const { latestUserMessage, conversation } = buildConversationContext(
        event,
        ctx,
        refreshedConfig,
      );
      ctx.hookInvocation?.assertActive();
      const requestLength = latestUserMessage.trim().length;
      if (requestLength === 0) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }
      routing.association = await prepareTrackingTurn({
        ctx,
        routing,
        latestUserMessage,
        recentTurns:
          admissionId === undefined
            ? extractRecentTurns(event.messages, { finalRepliesOnly: true })
            : undefined,
      });
      assertRequestActive(true);
      if (!routing.association) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      ctx.hookInvocation?.assertActive();
      if (
        tracker.getCurrentState(routing.association.sessionId)?.turnKey !==
        routing.association.turnKey
      ) {
        throw new Error("Skill Harness prompt turn superseded");
      }
      if (request) request.association = routing.association;
      promptExecutions.observe(routing.association);

      if (
        requestLength < refreshedConfig.routing.minTriggerChars ||
        refreshedConfig.routing.skills.maxInjectedSkills === 0
      ) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      logger.debug(
        `before_prompt_build hook triggered ${JSON.stringify({
          hasSessionId: Boolean(ctx.sessionId),
          hasSessionKey: Boolean(ctx.sessionKey),
          hasRunId: Boolean(ctx.runId),
          hasModelProviderId: Boolean(ctx.modelProviderId),
          hasModelId: Boolean(ctx.modelId),
        })}`,
      );

      const runDynamic =
        request?.admissionId !== undefined
          ? promptExecutions.runRequest.bind(promptExecutions, request)
          : promptExecutions.run.bind(promptExecutions);
      const dynamicContext = await runDynamic(
        routing.association,
        (turnSignal) =>
          runPromptBuildPipeline(
            ctx,
            routing.resolvedSessionKey,
            promptRoutingBudgetMs(refreshedConfig.routing),
            async (ctx, assertDeadlineActive, pipelineSignal) => {
              const association = routing.association!;
              const assertActive = () => {
                assertDeadlineActive();
                assertRequestActive();
                if (
                  tracker.getCurrentState(association.sessionId)?.turnKey !==
                  association.turnKey
                ) {
                  throw new Error("Skill Harness prompt turn superseded");
                }
              };
              ctx = { ...ctx, hookInvocation: { assertActive } };
              assertActive();
              const skillDiscoveryResult = await discoverSkillCandidates({
                ctx,
                routing,
                refreshedConfig,
                latestUserMessage,
                conversation,
              });

              assertActive();
              const unionPool = buildCandidateSkillsUnionPool({
                visibleSkills: skillDiscoveryResult.visibleSkills,
                nameCandidates: skillDiscoveryResult.nameCandidates,
                retrievalCandidates: skillDiscoveryResult.retrievalCandidates,
                maxInjectedSkills:
                  refreshedConfig.routing.skills.maxInjectedSkills,
              });

              const relationGraph =
                unionPool.candidateSkills.length > 0 && deps.dataRoot
                  ? await resolveRelationGraph(
                      deps.dataRoot,
                      skillDiscoveryResult.visibleSkills,
                    )
                  : new Map();
              const related = expandRelatedCandidates(
                unionPool.candidateSkills,
                skillDiscoveryResult.visibleSkills,
                relationGraph,
              );
              const superset = buildSkillCandidateSuperset({
                originals: unionPool.candidateSkills,
                nameCandidates: skillDiscoveryResult.nameCandidates,
                retrievalCandidates: skillDiscoveryResult.retrievalCandidates,
                expanded: related.candidateSkills,
                expandedNames: related.added,
                visibleSkills: skillDiscoveryResult.visibleSkills,
                enabled: true,
              });
              const relationEvidence = collectRelationEvidence(
                superset.candidateSkills,
                skillDiscoveryResult.visibleSkills,
                relationGraph,
              );
              assertActive();

              let relationDecisions: RelationDecision[] = [];
              let confidence = 0;
              let matchedSkills: readonly AvailableSkill[] = [];
              let selectedSkills: string[] = [];
              let rerankStatus:
                "completed" | "skipped" | "unavailable" | "error" = "skipped";
              let rerankError: string | undefined;
              const rerankStartedAtMs = Date.now();
              const visibleMap = new Map(
                skillDiscoveryResult.visibleSkills.map((s) => [
                  canonicalIdentity(s.name),
                  s,
                ]),
              );

              if (superset.candidateSkills.length > 0) {
                try {
                  const llmResult = await withPromptDeadline(
                    refreshedConfig.routing.timeoutMs,
                    assertActive,
                    async (assertSelectorActive, signal) =>
                      promptExecutions.track(
                        effectiveRoutingSelector({
                          api,
                          config: refreshedConfig,
                          agentId: routing.effectiveAgentId,
                          sessionKey: routing.resolvedSessionKey,
                          sessionId: ctx.sessionId,
                          conversation,
                          latest: latestUserMessage,
                          messageProvider: ctx.messageProvider,
                          channelId: ctx.channelId,
                          candidateSkills: superset.candidateSkills,
                          candidateSources: superset.candidateSources,
                          relatedEvidence: related.evidence,
                          relationEvidence,
                          dataRoot: deps.dataRoot,
                          signal,
                          assertActive: assertSelectorActive,
                        }),
                      ),
                    pipelineSignal,
                  );
                  assertActive();

                  if (llmResult) {
                    rerankStatus = "completed";
                    relationDecisions = llmResult.relationDecisions ?? [];
                    confidence = llmResult.confidence;
                    selectedSkills = [...llmResult.skills];

                    const candidates = new Set(
                      superset.candidateSkills.map((skill) =>
                        canonicalIdentity(skill.name),
                      ),
                    );
                    matchedSkills = [
                      ...new Set(llmResult.skills.map(canonicalIdentity)),
                    ]
                      .filter((name) => candidates.has(name))
                      .flatMap((name) => {
                        const skill = visibleMap.get(name);
                        return skill ? [skill] : [];
                      })
                      .slice(
                        0,
                        refreshedConfig.routing.skills.maxInjectedSkills,
                      );
                  } else {
                    rerankStatus = "unavailable";
                    rerankError = "Routing selection unavailable";
                  }
                } catch (error) {
                  rerankStatus = "error";
                  rerankError = "Routing selection failed";
                  logger.warn(
                    `routing selector execution failed ${JSON.stringify({
                      reason: "selection-failed",
                    })}`,
                  );
                }
              }

              assertActive();
              const injectedCollections: Record<SkillCollectionKind, number> = {
                meta: 0,
                body: 0,
                references: 0,
              };
              const injectedCandidates: InputSkillDiscovery["injectedSkills"] =
                unionPool.pool
                  .filter((candidate) =>
                    matchedSkills.some(
                      (skill) => skill.name === candidate.skillName,
                    ),
                  )
                  .map((candidate) => {
                    for (const col of candidate.collections ?? []) {
                      injectedCollections[col] += 1;
                    }
                    return {
                      name: candidate.skillName,
                      source: candidate.source,
                      collections: candidate.collections,
                      topCollection: candidate.topCollection,
                    };
                  });

              const finalSkillNames = new Set(
                matchedSkills.map((skill) => canonicalIdentity(skill.name)),
              );
              relationDecisions = relationDecisions.map((decision) => ({
                ...decision,
                injected:
                  decision.score >=
                    refreshedConfig.routing.skills.related.relevanceThreshold &&
                  finalSkillNames.has(canonicalIdentity(decision.skill)),
              }));
              for (const skill of matchedSkills) {
                const sources = superset.candidateSources[skill.name] ?? [];
                const recorded = injectedCandidates.find(
                  (candidate) => candidate.name === skill.name,
                );
                if (recorded) {
                  recorded.sources = sources;
                } else {
                  injectedCandidates.push({
                    name: skill.name,
                    source: "related-declared",
                    sources,
                  });
                }
              }
              const contributedBy: string[] = [];
              if (
                injectedCandidates.some(
                  (candidate) =>
                    candidate.sources?.includes("related-declared") ??
                    candidate.source === "related-declared",
                )
              )
                contributedBy.push("related-declared");
              if (
                skillDiscoveryResult.nameCandidates.some((candidate) =>
                  finalSkillNames.has(canonicalIdentity(candidate.skillName)),
                )
              ) {
                contributedBy.push("name-match");
              }
              if (
                skillDiscoveryResult.retrievalCandidates.some((candidate) =>
                  finalSkillNames.has(canonicalIdentity(candidate.skillName)),
                )
              ) {
                contributedBy.push("search");
              }

              const inputSkillDiscovery: InputSkillDiscovery = {
                nameCandidates: skillDiscoveryResult.nameCandidates.length,
                retrievalAttempted: Boolean(qmdSkillIndex),
                retrievalCandidates:
                  skillDiscoveryResult.retrievalCandidates.length,
                retrievalSemanticScores:
                  skillDiscoveryResult.retrievalSemanticScores,
                candidateCount: superset.candidateSkills.length,
                ...(related.added.length
                  ? { relatedCandidates: related.added }
                  : {}),
                ...(relationDecisions.length ? { relationDecisions } : {}),
                injectedSkills: injectedCandidates,
                retrievalCollections: skillDiscoveryResult.retrievalCollections,
                injectedCollections,
                ...(skillDiscoveryResult.fallbackReason
                  ? { fallbackReason: skillDiscoveryResult.fallbackReason }
                  : {}),
                durationMs: Math.max(
                  0,
                  Date.now() - skillDiscoveryResult.startedAtMs,
                ),
              };

              const preservePersistedSelection =
                request?.admissionId !== undefined &&
                rerankStatus !== "completed" &&
                Boolean(
                  tracker.getCurrentState(association.sessionId)?.matchedSkills
                    ?.length,
                );
              if (!preservePersistedSelection) {
                await recordPromptBuildSession({
                  assertActive,
                  association,
                  latestUserMessage,
                  matchedSkills,
                  inputSkillDiscovery,
                  confidence,
                });
              }
              assertActive();

              emitPipelineEvent(
                ctx,
                routing.resolvedSessionKey,
                "rerank",
                "completed",
                {
                  status: rerankStatus,
                  result: matchedSkills.map((skill) => skill.name),
                  reason: contributedBy,
                  ...(rerankStatus === "completed" ? { confidence } : {}),
                  ...(rerankError ? { error: rerankError } : {}),
                  selectedSkills,
                  candidateCount: superset.candidateSkills.length,
                  relatedCandidates: related.added,
                  ...(relationDecisions.length ? { relationDecisions } : {}),
                  injectedCount: matchedSkills.length,
                  injectedSkills: matchedSkills.map((s) => s.name),
                  durationMs: Math.max(0, Date.now() - rerankStartedAtMs),
                },
              );

              if (matchedSkills.length === 0) {
                return undefined;
              }
              return buildRoutingContext({
                matchedSkills,
                relationDecisions,
                relationRelevanceThreshold:
                  refreshedConfig.routing.skills.related.relevanceThreshold,
              });
            },
            turnSignal,
          ),
      );
      assertRequestActive();
      ctx.hookInvocation?.assertActive();
      promptExecutions.assertActive();
      if (
        tracker.getCurrentState(routing.association.sessionId)?.turnKey !==
        routing.association.turnKey
      ) {
        throw new Error("Skill Harness prompt turn superseded");
      }
      return toPromptBuildResult(dynamicContext, workingSetSkillsXml);
    } catch (err) {
      logger.warn(
        `before_prompt_build hook error ${JSON.stringify({
          errorType: err instanceof Error ? "Error" : typeof err,
          staticContextAvailable: Boolean(workingSetSkillsXml),
        })}`,
      );
      return staticContextEligible
        ? toPromptBuildResult(
            undefined,
            workingSetSkillsXml,
            intentContextEnabled,
          )
        : undefined;
    } finally {
      if (request) promptExecutions.releaseRequest(request);
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
      rememberToolCall(toolCallKey, association.sessionId);
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
    const association = resolveAssociatedTurn({
      eventRunId: event.runId,
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association || !toolCallKey) return;
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
      logger.warn(
        `discarded persisted tool fallback ${JSON.stringify({
          reason: staged,
        })}`,
      );
    }
  }

  function extractAgentEndPayload(params: {
    messages?: unknown[];
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
      result: result || undefined,
      error: params.error,
    };
  }

  async function recordFinalizedTurnStats(
    association: TurnAssociation,
    observePhase?: TurnFinalizationPhaseObserver,
  ) {
    const { sessionId, turnKey } = association;
    const state = tracker.getTurnState(sessionId, turnKey);
    if (!state) return;

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
      observePhase?.("inventory");
      try {
        const skills = await skillInventoryResolver({
          api,
          agentId,
          bundledSkillsDir,
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
        });
        if (skills) skillInventory = { agentId, skills };
      } catch (error) {
        logger.warn(
          `failed to resolve skill inventory for stats ${JSON.stringify(safeErrorClassification(error))}`,
        );
      }
    }
    observePhase?.("stats");
    if (skillInventory) {
      statsAggregator.record(sessionId, state, undefined, { skillInventory });
    } else {
      statsAggregator.record(sessionId, state);
    }
  }

  function enqueueReviewRun(params: {
    ctx: PluginHookAgentContext;
    resolvedConfig: ResolvedSkillHarnessPluginConfig;
    agentId: string;
    modelRef: NonNullable<ReturnType<typeof getReviewModelRef>>;
    snapshot: ReviewSnapshot;
  }): boolean {
    try {
      return reviewScheduler.schedule({
        agentId: params.agentId,
        sessionKey:
          params.ctx.sessionKey?.trim() ||
          params.snapshot.sessionKey?.trim() ||
          undefined,
        ctx: params.ctx,
        resolvedConfig: params.resolvedConfig,
        modelRef: params.modelRef,
        snapshot: params.snapshot,
      });
    } catch (error) {
      logger.warn(
        formatErrorDiagnostic("failed to enqueue Intent Review", error),
      );
      return false;
    }
  }

  async function finalizeTrackedTurn(
    association: TurnAssociation,
    ctx: AttemptContext,
    observePhase?: TurnFinalizationPhaseObserver,
  ): Promise<void> {
    await recordFinalizedTurnStats(association, observePhase);

    observePhase?.("review-preparation");
    const resolvedConfig = config();
    const reviewConfig = resolvedConfig.review;
    if (!reviewConfig.enabled) return;

    const snapshot = tracker.getReviewSnapshotForTurn(
      association.sessionId,
      association.turnKey,
    );
    if (
      !snapshot ||
      !isRelationReviewDue(
        snapshot.turnNumber,
        reviewConfig.triggers.relationHealthCheck.everyTurns,
      )
    )
      return;
    try {
      const isReviewPreparationActive = () => {
        if (api.lifecycle?.signal?.aborted || reviewScheduler.isDisposed?.())
          return false;
        return (
          tracker.getReviewSnapshotForTurn(
            association.sessionId,
            association.turnKey,
          )?.eventId === snapshot.eventId
        );
      };
      if (!isReviewPreparationActive()) return;
      const { getReviewModelRef } = await loadReviewSubagent();
      if (!isReviewPreparationActive()) return;

      const agentId = ctx.agentId ?? snapshot.agentId ?? "main";
      const modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
        modelProviderId: ctx.modelProviderId,
        modelId: ctx.modelId,
      });
      if (!modelRef) return;
      enqueueReviewRun({
        ctx,
        resolvedConfig,
        agentId,
        modelRef,
        snapshot,
      });
    } catch (error) {
      logger.warn(
        `failed to prepare Intent Review ${JSON.stringify(safeErrorClassification(error))}`,
      );
    }
  }

  async function onAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    const association = resolveAssociatedTurn({
      eventRunId: event.runId,
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    if (!association) return;

    const key = attemptKey(association);
    observedAttempts.delete(key);
    observedAttempts.set(key, {
      ...extractAgentEndPayload({
        messages: event.messages,
        error: event.error,
      }),
      success: event.success,
      ctx: {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        runId: ctx.runId,
        messageProvider: ctx.messageProvider,
        modelProviderId: ctx.modelProviderId,
        modelId: ctx.modelId,
      },
    });
    if (observedAttempts.size > maxObservedAttempts) {
      const oldest = observedAttempts.keys().next().value;
      if (oldest !== undefined) observedAttempts.delete(oldest);
    }
    await flushToolFallbacks(association);
  }

  async function onAgentLifecycleEvent(
    event: AgentLifecycleEvent,
  ): Promise<void> {
    const data = event.data;
    const phase = data?.phase;
    if (
      event.stream !== "lifecycle" ||
      (phase !== "end" && phase !== "error") ||
      data.executionSettled !== true ||
      isAgentLifecycleYieldedWaiting(data) ||
      typeof event.runId !== "string" ||
      !event.runId.trim()
    )
      return;

    const association = resolveAssociatedTurn({
      eventRunId: event.runId,
      sessionId: event.sessionId,
      sessionKey: event.sessionKey,
    });
    if (!association) return;

    const key = attemptKey(association);
    const observed = observedAttempts.get(key);
    const facts = resolveAgentRunLifecycleTerminalFacts({ phase, data });
    const result =
      facts.status === "ok"
        ? (observed?.success !== false ? observed?.result : undefined) ||
          extractTerminalReplyText(data.terminalReply)
        : observed?.result;
    const error =
      facts.status === "ok"
        ? undefined
        : (typeof data.error === "string" ? data.error.trim() : "") ||
          observed?.error ||
          facts.stopReason ||
          facts.reason;
    const endedAt =
      typeof data.endedAt === "number" && Number.isFinite(data.endedAt)
        ? data.endedAt
        : Number.isFinite(event.ts)
          ? event.ts
          : Date.now();
    const endedAtIso = new Date(endedAt);
    const ctx: AttemptContext = {
      ...observed?.ctx,
      agentId:
        observed?.ctx.agentId ?? tracker.getAgentId(association.sessionId),
      sessionId: association.sessionId,
      sessionKey:
        event.sessionKey?.trim() ||
        observed?.ctx.sessionKey ||
        association.sessionKey,
      runId: event.runId.trim(),
    };

    const startedAt = Date.now();
    let finalizationPhase: TurnFinalizationPhase = "finalize";
    let phaseStartedAt = startedAt;
    let slow = false;
    let outcome: "completed" | "skipped" | "failed" = "completed";
    const observePhase: TurnFinalizationPhaseObserver = (next) => {
      finalizationPhase = next;
      phaseStartedAt = Date.now();
    };
    const diagnostic = () => ({
      hook: "agent_lifecycle",
      phase: finalizationPhase,
      elapsedMs: Date.now() - startedAt,
      phaseElapsedMs: Date.now() - phaseStartedAt,
    });
    // Observe slow finalization without cancelling or racing durable work.
    const slowTimer = setTimeout(() => {
      slow = true;
      logger.warn(`agent_lifecycle slow ${JSON.stringify(diagnostic())}`);
    }, 25_000);
    slowTimer.unref?.();
    try {
      const stagedEntries = toolFallbacks.listForAssociation(association);
      const stagedToolFallbacks = stagedEntries.map(
        ([, { fallback, skillUsed }]) =>
          skillUsed ? { ...fallback, skillUsed } : fallback,
      );
      const finalized = await tracker.finalizeTurnFromAgentEnd({
        sessionId: association.sessionId,
        expectedTurnKey: association.turnKey,
        stagedToolFallbacks,
        result,
        error,
        endedAt: Number.isNaN(endedAtIso.getTime())
          ? new Date().toISOString()
          : endedAtIso.toISOString(),
      });
      if (
        finalized !== "applied" &&
        finalized !== "already-finalized" &&
        finalized !== "became-review-eligible"
      ) {
        outcome = "skipped";
        return;
      }
      promptExecutions.finalizeAssociation(association);
      turnAssociations.markAssociationTerminal(association);
      toolFallbacks.markAssociationTerminal(association);
      observedAttempts.delete(key);
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
              rememberFlushedToolCall(toolCallId, association.sessionId);
            }
          }
        }
        return;
      }
      for (const [toolCallId] of stagedEntries) {
        rememberFlushedToolCall(toolCallId, association.sessionId);
      }
      await finalizeTrackedTurn(association, ctx, observePhase);
    } catch (error) {
      outcome = "failed";
      logger.warn(
        `agent_lifecycle failed ${JSON.stringify({ ...diagnostic(), ...safeErrorClassification(error) })}`,
      );
      throw error;
    } finally {
      clearTimeout(slowTimer);
      if (slow) {
        logger.info(
          `agent_lifecycle settled after slow warning ${JSON.stringify({ ...diagnostic(), outcome })}`,
        );
      }
    }
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
    if (association) await flushToolFallbacks(association);
  }

  function rememberFlushedToolCall(
    toolCallId: string,
    sessionId: string,
  ): void {
    toolFallbacks.delete(toolCallId);
    pendingToolCalls.delete(toolCallId);
    rememberToolCall(toolCallId, sessionId);
  }

  async function flushToolFallbacks(
    association: TurnAssociation,
  ): Promise<void> {
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
        rememberFlushedToolCall(toolCallId, association.sessionId);
      }
    }
  }

  async function onSessionEnd(
    _event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    promptExecutions.removeSession(ctx.sessionId);
    turnAssociations.removeSession(ctx.sessionId);
    toolFallbacks.removeSession(ctx.sessionId);
    for (const key of observedAttempts.keys()) {
      if (key.startsWith(`${ctx.sessionId}\0`)) observedAttempts.delete(key);
    }
    for (const [toolCallId, pending] of pendingToolCalls) {
      if (pending.association.sessionId === ctx.sessionId) {
        pendingToolCalls.delete(toolCallId);
      }
    }
    for (const [toolCallId, sessionId] of recordedToolCalls) {
      if (sessionId === ctx.sessionId) recordedToolCalls.delete(toolCallId);
    }
    tracker.cleanup(ctx.sessionId, {
      deleteFile: false,
    });
    tracker.cleanupExpired();
  }

  return {
    disposePromptWork: () => promptExecutions.dispose(),
    onBeforePromptBuild,
    onBeforeToolCall,
    onAfterToolCall,
    onToolResultPersist,
    onBeforeAgentFinalize,
    onAgentEnd,
    onAgentLifecycleEvent,
    onSessionEnd,
    reviewScheduler,
  };
}
