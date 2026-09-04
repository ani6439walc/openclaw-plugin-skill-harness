import type { OpenClawPluginApi } from "../../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type { defaultCatalog } from "../intents/index.js";
import type { defaultTracker } from "../session/index.js";
import type { defaultStatsAggregator } from "../stats/index.js";
import type { IntentReviewLogWriter } from "../review/log-writer.js";
import type { KeywordCoverageWriter } from "../review/keyword-coverage-writer.js";
import type {
  ReviewSubagentResult,
  runReviewSubagent,
} from "../review/subagent.js";
import type {
  KeywordCoverageReviewParams,
  KeywordCoverageReviewerResult,
} from "../review/keyword-coverage-subagent.js";
import type { runIntentionSubagent } from "../classification/index.js";
import type { ReviewTriggerKeywords } from "../review/trigger-keywords.js";
import type { resolveSkillInventory } from "../skills/indexer.js";
import type { SkillExperienceCatalog } from "../experiences/index.js";
import type { IntentQmdIndex } from "../qmd/intent-index.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";
import type { ToolFallbackRegistry } from "./tool-fallback-registry.js";
import type {
  TurnAssociation,
  TurnAssociationRegistry,
} from "./turn-associations.js";

export interface PluginHookAgentContext {
  readonly runId?: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly sessionId?: string;
  readonly messageProvider?: string;
  readonly channelId?: string;
  readonly trigger?: string;
  readonly modelProviderId?: string;
  readonly modelId?: string;
}

export interface PluginHookBeforePromptBuildEvent {
  readonly prompt: string;
  readonly messages: unknown[];
}

export interface PluginHookBeforePromptBuildResult {
  readonly systemPrompt?: string;
  readonly prependContext?: string;
  readonly appendContext?: string;
  readonly toolsAllow?: string[];
  readonly prependSystemContext?: string;
  readonly appendSystemContext?: string;
}

export interface PluginHookBeforeToolCallEvent {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly runId?: string;
  readonly toolCallId?: string;
}

export interface PluginHookAfterToolCallEvent extends PluginHookBeforeToolCallEvent {
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs?: number;
}

export interface PluginHookToolContext extends PluginHookAgentContext {
  readonly toolName: string;
  readonly toolCallId?: string;
}

export interface PluginHookToolResultPersistContext {
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

export interface PluginHookToolResultPersistEvent {
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly message: unknown;
  readonly isSynthetic?: boolean;
}

export interface PluginHookAgentEndEvent {
  readonly runId?: string;
  readonly messages: unknown[];
  readonly success: boolean;
  readonly error?: string;
  readonly durationMs?: number;
}

export interface PluginHookBeforeAgentFinalizeEvent {
  readonly runId?: string;
  readonly sessionId: string;
}

export interface PluginHookBeforeAgentFinalizeResult {
  readonly action?: "continue" | "revise" | "finalize";
  readonly reason?: string;
  readonly retry?: {
    readonly instruction: string;
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
  };
}

export interface PluginHookMessageSendingEvent {
  readonly content: string;
}

export interface PluginHookSessionContext {
  readonly agentId?: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
}

export interface PluginHookSessionEndEvent {
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly messageCount: number;
}

export interface PendingToolCall {
  name: string;
  params: Record<string, unknown>;
  ctx: {
    sessionId?: string;
    agentId?: string;
    sessionKey?: string;
    runId?: string;
  };
  association: TurnAssociation;
}

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedSkillHarnessPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
  catalog?: typeof defaultCatalog;
  tracker?: typeof defaultTracker;
  statsAggregator?: typeof defaultStatsAggregator;
  skillInventoryResolver?: typeof resolveSkillInventory;
  clock?: () => Date;
  experienceCatalog?: SkillExperienceCatalog;
  qmdIntentIndex?: IntentQmdIndex;
  qmdSkillIndex?: SkillQmdIndex;
  reviewQueue?: { enqueue(task: () => Promise<void>): void };
  reviewer?: (
    params: Parameters<typeof runReviewSubagent>[0],
  ) => Promise<ReviewSubagentResult | undefined>;
  coverageReviewer?: (
    params: KeywordCoverageReviewParams,
  ) => Promise<KeywordCoverageReviewerResult | undefined>;
  classifier?: typeof runIntentionSubagent;
  reviewLogWriter?: Pick<IntentReviewLogWriter, "record"> &
    Partial<
      Pick<
        IntentReviewLogWriter,
        "completedSkillEpochKeys" | "recordHistoricalKeywordAudit"
      >
    >;
  keywordCoverageWriter?: Pick<
    KeywordCoverageWriter,
    | "recordKeywordEvent"
    | "readKeywords"
    | "readRuntimeState"
    | "reserveCoverageEpoch"
    | "releaseCoverageEpoch"
    | "completeCoverageEpoch"
  >;
  triggerKeywords?: () => ReviewTriggerKeywords;
  refreshTriggerKeywords?: () => void;
  getConfiguredAgentSkills?: (agentId: string) => string[] | Promise<string[]>;

  bundledSkillsDir?: string;
  dataRoot?: string;
  turnAssociations?: TurnAssociationRegistry;
  toolFallbacks?: ToolFallbackRegistry;
};
