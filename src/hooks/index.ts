import { roundToDecimals } from "../normalize.js";
import type { InputSkillDiscovery } from "../session/index.js";
import type { RecentTurn, ResolvedSkillHarnessPluginConfig } from "../types.js";
import { logger } from "../../api.js";
import { defaultCatalog } from "../intents/index.js";
import { defaultTracker, extractSkillInfo } from "../session/index.js";
import { defaultStatsAggregator } from "../stats/index.js";
import { IntentReviewLogWriter } from "../review/log-writer.js";
import { checkReviewTriggers, type ReviewTrigger } from "../review/triggers.js";
import { runReviewSubagent } from "../review/subagent.js";
import type {
  CapabilityFitEvidence,
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
  attachHistoricalIntents,
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
  formatWorkingSetSkills,
} from "../classification/index.js";
import {
  listAvailableSkills,
  resolveAvailableSkills,
  resolveSkillInventory,
} from "../intents/index.js";
import { FALLBACK_INTENT, FALLBACK_INTENT_ID } from "../constants.js";
import { experiencesPath, intentsPath, packageRoot } from "../file-utils.js";
import type {
  QmdIntentHit,
  QmdIntentSearchEvidence,
  QmdRawSearchResult,
} from "../qmd/intent-index.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import type { AvailableSkill, SkillInventoryItem } from "../skills/types.js";
import { matchAvailableSkillNames } from "../skills/name-index.js";
import {
  selectSkillCandidates,
  type SkillDiscoveryCandidate,
} from "../skills/candidate-pool.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentProjectionTelemetry,
  IntentRoutingEvidence,
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
const MAX_SELECTED_PLACEMENT_SKILL_CODE_POINTS = 12_000;

