import { canonicalIdentity, roundToDecimals } from "../normalize.js";
import type {
  InputSkillDiscovery,
  SkillCollectionKind,
} from "../session/index.js";
import type { RecentTurn, ResolvedSkillHarnessPluginConfig } from "../types.js";
import { logger } from "../../api.js";
import { defaultTracker, extractSkillInfo } from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { IntentReviewLogWriter } from "../review/log-writer.js";
import { checkReviewTriggers, type ReviewTrigger } from "../review/triggers.js";
import { getReviewModelRef, runReviewSubagent } from "../review/subagent.js";
import type {
  CapabilityFitEvidence,
  ReviewSnapshot,
  SelectedPlacementSkill,
  SkillPlacementReviewCandidate,
} from "../review/types.js";
import { createIntentReviewScheduler } from "../review/scheduler.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  extractLatestUserMessage,
  limitConversationTurns,
  extractRecentTurns,
  extractToolText,
  isInternalUserTurn,
  sanitizePromptInput,
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
import { experiencesPath, packageRoot } from "../file-utils.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import type { SkillExperienceEntry } from "../experiences/index.js";
import type { SkillExperienceHit } from "../qmd/experience-index.js";
import type { AvailableSkill, SkillInventoryItem } from "../skills/types.js";
import { matchAvailableSkillNamesWithTokens } from "../skills/name-index.js";
import {
  buildCandidateSkillsUnionPool,
  type SkillDiscoveryCandidate,
} from "../skills/candidate-pool.js";
import type { RoutingLlmResult } from "../types.js";
import {
  emitPipelineEvent,
  type SkillCandidatePoolFallbackReason,
} from "./pipeline-events.js";
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
  SKILL_HARNESS_ROUTING_CONTEXT,
  SKILL_HARNESS_SYSTEM_CONTEXT,
} from "./system-context.js";
export type { HookDeps } from "./types.js";

import { promptRoutingBudgetMs, withPromptDeadline } from "./prompt-budget.js";

const MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS = 12_000;

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
  const reviewer = deps.reviewer ?? runReviewSubagent;
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
            candidateExperiences: callParams.candidateExperiences,
            dataRoot: callParams.dataRoot,
          });
          if (!classified) return undefined;
          return {
            skills: classified.skills ?? [],
            experiences: classified.experiences ?? [],
            confidence: classified.confidence ?? 1.0,
            reason: classified.reason ?? "Selected relevant candidate skills",
          };
        }
      : runJevUnifiedRouting);
  const clock = deps.clock ?? (() => new Date());
  const experienceCatalog =
    deps.experienceCatalog ??
    (deps.dataRoot ? new SkillExperienceCatalog(deps.dataRoot) : undefined);
  const qmdSkillIndex = deps.qmdSkillIndex;
  const qmdExperienceIndex = deps.qmdExperienceIndex;

  const reviewLogWriter: NonNullable<HookDeps["reviewLogWriter"]> =
    deps.reviewLogWriter ??
    new IntentReviewLogWriter(deps.dataRoot ?? packageRoot);
  const bundledSkillsDir = deps.bundledSkillsDir;
  const nativeBundledSkillsDir = deps.nativeBundledSkillsDir;
  const sharedRoots = () => deps.getSharedRoots?.() ?? [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const toolFallbacks = deps.toolFallbacks ?? new ToolFallbackRegistry();
  const recordedToolCalls = new Set<string>();
  const pendingSkillEpochKeys = new Set<string>();
  const turnAssociations =
    deps.turnAssociations ?? new TurnAssociationRegistry();

  const reviewScheduler =
    deps.reviewScheduler ??
    createIntentReviewScheduler({
      isSystemActive: (candidate) => {
        const sessionKey = candidate.sessionKey ?? candidate.ctx.sessionKey;
        return turnAssociations.resolveSession(sessionKey) !== undefined;
      },
    });

  reviewScheduler.setRunner(async (candidate, abortSignal) => {
    try {
      const observedSkillNames = new Set(
        (candidate.snapshot.current.skillsUsed ?? []).map((skill) =>
          skill.name.trim().toLowerCase(),
        ),
      );
      let allowedExperienceSkills: string[] = [];
      try {
        const inventory = await skillInventoryResolver({
          api,
          agentId: candidate.agentId,
          bundledSkillsDir,
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
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
        config: candidate.resolvedConfig,
        agentId: candidate.agentId,
        experienceDirectory: experiencesPath(deps.dataRoot ?? "."),
        allowedExperienceSkills,
        sessionKey: candidate.ctx.sessionKey ?? candidate.snapshot.sessionKey,
        messageProvider: candidate.ctx.messageProvider,
        modelRef: candidate.modelRef,
        snapshot: candidate.snapshot,
        triggers: candidate.triggers,
        dataRoot: deps.dataRoot,
        abortSignal,
      });
      if (!reviewResult || abortSignal.aborted) return;
      await reviewLogWriter.record(
        candidate.snapshot.eventId,
        {
          sessionId: candidate.snapshot.sessionId,
          sessionKey: candidate.snapshot.sessionKey,
          agentId: candidate.snapshot.agentId,
          turnStart: candidate.snapshot.current.timestamps!.start!,
        },
        reviewResult.findings,
        {
          triggers: candidate.triggers,
          outcome: reviewResult.outcome,
          changedExperienceIds: reviewResult.changedExperienceIds,
          validationErrors: reviewResult.validationErrors,
          noFindingReasonCounts: reviewResult.noFindingReasonCounts,
          schemaRejectionReasonCounts: reviewResult.schemaRejectionReasonCounts,
          skillPlacementCandidate: candidate.skillPlacementCandidate,
        },
      );
      if (
        reviewResult.changedExperienceIds?.length &&
        experienceCatalog &&
        qmdExperienceIndex
      ) {
        qmdExperienceIndex.schedule(experienceCatalog.listAll());
      }
    } finally {
      if (candidate.skillPlacementCandidate) {
        pendingSkillEpochKeys.delete(
          candidate.skillPlacementCandidate.epochKey,
        );
      }
    }
  });

  reviewScheduler.setOnDiscard((candidate) => {
    if (candidate.skillPlacementCandidate) {
      pendingSkillEpochKeys.delete(candidate.skillPlacementCandidate.epochKey);
    }
  });

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

    try {
      const prepared = await tracker.preparePromptTurn({
        sessionId,
        sessionKey: params.routing.resolvedSessionKey ?? params.ctx.sessionKey,
        agentId: params.routing.effectiveAgentId,
        runId,
        input: params.latestUserMessage,
        startedAt: new Date().toISOString(),
        recentTurns: params.recentTurns,
        assertActive: () => params.ctx.hookInvocation?.assertActive(),
      });
      params.ctx.hookInvocation?.assertActive();
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
    _ctx: PluginHookAgentContext,
    refreshedConfig: ResolvedSkillHarnessPluginConfig,
  ): {
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
  } {
    const latestUserMessage = extractLatestUserMessage(
      event.messages,
      event.prompt,
    );
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
    matchedExperiences?: readonly SkillExperienceEntry[];
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
        matchedExperiences:
          params.matchedExperiences?.map((entry) => entry.id) ?? [],
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
    candidateExperiences: SkillExperienceEntry[];
    experienceRetrieval: NonNullable<
      InputSkillDiscovery["experienceRetrieval"]
    >;
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
    const expPolicy = params.refreshedConfig.routing.experiences;
    const retrievalCollections: Record<SkillCollectionKind, number> = {
      meta: 0,
      body: 0,
      references: 0,
    };

    if (
      policy.maxInjectedSkills === 0 &&
      expPolicy.maxInjectedExperiences === 0
    ) {
      return {
        visibleSkills: [],
        nameCandidates: [],
        retrievalCandidates: [],
        candidateExperiences: [],
        experienceRetrieval: {
          status: "disabled",
          minCandidateScore: expPolicy.search.minCandidateScore,
          hits: [],
          candidateCount: 0,
        },
        retrievalSemanticScores: [],
        retrievalCollections,
        startedAtMs,
      };
    }

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
      logger.warn("listAvailableSkills failed", { error });
    }

    let nameCandidates: SkillDiscoveryCandidate[] = [];
    let matchedTokens: string[] = [];
    let fallbackReason: SkillCandidatePoolFallbackReason | undefined;
    let nameMatchStatus: "completed" | "disabled" | "error" =
      policy.maxInjectedSkills === 0 ? "disabled" : "completed";
    let nameMatchError: string | undefined;
    const nameMatchStartedAtMs = Date.now();

    try {
      const nameMatchResult =
        policy.maxInjectedSkills === 0
          ? { candidates: [], matchedTokens: [] }
          : matchAvailableSkillNamesWithTokens({
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
      logger.warn("skill name candidate matching failed", { error });
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
    let experienceCandidates: SkillDiscoveryCandidate[] = [];

    const expansionContext = formatConversationExpansionContext({
      conversation: params.conversation,
      candidateTokens: matchedTokens,
    });

    const searchSkills = async () => {
      const searchStartedAtMs = Date.now();
      let status:
        "completed" | "disabled" | "unavailable" | "timeout" | "error" =
        policy.maxInjectedSkills === 0 ? "disabled" : "unavailable";
      let searchError: string | undefined;
      let searchReason: string | undefined;
      let searchConfidence: number | undefined;
      let hits: { id: string; semanticScore: number | null }[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (policy.maxInjectedSkills === 0) return;
        if (!qmdSkillIndex) {
          fallbackReason = "retrieval-unavailable";
          searchError = "QMD skill index unavailable";
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
          searchError = "QMD skill search timed out";
        } else if ("error" in outcome) {
          throw outcome.error;
        } else if (outcome.hits === undefined) {
          fallbackReason = "retrieval-unavailable";
          searchError = "QMD skill index unavailable";
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
        logger.warn("skill candidate retrieval failed", { error });
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

    const candidateExperiences: SkillExperienceEntry[] = [];
    const experienceRetrieval: NonNullable<
      InputSkillDiscovery["experienceRetrieval"]
    > = {
      status:
        expPolicy.maxInjectedExperiences === 0 ? "disabled" : "unavailable",
      minCandidateScore: expPolicy.search.minCandidateScore,
      hits: [],
      candidateCount: 0,
    };
    const searchExperiences = async () => {
      const searchStartedAtMs = Date.now();
      let searchError: string | undefined;
      let searchReason: string | undefined;
      let searchConfidence: number | undefined;
      let expTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (expPolicy.maxInjectedExperiences === 0) return;
        if (!qmdExperienceIndex) {
          searchError = "QMD experience index unavailable";
          return;
        }
        const timeout = new Promise<"timeout">((resolve) => {
          expTimer = setTimeout(
            () => resolve("timeout"),
            expPolicy.search.timeoutMs,
          );
        });
        const expOutcome = await Promise.race([
          qmdExperienceIndex
            .search({
              query: params.latestUserMessage,
              limit: expPolicy.maxInjectedExperiences * 3,
              ...(expansionContext ? { expansionContext } : {}),
            })
            .then((hits) => ({ hits }))
            .catch((error) => ({ error })),
          timeout,
        ]);
        if (expOutcome === "timeout") {
          experienceRetrieval.status = "timeout";
          searchError = "QMD experience search timed out";
        } else if ("error" in expOutcome) {
          experienceRetrieval.status = "error";
          throw expOutcome.error;
        } else if (expOutcome.hits) {
          experienceRetrieval.status = "completed";
          experienceRetrieval.hits = expOutcome.hits.map((hit) => ({
            id: hit.id,
            semanticScore: hit.semanticScore,
          }));
        }
        if (
          expOutcome !== "timeout" &&
          !("error" in expOutcome) &&
          expOutcome.hits
        ) {
          const qualifiedHits = expOutcome.hits.filter(
            (hit) =>
              roundToDecimals(hit.semanticScore, 2) >=
              roundToDecimals(expPolicy.search.minCandidateScore, 2),
          );
          const topHit = qualifiedHits[0];
          if (topHit) {
            searchReason = `#1 ${topHit.id} · RRF ${topHit.score.toFixed(4)}`;
            searchConfidence = topHit.semanticScore;
          }
          for (const hit of qualifiedHits) {
            const resolved = experienceCatalog?.resolve(hit.id);
            if (resolved) {
              candidateExperiences.push(resolved);
            } else {
              candidateExperiences.push({
                id: hit.id,
                skills: [...hit.skills],
                summary: "",
                keywords: [],
                body: "",
                path: "",
              });
            }
          }
          experienceRetrieval.candidateCount = candidateExperiences.length;
        } else if (expOutcome !== "timeout" && !("error" in expOutcome)) {
          searchError = "QMD experience index unavailable";
        }
      } catch (error) {
        experienceRetrieval.status = "error";
        searchError = eventError(error);
        logger.warn("experience candidate retrieval failed", { error });
      } finally {
        if (expTimer !== undefined) clearTimeout(expTimer);
        emitPipelineEvent(
          params.ctx,
          params.routing.resolvedSessionKey,
          "experience-search",
          "completed",
          {
            status: experienceRetrieval.status,
            result: [
              ...new Set(candidateExperiences.flatMap((entry) => entry.skills)),
            ],
            ...(searchReason ? { reason: searchReason } : {}),
            ...(searchConfidence === undefined
              ? {}
              : { confidence: searchConfidence }),
            ...(searchError ? { error: searchError } : {}),
            minCandidateScore: experienceRetrieval.minCandidateScore,
            hits: experienceRetrieval.hits,
            candidateCount: experienceRetrieval.candidateCount,
            durationMs: Math.max(0, Date.now() - searchStartedAtMs),
          },
        );
      }
    };

    await Promise.all([searchSkills(), searchExperiences()]);

    return {
      visibleSkills,
      nameCandidates,
      retrievalCandidates,
      candidateExperiences,
      experienceRetrieval,
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
          logger.warn("failed to retrieve working-set agent skill names", {
            errorType: error instanceof Error ? "Error" : typeof error,
            workingSetSkillCount: 0,
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
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
          skillNames: workingSetSkillNames,
        });
      } catch (error) {
        logger.warn("failed to resolve working-set agent skills", {
          errorType: error instanceof Error ? "Error" : typeof error,
          workingSetSkillCount: workingSetSkillNames.length,
        });
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
            source === "workspace"
              ? "failed to resolve workspace agent skills"
              : "failed to resolve agent workshop skills",
            {
              errorType: error instanceof Error ? "Error" : typeof error,
              [source === "workspace"
                ? "workspaceSkillCount"
                : "workshopSkillCount"]: 0,
            },
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
          "no working-set, workspace, or workshop agent skills could be resolved",
          { workingSetSkillCount: 0 },
        );
        return undefined;
      }
      const workingSetSkillsXml = formatWorkingSetSkills(skills);
      logger.info("working-set skills static context emitted", {
        workingSetSkillCount: skills.length,
        staticHeader: workingSetSkillsXml.includes("### Working set skills"),
        workingSetWrapper: workingSetSkillsXml.includes("<working_set_skills>"),
        workingSetSkillTag: workingSetSkillsXml.includes("<skill "),
      });
      return workingSetSkillsXml;
    } catch (error) {
      logger.warn(
        "failed to resolve working-set agent skills for prompt build",
        {
          errorType: error instanceof Error ? "Error" : typeof error,
          workingSetSkillCount: 0,
        },
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
    ) => Promise<T>,
  ): Promise<T> {
    const startedAtMs = Date.now();
    emitPipelineEvent(ctx, sessionKey, "pipeline", "started");
    try {
      const result = await withPromptDeadline(
        timeoutMs,
        () => ctx.hookInvocation?.assertActive(),
        (assertActive) =>
          operation({ ...ctx, hookInvocation: { assertActive } }, assertActive),
      );
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
    try {
      const routing = resolvePromptBuildIdentity(ctx);
      resolvedSessionKey = routing.resolvedSessionKey ?? resolvedSessionKey;

      const resolvedContext = {
        ...ctx,
        sessionKey: resolvedSessionKey,
      };
      if (shouldSkipSkillSystemContext(resolvedContext)) return;
      if (
        ctx.inputProvenance?.kind === "inter_session" ||
        ctx.inputProvenance?.kind === "internal_system" ||
        isInternalUserTurn(event)
      )
        return;

      ctx.hookInvocation?.assertActive();
      staticContextEligible = true;
      refreshLiveConfigFromRuntime();
      const refreshedConfig = config();
      workingSetSkillsXml = await resolveWorkingSetSkillsXml(
        routing.effectiveAgentId,
      );
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
      routing.association = await prepareTrackingTurn({
        ctx,
        routing,
        latestUserMessage,
        recentTurns: extractRecentTurns(event.messages),
      });
      if (!routing.association) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      if (
        refreshedConfig.routing.skills.maxInjectedSkills === 0 &&
        refreshedConfig.routing.experiences.maxInjectedExperiences === 0
      ) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      logger.debug("before_prompt_build hook triggered", {
        hasSessionId: Boolean(ctx.sessionId),
        hasSessionKey: Boolean(ctx.sessionKey),
        hasRunId: Boolean(ctx.runId),
        hasModelProviderId: Boolean(ctx.modelProviderId),
        hasModelId: Boolean(ctx.modelId),
      });

      return await runPromptBuildPipeline(
        ctx,
        routing.resolvedSessionKey,
        promptRoutingBudgetMs(refreshedConfig.routing),
        async (ctx, assertDeadlineActive) => {
          const association = routing.association!;
          const assertActive = () => {
            assertDeadlineActive();
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
            maxInjectedSkills: refreshedConfig.routing.skills.maxInjectedSkills,
          });

          let confidence = 0;
          let matchedSkills: readonly AvailableSkill[] = [];
          let matchedExperiences: SkillExperienceEntry[] = [];
          let selectedSkills: string[] = [];
          let selectedExperiences: string[] = [];
          let rerankStatus: "completed" | "skipped" | "unavailable" | "error" =
            "skipped";
          let rerankError: string | undefined;
          const rerankStartedAtMs = Date.now();
          const visibleMap = new Map(
            skillDiscoveryResult.visibleSkills.map((s) => [
              canonicalIdentity(s.name),
              s,
            ]),
          );

          if (
            unionPool.candidateSkills.length === 0 &&
            skillDiscoveryResult.candidateExperiences.length === 0
          ) {
            matchedSkills = [];
            matchedExperiences = [];
          } else {
            try {
              const llmResult = await withPromptDeadline(
                refreshedConfig.routing.timeoutMs,
                assertActive,
                async () =>
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
                    candidateSkills: unionPool.candidateSkills,
                    candidateExperiences:
                      skillDiscoveryResult.candidateExperiences,
                    dataRoot: deps.dataRoot,
                  }),
              );
              assertActive();

              if (llmResult) {
                rerankStatus = "completed";
                confidence = llmResult.confidence;
                selectedSkills = [...llmResult.skills];
                selectedExperiences = [...(llmResult.experiences ?? [])];
                const candidateExpMap = new Map(
                  skillDiscoveryResult.candidateExperiences.map((e) => [
                    e.id,
                    e,
                  ]),
                );
                matchedExperiences = (llmResult.experiences ?? [])
                  .flatMap((id: string) => {
                    const e =
                      candidateExpMap.get(id) ?? experienceCatalog?.resolve(id);
                    return e ? [e] : [];
                  })
                  .slice(
                    0,
                    refreshedConfig.routing.experiences.maxInjectedExperiences,
                  );

                const unionSkillNames = new Set<string>();
                for (const name of llmResult.skills) {
                  unionSkillNames.add(canonicalIdentity(name));
                }
                for (const exp of matchedExperiences) {
                  for (const sk of exp.skills) {
                    unionSkillNames.add(canonicalIdentity(sk));
                  }
                }

                matchedSkills = Array.from(unionSkillNames)
                  .flatMap((name) => {
                    const s = visibleMap.get(name);
                    return s ? [s] : [];
                  })
                  .slice(0, refreshedConfig.routing.skills.maxInjectedSkills);
              } else {
                rerankStatus = "unavailable";
                rerankError = "Jev routing unavailable";
                matchedSkills = [];
                matchedExperiences = [];
              }
            } catch (error) {
              rerankStatus = "error";
              rerankError = eventError(error);
              logger.warn("routing selector execution failed", { error });
              matchedSkills = [];
              matchedExperiences = [];
            }
          }

          assertActive();
          const injectedCollections: Record<SkillCollectionKind, number> = {
            meta: 0,
            body: 0,
            references: 0,
          };
          const injectedCandidates = unionPool.pool
            .filter((candidate) =>
              matchedSkills.some((skill) => skill.name === candidate.skillName),
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
          const contributedBy: string[] = [];
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
          if (
            matchedExperiences.some((experience) =>
              experience.skills.some((skill) =>
                finalSkillNames.has(canonicalIdentity(skill)),
              ),
            )
          ) {
            contributedBy.push("experience-search");
          }

          const inputSkillDiscovery: InputSkillDiscovery = {
            nameCandidates: skillDiscoveryResult.nameCandidates.length,
            retrievalAttempted:
              Boolean(qmdSkillIndex) &&
              refreshedConfig.routing.skills.maxInjectedSkills > 0,
            retrievalCandidates:
              skillDiscoveryResult.retrievalCandidates.length,
            retrievalSemanticScores:
              skillDiscoveryResult.retrievalSemanticScores,
            experienceRetrieval: skillDiscoveryResult.experienceRetrieval,
            candidateCount: unionPool.pool.length,
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

          await recordPromptBuildSession({
            assertActive,
            association: routing.association,
            latestUserMessage,
            matchedSkills,
            matchedExperiences,
            inputSkillDiscovery,
            confidence,
          });

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
              selectedExperiences,
              experienceCandidates:
                skillDiscoveryResult.candidateExperiences.length,
              candidateCount: unionPool.candidateSkills.length,
              injectedCount: matchedSkills.length,
              injectedSkills: matchedSkills.map((s) => s.name),
              injectedExperiences: matchedExperiences.map((e) => e.id),
              durationMs: Math.max(0, Date.now() - rerankStartedAtMs),
            },
          );

          if (matchedSkills.length === 0 && matchedExperiences.length === 0) {
            return toPromptBuildResult(undefined, workingSetSkillsXml);
          }
          return toPromptBuildResult(
            buildRoutingContext({
              matchedSkills,
              experiences: matchedExperiences,
            }),
            workingSetSkillsXml,
          );
        },
      );
    } catch (err) {
      logger.warn("before_prompt_build hook error", {
        errorType: err instanceof Error ? "Error" : typeof err,
        staticContextAvailable: Boolean(workingSetSkillsXml),
      });
      return staticContextEligible
        ? toPromptBuildResult(
            undefined,
            workingSetSkillsXml,
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
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
        });
        if (skills) skillInventory = { agentId, skills };
      } catch (error) {
        logger.warn("failed to resolve skill inventory for stats", { error });
      }
    }
    const recorded = skillInventory
      ? statsAggregator.record(sessionId, state, undefined, {
          skillInventory,
        })
      : statsAggregator.record(sessionId, state);
    if (!recorded) return;
    return {
      agentId,
      skillInventoryObserved: skillInventory !== undefined,
    };
  }

  async function buildReviewSnapshot(
    baseSnapshot: NonNullable<ReturnType<typeof tracker.getReviewSnapshot>>,
    agentId: string,
    skillPlacementCandidate?: SkillPlacementReviewCandidate,
    capabilityFit?: CapabilityFitEvidence,
  ) {
    const availableSkillNames = skillPlacementCandidate
      ? [skillPlacementCandidate.name]
      : [];
    const resolvedAvailableSkills =
      availableSkillNames.length > 0
        ? await resolveAvailableSkills({
            api,
            agentId,
            bundledSkillsDir,
            nativeBundledSkillsDir: await nativeBundledSkillsDir,
            sharedRoots: sharedRoots(),
            skillNames: [...new Set(availableSkillNames)],
          })
        : [];
    const skillInventory = skillPlacementCandidate
      ? await skillInventoryResolver({
          api,
          agentId,
          bundledSkillsDir,
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
        })
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
      current: {
        ...baseSnapshot.current,
        ...(capabilityFit ? { capabilityFit } : {}),
      },
      availableSkills: skillPlacementCandidate ? [] : resolvedAvailableSkills,
      ...(skillPlacementCandidate ? { skillPlacementCandidate } : {}),
      ...(selectedPlacementSkill ? { selectedPlacementSkill } : {}),
      activeExperiences: experienceCatalog?.listAll() ?? [],
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
      return reviewScheduler.schedule({
        agentId: params.agentId,
        sessionKey: params.ctx.sessionKey ?? params.snapshot.sessionKey,
        ctx: params.ctx,
        resolvedConfig: params.resolvedConfig,
        modelRef: params.modelRef,
        snapshot: params.snapshot,
        triggers: params.triggers,
        skillPlacementCandidate: params.skillPlacementCandidate,
      });
    } catch (error) {
      logger.warn("failed to enqueue Intent Review", { error });
      return false;
    }
  }

  function resolveCapabilityFitEvidence(params: {
    snapshot: NonNullable<ReturnType<typeof tracker.getReviewSnapshot>>;
    config: ResolvedSkillHarnessPluginConfig;
    skillPlacementCandidate?: SkillPlacementReviewCandidate;
  }): CapabilityFitEvidence | undefined {
    const observedSkillNames = [
      ...new Set(
        (params.snapshot.current.skillsUsed ?? []).map((skill) =>
          skill.name.trim().toLowerCase(),
        ),
      ),
    ];
    if (params.skillPlacementCandidate) {
      return {
        source: "skill-placement",
        observedSkillNames,
        turnHasToolErrors: (params.snapshot.current.toolCalls ?? []).some(
          (call) => call.error !== undefined,
        ),
        recoveryVerified: false,
      };
    }

    const toolCalls = params.snapshot.current.toolCalls ?? [];
    const toolFailureCount = toolCalls.filter(
      (call) => call.error !== undefined,
    ).length;
    if (
      toolFailureCount >=
      params.config.review.triggers.capabilityFit.toolFailures
    ) {
      return {
        source: "tool-failure-threshold",
        observedSkillNames,
        turnHasToolErrors: true,
        // The tracker has no tool-call-to-recovery association; do not infer it.
        recoveryVerified: false,
      };
    }
    if (
      toolCalls.length >= params.config.review.triggers.capabilityFit.toolCalls
    ) {
      return {
        source: "tool-call-threshold",
        observedSkillNames,
        turnHasToolErrors: false,
        recoveryVerified: false,
      };
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

    const baseSnapshot = tracker.getReviewSnapshotForTurn(
      association.sessionId,
      association.turnKey,
    );
    if (!baseSnapshot) return;
    const triggers: ReviewTrigger[] = checkReviewTriggers(
      baseSnapshot.current,
      baseSnapshot.turnNumber,
      reviewConfig.triggers,
    );
    let skillPlacementCandidate: SkillPlacementReviewCandidate | undefined;
    let ownsReservation = false;
    try {
      if (
        reviewConfig.triggers.capabilityFit.enabled &&
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
            skillPlacementCandidate = selected;
            if (!triggers.includes("capability-fit")) {
              triggers.push("capability-fit");
            }
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
      let capabilityFit = resolveCapabilityFitEvidence({
        snapshot: baseSnapshot,
        config: resolvedConfig,
        skillPlacementCandidate,
      });
      let snapshot = await buildReviewSnapshot(
        baseSnapshot,
        agentId,
        skillPlacementCandidate,
        capabilityFit,
      );
      const placementSkillName = skillPlacementCandidate?.name
        .trim()
        .toLowerCase();
      if (placementSkillName && !snapshot.selectedPlacementSkill) {
        pendingSkillEpochKeys.delete(skillPlacementCandidate!.epochKey);
        ownsReservation = false;
        skillPlacementCandidate = undefined;
        capabilityFit = resolveCapabilityFitEvidence({
          snapshot: baseSnapshot,
          config: resolvedConfig,
        });
        if (!capabilityFit) {
          const capabilityTriggerIndex = triggers.indexOf("capability-fit");
          if (capabilityTriggerIndex >= 0) {
            triggers.splice(capabilityTriggerIndex, 1);
          }
        }
        if (triggers.length === 0) return;

        agentId = ctx.agentId ?? baseSnapshot.agentId ?? "main";
        modelRef = getReviewModelRef(api, agentId, resolvedConfig, {
          modelProviderId: ctx.modelProviderId,
          modelId: ctx.modelId,
        });
        if (!modelRef) return;
        snapshot = await buildReviewSnapshot(
          baseSnapshot,
          agentId,
          undefined,
          capabilityFit,
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
      hasSessionId: Boolean(ctx.sessionId),
      hasSessionKey: Boolean(ctx.sessionKey),
      hasRunId: Boolean(ctx.runId),
    });
    const association = resolveAssociatedTurn({
      contextRunId: ctx.runId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
    logger.info("onMessageSending association resolved", {
      associationResolved: Boolean(association),
    });
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
    logger.info("onMessageSending turn finalization result", {
      finalizationStatus: finalized,
    });
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
    reviewScheduler,
  };
}
