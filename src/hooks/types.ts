import type { OpenClawPluginApi } from "../../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type { defaultTracker } from "../session/index.js";
import type { defaultStatsAggregator } from "../stats/index.js";
import type { IntentReviewLogWriter } from "../review/log-writer.js";
import type {
  ReviewSubagentResult,
  runReviewSubagent,
} from "../review/subagent.js";
import type {
  IntentReviewScheduler,
  ReviewSchedulerLike,
} from "../review/scheduler.js";
import type {
  JevUnifiedRoutingParams,
  runJevUnifiedRouting,
} from "../classification/index.js";
import type { RoutingLlmResult } from "../types.js";
import type { resolveSkillInventory } from "../skills/indexer.js";
import type { SkillExperienceCatalog } from "../experiences/index.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";
import type { SkillExperienceQmdIndex } from "../qmd/experience-index.js";
import type { ToolFallbackRegistry } from "./tool-fallback-registry.js";
import type {
  TurnAssociation,
  TurnAssociationRegistry,
} from "./turn-associations.js";

// Derive prompt contracts from the public registration API so SDK additions stay visible.
declare const registerHook: OpenClawPluginApi["on"];
type BeforePromptBuildHandler = Parameters<
  typeof registerHook<"before_prompt_build">
>[1];
export type PluginHookAgentContext = Parameters<BeforePromptBuildHandler>[1];
export type PluginHookBeforePromptBuildEvent =
  Parameters<BeforePromptBuildHandler>[0];
export type PluginHookBeforePromptBuildResult = Exclude<
  Awaited<ReturnType<BeforePromptBuildHandler>>,
  void
>;

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
  tracker?: typeof defaultTracker;
  statsAggregator?: typeof defaultStatsAggregator;
  skillInventoryResolver?: typeof resolveSkillInventory;
  reviewSkillResolver?: typeof import("../skills/indexer.js").listAvailableSkills;
  clock?: () => Date;
  experienceCatalog?: SkillExperienceCatalog;
  qmdSkillIndex?: SkillQmdIndex;
  qmdExperienceIndex?: SkillExperienceQmdIndex;
  reviewScheduler?: IntentReviewScheduler | ReviewSchedulerLike;
  loadReviewSubagent?: () => Promise<
    Pick<
      typeof import("../review/subagent.js"),
      "getReviewModelRef" | "runReviewSubagent"
    >
  >;
  reviewer?: (
    params: Parameters<typeof runReviewSubagent>[0],
  ) => Promise<ReviewSubagentResult | undefined>;
  routingSelector?: (
    params: JevUnifiedRoutingParams,
  ) => Promise<RoutingLlmResult | undefined>;
  routingSubagent?: (
    params: JevUnifiedRoutingParams,
  ) => Promise<RoutingLlmResult | undefined>;
  classifier?: (params: unknown) => Promise<RoutingLlmResult | undefined>;
  reviewLogWriter?: Pick<IntentReviewLogWriter, "record"> &
    Partial<Pick<IntentReviewLogWriter, "completedSkillEpochKeys">>;
  getWorkingSetSkills?: (agentId: string) => string[] | Promise<string[]>;

  bundledSkillsDir?: string;
  nativeBundledSkillsDir?: Promise<string | undefined>;
  getSharedRoots?: () => readonly string[];
  dataRoot?: string;
  turnAssociations?: TurnAssociationRegistry;
  toolFallbacks?: ToolFallbackRegistry;
};