export function formatConversationExpansionContext(params: {
  conversation?: readonly RecentTurn[];
}): string | undefined {
  if (!params.conversation || params.conversation.length === 0) {
    return undefined;
  }

  const sections: string[] = [
    "You are expanding a query for conversational assistant skill & intent routing.\n" +
      "- Ground the expansion in the ongoing conversation: resolve pronouns, slang, abbreviations, and elliptical expressions using the conversation context.\n" +
      "- Stay faithful to the user's actual intent and context; do not introduce unrelated domains or invent scenarios not grounded in the query or conversation history.\n" +
      "- Write search queries from the user's perspective (search query or direct question); do not write third-person descriptions of the user (avoid '使用者...', 'User asks...').\n" +
      "- Strictly preserve the user's primary language and script (e.g. Traditional Chinese queries must produce Traditional Chinese expansions; never translate into English unless the user query is English).",
  ];

  const conversationLines = params.conversation
    .map((t) => `- [${t.role}] ${t.text.trim()}`)
    .join("\n");
  sections.push(`Recent conversation:\n${conversationLines}`);

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

function toPromptBuildResult(
  prependContext?: string,
  workingSetSkillsXml?: string,
  includeIntentContext = true,
): PluginHookBeforePromptBuildResult {
  const systemContext = includeIntentContext
    ? `${SKILL_HARNESS_SYSTEM_CONTEXT}\n\n${SKILL_HARNESS_INTENT_CONTEXT}`
    : SKILL_HARNESS_SYSTEM_CONTEXT;
  const appendSystemContext = workingSetSkillsXml
    ? `${systemContext}\n\n${workingSetSkillsXml}`
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

function extractRawResultDocId(
  candidatePath: string | undefined,
): string | undefined {
  if (!candidatePath) return undefined;
  const cleanPath = candidatePath.replace(/^qmd:\/\/[^/]+\//, "");
  const base = path.basename(cleanPath);
  const match = /^(.+-\d+)\.md(?:\.identity\.yml)?$/u.exec(base);
  return (
    match?.[1]?.trim() ?? base.replace(/\.md(?:\.identity\.yml)?$/u, "").trim()
  );
}

function intentIdFromCandidatePath(
  candidatePath: string | undefined,
): string | undefined {
  const docId = extractRawResultDocId(candidatePath);
  if (!docId) return undefined;
  const match = /^(.+)-\d+$/u.exec(docId);
  return match?.[1]?.trim() ?? docId;
}

function extractLexicalTraceChannels(trace: unknown): string | undefined {
  if (!trace || typeof trace !== "object") return undefined;
  const record = trace as Record<string, unknown>;
  if (Array.isArray(record.contributions) && record.contributions.length > 0) {
    const parts: string[] = [];
    for (const c of record.contributions) {
      if (
        c &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).channel === "string"
      ) {
        const channel = (c as Record<string, unknown>).channel as string;
        const score = (c as Record<string, unknown>).backendScore;
        if (typeof score === "number" && Number.isFinite(score)) {
          parts.push(`${channel} ${roundToDecimals(score, 2)}`);
        } else {
          parts.push(channel);
        }
      }
    }
    if (parts.length > 0) return parts.join(", ");
  }
  if (Array.isArray(record.channels) && record.channels.length > 0) {
    const used = record.channels
      .filter(
        (ch) =>
          ch &&
          typeof ch === "object" &&
          (ch as Record<string, unknown>).status === "used" &&
          typeof (ch as Record<string, unknown>).channel === "string",
      )
      .map((ch) => (ch as Record<string, unknown>).channel as string);
    if (used.length > 0) return used.join(", ");
  }
  return undefined;
}

function truncateHitText(text: string, maxLen = 30): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

function findMatchingKeywords(
  message: string,
  keywords: readonly string[],
): string[] {
  const normalizedMessage = message.toLowerCase();
  const matched: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (!trimmed) continue;
    const normalizedKeyword = trimmed.toLowerCase();
    if (normalizedMessage.includes(normalizedKeyword)) {
      matched.push(trimmed);
    }
  }
  return matched;
}

export function buildKeywordRouteReason(params: {
  intent: IntentCatalogEntry;
  hit: QmdIntentHit;
  query?: string;
  directRouteMinScore: number;
  rawResult?: QmdRawSearchResult;
}): string {
  const score = roundToDecimals(params.hit.score, 2);
  const threshold = roundToDecimals(params.directRouteMinScore, 2);

  let hitText = params.rawResult?.body
    ? truncateHitText(params.rawResult.body)
    : "";
  if (!hitText && params.query) {
    const matched = findMatchingKeywords(
      params.query,
      params.intent.definition.keywords,
    );
    if (matched.length > 0) {
      hitText = matched.join(", ");
    }
  }

  const candidatePath =
    params.rawResult?.filepath ??
    params.rawResult?.file ??
    params.rawResult?.displayPath;
  const docId = extractRawResultDocId(candidatePath) || params.intent.id;

  const trace =
    (params.rawResult as Record<string, unknown> | undefined)?.lexicalTrace ??
    params.hit.explain;
  const channels = extractLexicalTraceChannels(trace);

  const meta = channels ? `[${docId} | ${channels}]` : `[${docId}]`;

  if (hitText) {
    return `"${hitText}" ${meta} → score ${score}/${threshold}`;
  }
  return `${meta} → score ${score}/${threshold}`;
}

export function extractHybridSignals(explain: unknown): string {
  if (explain && typeof explain === "object") {
    const record = explain as Record<string, unknown>;
    if (record.rrf && typeof record.rrf === "object") {
      const rrf = record.rrf as Record<string, unknown>;
      if (Array.isArray(rrf.contributions) && rrf.contributions.length > 0) {
        const types = new Set<string>();
        for (const c of rrf.contributions) {
          if (
            c &&
            typeof c === "object" &&
            typeof (c as Record<string, unknown>).queryType === "string"
          ) {
            types.add((c as Record<string, unknown>).queryType as string);
          }
        }
        if (types.size > 0) {
          const order = ["lex", "vec", "hyde", "original"];
          const sorted = order.filter((t) => types.has(t));
          for (const t of types) {
            if (!sorted.includes(t)) sorted.push(t);
          }
          return sorted.join(",");
        }
      }
    }
    const hasVector =
      Array.isArray(record.vectorScores) && record.vectorScores.length > 0;
    const hasFts =
      Array.isArray(record.ftsScores) && record.ftsScores.length > 0;
    if (hasVector && hasFts) return "lex,vec";
    if (hasVector) return "vec";
    if (hasFts) return "lex";
  }
  return "lex,vec,hyde";
}

export function buildQmdRouteReason(params: {
  intent: IntentCatalogEntry;
  hit: QmdIntentHit;
  directRouteMinScore: number;
  scoreMargin: number;
  directRouteMinMargin: number;
  rawResult?: QmdRawSearchResult;
}): string {
  const score = roundToDecimals(params.hit.score, 2);
  const threshold = roundToDecimals(params.directRouteMinScore, 2);
  const margin = roundToDecimals(params.scoreMargin, 2);
  const minimumMargin = roundToDecimals(params.directRouteMinMargin, 2);

  const rawSignals = extractHybridSignals(
    params.hit.explain ?? params.rawResult?.explain,
  );
  const signals = rawSignals
    .split(",")
    .map((s) => s.trim())
    .join(", ");

  const hitText = params.rawResult?.body
    ? truncateHitText(params.rawResult.body)
    : "";
  const meta = `[${signals}]`;
  const scorePart = `score ${score}/${threshold} (margin ${margin}/${minimumMargin})`;

  if (hitText) {
    return `"${hitText}" ${meta} → ${scorePart}`;
  }
  return `${meta} → ${scorePart}`;
}

function buildQmdIntentResult(params: {
  hit: QmdIntentHit;
  intent: IntentCatalogEntry;
  directRouteMinScore: number;
  scoreMargin: number;
  directRouteMinMargin: number;
  rawResult?: QmdRawSearchResult;
}): IntentionResult {
  return {
    intent: params.intent.id,
    reason: buildQmdRouteReason({
      intent: params.intent,
      hit: params.hit,
      directRouteMinScore: params.directRouteMinScore,
      scoreMargin: params.scoreMargin,
      directRouteMinMargin: params.directRouteMinMargin,
      rawResult: params.rawResult,
    }),
    keywords: params.intent.definition.keywords.slice(0, 5),
    domain: params.intent.definition.domain,
    confidence: params.hit.score,
  };
}

function buildKeywordIntentResult(params: {
  hit: QmdIntentHit;
  intent: IntentCatalogEntry;
  latestUserMessage?: string;
  directRouteMinScore: number;
  rawResult?: QmdRawSearchResult;
}): IntentionResult {
  return {
    intent: params.intent.id,
    reason: buildKeywordRouteReason({
      intent: params.intent,
      hit: params.hit,
      query: params.latestUserMessage,
      directRouteMinScore: params.directRouteMinScore,
      rawResult: params.rawResult,
    }),
    keywords: params.intent.definition.keywords.slice(0, 5),
    domain: params.intent.definition.domain,
    confidence: params.hit.score,
  };
}

type PromptBuildClassification = {
  trigger: IntentTrigger;
  result: IntentionResult;
  intentProjection?: IntentProjectionTelemetry;
  routingEvidence?: IntentRoutingEvidence;
};

export function createHookHandlers(deps: HookDeps) {
  const { api, config, refreshLiveConfigFromRuntime, refreshIntents } = deps;
  const catalog = deps.catalog ?? defaultCatalog;
  const tracker = deps.tracker ?? defaultTracker;
  const statsAggregator = deps.statsAggregator ?? defaultStatsAggregator;
  const skillInventoryResolver =
    deps.skillInventoryResolver ?? resolveSkillInventory;
  const reviewer = deps.reviewer ?? runReviewSubagent;
  const classifier = deps.classifier ?? runIntentionSubagent;
  const clock = deps.clock ?? (() => new Date());
  const experienceCatalog =
    deps.experienceCatalog ??
    (deps.dataRoot ? new SkillExperienceCatalog(deps.dataRoot) : undefined);
  const qmdIntentIndex = deps.qmdIntentIndex;
  const qmdSkillIndex = deps.qmdSkillIndex;

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
        intentDirectory: intentsPath(deps.dataRoot ?? "."),
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
          changedIntentIds: reviewResult.changedIntentIds,
          changedExperienceIds: reviewResult.changedExperienceIds,
          validationErrors: reviewResult.validationErrors,
          noFindingReasonCounts: reviewResult.noFindingReasonCounts,
          schemaRejectionReasonCounts: reviewResult.schemaRejectionReasonCounts,
          skillPlacementCandidate: candidate.skillPlacementCandidate,
        },
      );
      if (reviewResult.changedIntentIds?.length) {
        refreshIntents({
          rebuildQmd: reviewResult.routingSurfaceChanged === true,
        });
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
    const startedAtMs = Date.now();
    const failures: string[] = [];
    const emitIntentMatch = (
      trigger: IntentTrigger,
      result: IntentionResult,
    ): void => {
      emitPipelineEvent(
        params.ctx,
        params.resolvedSessionKey,
        "intent-match",
        "completed",
        {
          result: result.intent,
          confidence: result.confidence,
          reason: `${trigger} → ${result.reason}`,
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      );
    };

    // Step 1: QMD Keyword Search (BM25 searchLex)
    let keywordHits: QmdIntentHit[] | undefined;
    let keywordRawResults: QmdIntentSearchEvidence["rawResults"] | undefined;
    let routingEvidence: IntentRoutingEvidence | undefined;
    if (qmdIntentIndex) {
      try {
        const keywordSearch = await qmdIntentIndex.searchKeywords({
          query: params.latestUserMessage,
          includeRawResults: true,
        });
        keywordHits = keywordSearch?.hits;
        keywordRawResults = keywordSearch?.rawResults;
      } catch (error) {
        failures.push("qmd-keyword: keyword index unavailable");
        logger.warn("keyword intent search failed", { error });
      }
      const topKeywordHit = keywordHits?.[0];
      const matchedKeywordIntent = topKeywordHit
        ? findIntentEntry(params.availableIntents, topKeywordHit.intentId)
        : undefined;
      const keywordMinScore =
        params.refreshedConfig.routing.thresholds.keyword.directRouteMinScore;
      const keywordOutcome =
        keywordHits === undefined
          ? "unavailable"
          : !topKeywordHit
            ? "none"
            : !matchedKeywordIntent
              ? "unrecognized-intent"
              : roundToDecimals(topKeywordHit.score, 2) >=
                  roundToDecimals(keywordMinScore, 2)
                ? "routed"
                : "below-threshold";
      routingEvidence = {
        keyword: {
          query: params.latestUserMessage,
          ...(keywordHits === undefined ? {} : { hits: keywordHits }),
          ...(keywordRawResults === undefined
            ? {}
            : { rawResults: keywordRawResults }),
          outcome: keywordOutcome,
          directRouteMinScore: keywordMinScore,
        },
      };
      if (
        topKeywordHit &&
        matchedKeywordIntent &&
        roundToDecimals(topKeywordHit.score, 2) >=
          roundToDecimals(keywordMinScore, 2)
      ) {
        const matchingRawResult =
          keywordRawResults?.find((raw) => {
            const candidatePath = raw.filepath ?? raw.file ?? raw.displayPath;
            return (
              intentIdFromCandidatePath(candidatePath)?.toLowerCase() ===
              matchedKeywordIntent.id.toLowerCase()
            );
          }) ?? keywordRawResults?.[0];
        const result = buildKeywordIntentResult({
          hit: topKeywordHit,
          intent: matchedKeywordIntent,
          latestUserMessage: params.latestUserMessage,
          directRouteMinScore: keywordMinScore,
          rawResult: matchingRawResult,
        });
        emitIntentMatch("qmd-keyword", result);
        return { trigger: "qmd-keyword", result, routingEvidence };
      }
      if (keywordHits === undefined && failures.length === 0) {
        failures.push("qmd-keyword: keyword index unavailable");
      }
    }

    // Step 2: QMD Hybrid Search (Examples & Keywords) with Context Expansion
    let qmdHits: QmdIntentHit[] | undefined;
    let hybridRawResults: QmdIntentSearchEvidence["rawResults"] | undefined;
    let topHit: QmdIntentHit | undefined;
    if (qmdIntentIndex) {
      const limits = getQmdCandidateLimits(params.availableIntents.length);
      const expansionContext = formatConversationExpansionContext({
        conversation: params.conversation,
      });
      try {
        const hybridSearch =
          await qmdIntentIndex.searchIntentExamplesAndKeywords({
            query: params.latestUserMessage,
            rawLimit: limits.rawLimit,
            ...(expansionContext ? { expansionContext } : {}),
            includeRawResults: true,
          });
        qmdHits = hybridSearch?.hits;
        hybridRawResults = hybridSearch?.rawResults;
      } catch (error) {
        failures.push("qmd-hybrid: example/keyword index unavailable");
        logger.warn("hybrid intent search failed", { error });
      }
      topHit = qmdHits?.[0];
      const secondHit = qmdHits?.[1];
      const topIntent = topHit
        ? findIntentEntry(params.availableIntents, topHit.intentId)
        : undefined;
      const hybridThresholds = params.refreshedConfig.routing.thresholds.hybrid;
      const scoreMargin =
        topHit && secondHit
          ? topHit.score - secondHit.score
          : (topHit?.score ?? 0);
      const satisfiesMargin =
        !secondHit ||
        roundToDecimals(scoreMargin, 2) >=
          roundToDecimals(hybridThresholds.directRouteMinMargin, 2);
      const hybridOutcome =
        qmdHits === undefined
          ? "unavailable"
          : !topHit
            ? "none"
            : !topIntent
              ? "unrecognized-intent"
              : roundToDecimals(topHit.score, 2) <
                  roundToDecimals(hybridThresholds.directRouteMinScore, 2)
                ? satisfiesMargin
                  ? "below-threshold"
                  : "below-score-and-margin-threshold"
                : !satisfiesMargin
                  ? "below-margin-threshold"
                  : "routed";
      routingEvidence = {
        ...routingEvidence,
        hybrid: {
          query: params.latestUserMessage,
          ...(qmdHits === undefined ? {} : { hits: qmdHits }),
          ...(hybridRawResults === undefined
            ? {}
            : { rawResults: hybridRawResults }),
          outcome: hybridOutcome,
          directRouteMinScore: hybridThresholds.directRouteMinScore,
          directRouteMinMargin: hybridThresholds.directRouteMinMargin,
          ...(expansionContext ? { expansionContext } : {}),
        },
      };
      if (
        topHit &&
        topIntent &&
        roundToDecimals(topHit.score, 2) >=
          roundToDecimals(hybridThresholds.directRouteMinScore, 2) &&
        satisfiesMargin
      ) {
        const matchingRawResult =
          hybridRawResults?.find((raw) => {
            const candidatePath = raw.filepath ?? raw.file ?? raw.displayPath;
            return (
              intentIdFromCandidatePath(candidatePath)?.toLowerCase() ===
              topIntent.id.toLowerCase()
            );
          }) ?? hybridRawResults?.[0];
        const result = buildQmdIntentResult({
          hit: topHit,
          intent: topIntent,
          directRouteMinScore: hybridThresholds.directRouteMinScore,
          scoreMargin,
          directRouteMinMargin: hybridThresholds.directRouteMinMargin,
          rawResult: matchingRawResult,
        });
        emitIntentMatch("qmd-hybrid", result);
        return { trigger: "qmd-hybrid", result, routingEvidence };
      }
      if (qmdHits === undefined && failures.length < 2) {
        failures.push("qmd-hybrid: example/keyword index unavailable");
      }
    }

    // Step 3: Fallback Intent Classifier
    if (!params.modelRef) return;

    const projectionStartedAtMs = Date.now();
    let projection: IntentProjection;
    try {
      projection = projectQmdIntentCandidates({
        intents: params.availableIntents,
        qmdHits,
        histories: params.historicalIntents,
        minCandidateScore:
          params.refreshedConfig.routing.thresholds.hybrid.minCandidateScore,
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
      failures.push("llm-classifier: classifier execution failed");
      logger.warn("intent classifier failed", { error });
    }

    if (!result) {
      if (!failures.some((failure) => failure.startsWith("llm-classifier:"))) {
        failures.push("llm-classifier: classifier returned no result");
      }
      if (failures.length === 3) {
        emitPipelineEvent(
          params.ctx,
          params.resolvedSessionKey,
          "intent-match",
          "failed",
          {
            error: failures.join("; "),
            durationMs: Math.max(0, Date.now() - startedAtMs),
          },
        );
      }
      await recordPromptBuildSession({
        association: params.association,
        latestUserMessage: params.latestUserMessage,
        trigger: "llm-classifier",
        intentProjection,
        routingEvidence,
        conversation: params.conversation,
      });
      return;
    }

    result.domain = findIntentDomain(params.availableIntents, result.intent);
    emitIntentMatch("llm-classifier", result);
    return {
      trigger: "llm-classifier",
      result,
      intentProjection,
      routingEvidence,
    };
  }

  async function recordPromptBuildSession(params: {
    association?: TurnAssociation;
    latestUserMessage: string;
    trigger: IntentTrigger;
    result?: IntentionResult;
    intentMatchedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    routingEvidence?: IntentRoutingEvidence;
    inputSkillDiscovery?: InputSkillDiscovery;
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
          trigger: params.trigger,
          ...(params.result ? { result: params.result } : {}),
          intentMatchedSkills: params.intentMatchedSkills,
          ...(params.intentProjection
            ? { intentProjection: params.intentProjection }
            : {}),
          ...(params.routingEvidence
            ? { routingEvidence: params.routingEvidence }
            : {}),
          ...(params.inputSkillDiscovery
            ? { inputSkillDiscovery: params.inputSkillDiscovery }
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
    intentMatchedSkills?: string[];
    intentProjection?: IntentProjectionTelemetry;
    routingEvidence?: IntentRoutingEvidence;
    inputSkillDiscovery?: InputSkillDiscovery;
    conversation: ReturnType<typeof limitConversationTurns>;
  }): Promise<void> {
    await recordPromptBuildSession({
      association: params.routing.association,
      latestUserMessage: params.latestUserMessage,
      trigger: params.trigger,
      result: params.result,
      intentMatchedSkills: params.intentMatchedSkills,
      intentProjection: params.intentProjection,
      routingEvidence: params.routingEvidence,
      inputSkillDiscovery: params.inputSkillDiscovery,
      conversation: params.conversation,
    });
  }

  async function resolveRoutingContext(params: {
    routing: PromptBuildIdentity;
    result: IntentionResult;
    intent: IntentCatalogEntry;
  }): Promise<{
    intentMatchedSkills: AvailableSkill[];
    experiences: ReturnType<SkillExperienceCatalog["listForSkills"]>;
  }> {
    const directSkills = await resolveAvailableSkills({
      api,
      agentId: params.routing.effectiveAgentId,
      bundledSkillsDir,
      nativeBundledSkillsDir: await nativeBundledSkillsDir,
      sharedRoots: sharedRoots(),
      skillNames: params.intent.definition.skills ?? [],
    });
    const intentMatchedSkills = directSkills.slice(0, 4);
    const experiences = experienceCatalog
      ? experienceCatalog.listForSkills(
          intentMatchedSkills.map((skill) => skill.name),
        )
      : [];
    return {
      intentMatchedSkills,
      experiences,
    };
  }

  async function discoverInputMatchedSkills(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    intents: readonly IntentCatalogEntry[];
  }): Promise<{ skills: AvailableSkill[]; telemetry: InputSkillDiscovery }> {
    const policy = params.refreshedConfig.routing.skillCandidates;
    if (!policy || !policy.enabled) {
      return {
        skills: [],
        telemetry: {
          nameCandidates: 0,
          retrievalAttempted: false,
          retrievalCandidates: 0,
          retrievalSemanticScores: [],
          candidateCount: 0,
          injectedSkills: [],
          durationMs: 0,
        },
      };
    }
    const startedAtMs = Date.now();
    let nameCandidates: SkillDiscoveryCandidate[] = [];
    let retrievalCandidates: SkillDiscoveryCandidate[] = [];
    let retrievalSemanticScores: number[] = [];
    let fallbackReason:
      | "name-channel-unavailable"
      | "retrieval-timeout"
      | "retrieval-unavailable"
      | "empty-pool"
      | undefined;
    try {
      const visibleSkills = await listAvailableSkills({
        api,
        agentId: params.routing.effectiveAgentId,
        intents: params.intents,
        bundledSkillsDir,
        nativeBundledSkillsDir: await nativeBundledSkillsDir,
        sharedRoots: sharedRoots(),
        usageStats: {},
      });
      const expansionContext = formatConversationExpansionContext({
        conversation: params.conversation,
      });
      const search = qmdSkillIndex
        ? qmdSkillIndex.search({
            agentId: params.routing.effectiveAgentId,
            query: params.latestUserMessage,
            limit: policy.maxInjectedSkills,
            includeEvidence: false,
            ...(expansionContext ? { expansionContext } : {}),
          })
        : undefined;
      try {
        nameCandidates = matchAvailableSkillNames({
          skills: visibleSkills,
          input: params.latestUserMessage,
          options: policy.nameMatch,
        });
      } catch (error) {
        fallbackReason = "name-channel-unavailable";
        logger.warn("skill name candidate matching failed", { error });
      }
      if (search) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(
              () => resolve("timeout"),
              policy.search.timeoutMs,
            );
          });
          const outcome = await Promise.race([
            search.then((hits) => ({ hits })).catch((error) => ({ error })),
            timeout,
          ]);
          if (outcome === "timeout") {
            fallbackReason = "retrieval-timeout";
          } else if ("error" in outcome) {
            throw outcome.error;
          } else if (outcome.hits === undefined) {
            fallbackReason = "retrieval-unavailable";
          } else {
            retrievalSemanticScores = outcome.hits.flatMap((hit) =>
              hit.semanticScore === undefined ? [] : [hit.semanticScore],
            );
            retrievalCandidates = outcome.hits.flatMap((hit) =>
              hit.semanticScore !== undefined &&
              roundToDecimals(hit.semanticScore, 2) >=
                roundToDecimals(policy.search.minCandidateScore, 2)
                ? [
                    {
                      skillName: hit.name,
                      score: hit.semanticScore,
                      source: "direct-retrieval" as const,
                    },
                  ]
                : [],
            );
          }
        } catch (error) {
          fallbackReason = "retrieval-unavailable";
          logger.warn("skill candidate retrieval failed", { error });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        fallbackReason = "retrieval-unavailable";
      }
      const selection = selectSkillCandidates({
        visibleSkills,
        candidates: [...nameCandidates, ...retrievalCandidates],
        options: policy,
      });
      if (selection.selectedSkills.length === 0 && !fallbackReason) {
        fallbackReason = "empty-pool";
      }
      const injectedCandidates = selection.pool
        .filter((candidate) =>
          selection.selectedSkills.some(
            (skill) => skill.name === candidate.skillName,
          ),
        )
        .map((candidate) => ({
          name: candidate.skillName,
          source: candidate.source,
        }));
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "skill-match",
        "completed",
        {
          nameCandidates: nameCandidates.length,
          retrievalCandidates: retrievalCandidates.length,
          candidateCount: selection.pool.length,
          injectedCount: selection.selectedSkills.length,
          injectedSkills: selection.selectedSkills.map((skill) => skill.name),
          reason:
            [
              ...new Set(
                injectedCandidates.map((candidate) => candidate.source),
              ),
            ]
              .map((source) =>
                source === "name-match" ? "name-match" : "qmd-search",
              )
              .join(",") || "none",
          result: selection.selectedSkills.map((skill) => skill.name),
          ...(fallbackReason ? { fallbackReason } : {}),
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      );
      return {
        skills: [...selection.selectedSkills],
        telemetry: {
          nameCandidates: nameCandidates.length,
          retrievalAttempted: true,
          retrievalCandidates: retrievalCandidates.length,
          retrievalSemanticScores,
          candidateCount: selection.pool.length,
          injectedSkills: injectedCandidates,
          ...(fallbackReason ? { fallbackReason } : {}),
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      };
    } catch (error) {
      logger.warn("skill candidate discovery failed", { error });
      emitPipelineEvent(
        params.ctx,
        params.routing.resolvedSessionKey,
        "skill-match",
        "failed",
        {
          nameCandidates: nameCandidates.length,
          retrievalCandidates: retrievalCandidates.length,
          candidateCount: 0,
          injectedCount: 0,
          injectedSkills: [],
          reason: "none",
          result: [],
          fallbackReason: fallbackReason ?? "empty-pool",
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      );
      return {
        skills: [],
        telemetry: {
          nameCandidates: nameCandidates.length,
          retrievalAttempted: true,
          retrievalCandidates: retrievalCandidates.length,
          retrievalSemanticScores,
          candidateCount: 0,
          injectedSkills: [],
          fallbackReason: fallbackReason ?? "empty-pool",
          durationMs: Math.max(0, Date.now() - startedAtMs),
        },
      };
    }
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
        deps.config?.().workingSetSkills?.includeWorkspaceSkills ?? true;
      const includeWorkshopSkills =
        deps.config?.().workingSetSkills?.includeWorkshopSkills ?? true;

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

  async function handleResolvedIntentPromptBuild(params: {
    ctx: PluginHookAgentContext;
    routing: PromptBuildIdentity;
    refreshedConfig: ResolvedSkillHarnessPluginConfig;
    latestUserMessage: string;
    conversation: ReturnType<typeof limitConversationTurns>;
    availableIntents: readonly IntentCatalogEntry[];
    classification?: PromptBuildClassification;
    inputSkillMatch: {
      skills: AvailableSkill[];
      telemetry: InputSkillDiscovery;
    };
    workingSetSkillsXml?: string;
  }): Promise<PluginHookBeforePromptBuildResult | undefined> {
    const classification = params.classification;
    const result = classification?.result;
    const intent = result
      ? findIntentEntry(params.availableIntents, result.intent)
      : undefined;
    const routingContext =
      intent && result
        ? await resolveRoutingContext({
            routing: params.routing,
            result,
            intent,
          })
        : { intentMatchedSkills: [], experiences: [] };

    if (classification && result) {
      logger.debug("intention result", {
        trigger: classification.trigger,
        intentResolved: Boolean(result.intent),
      });
    }
    await recordPromptBuildSession({
      association: params.routing.association,
      latestUserMessage: params.latestUserMessage,
      trigger: classification?.trigger ?? "llm-classifier",
      ...(result ? { result } : {}),
      intentMatchedSkills: routingContext.intentMatchedSkills.map(
        (skill) => skill.name,
      ),
      ...(classification?.intentProjection
        ? { intentProjection: classification.intentProjection }
        : {}),
      ...(classification?.routingEvidence
        ? { routingEvidence: classification.routingEvidence }
        : {}),
      inputSkillDiscovery: params.inputSkillMatch.telemetry,
      conversation: params.conversation,
    });

    if (!intent && params.inputSkillMatch.skills.length === 0) {
      return toPromptBuildResult(undefined, params.workingSetSkillsXml);
    }
    return toPromptBuildResult(
      buildRoutingContext({
        ...(result && intent
          ? { result, guidance: intent.definition.guidance }
          : {}),
        intentMatchedSkills: routingContext.intentMatchedSkills,
        experiences: routingContext.experiences,
        inputMatchedSkills: params.inputSkillMatch.skills,
      }),
      params.workingSetSkillsXml,
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
      if (isInternalUserTurn(event)) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }
      if (!isEligibleInteractiveSession(resolvedContext)) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      const { latestUserMessage, historicalIntents, conversation } =
        buildConversationContext(event, ctx, refreshedConfig);
      routing.association = await prepareTrackingTurn({
        ctx,
        routing,
        latestUserMessage,
        recentTurns: extractRecentTurns(event.messages),
      });
      if (!routing.association) {
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      refreshIntents();
      if (catalog.count === 0) {
        logger.debug("no intents loaded; skipping intention scan.");
        return toPromptBuildResult(undefined, workingSetSkillsXml);
      }

      logger.debug("before_prompt_build hook triggered", {
        hasSessionId: Boolean(ctx.sessionId),
        hasSessionKey: Boolean(ctx.sessionKey),
        hasRunId: Boolean(ctx.runId),
        hasModelProviderId: Boolean(ctx.modelProviderId),
        hasModelId: Boolean(ctx.modelId),
      });

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
          const [classification, inputSkillMatch] = await Promise.all([
            resolvePromptBuildClassification({
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
            }),
            discoverInputMatchedSkills({
              ctx,
              routing,
              refreshedConfig,
              latestUserMessage,
              conversation,
              intents: availableIntents,
            }),
          ]);

          return await handleResolvedIntentPromptBuild({
            ctx,
            routing,
            refreshedConfig,
            latestUserMessage,
            conversation,
            availableIntents,
            classification,
            inputSkillMatch,
            workingSetSkillsXml,
          });
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
          nativeBundledSkillsDir: await nativeBundledSkillsDir,
          sharedRoots: sharedRoots(),
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
    capabilityFit?: CapabilityFitEvidence,
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
        agentEndStats.intentDefinition,
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
          agentEndStats.intentDefinition,
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
