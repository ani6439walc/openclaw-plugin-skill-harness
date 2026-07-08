import type { OpenClawPluginApi } from "../../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type { defaultCatalog } from "../intents/index.js";
import type { defaultTracker } from "../session/index.js";
import type { defaultStatsAggregator } from "../stats/index.js";
import type { ReviewLogWriter } from "../review/log-writer.js";
import type {
  ReviewSubagentResult,
  runReviewSubagent,
} from "../review/subagent.js";
import type {
  runIntentInstructionSubagent,
  runIntentionSubagent,
  runTopicSwitchSubagent,
} from "../classification/index.js";
import type { ReviewTriggerKeywords } from "../review/trigger-keywords.js";

export interface PendingToolCall {
  name: string;
  params: Record<string, unknown>;
  ctx: { sessionId?: string; agentId?: string; sessionKey?: string };
}

export type HookDeps = {
  api: OpenClawPluginApi;
  config: () => ResolvedSkillHarnessPluginConfig;
  refreshLiveConfigFromRuntime: () => void;
  refreshIntents: () => void;
  catalog?: typeof defaultCatalog;
  tracker?: typeof defaultTracker;
  statsAggregator?: typeof defaultStatsAggregator;
  reviewQueue?: { enqueue(task: () => Promise<void>): void };
  reviewer?: (
    params: Parameters<typeof runReviewSubagent>[0],
  ) => Promise<ReviewSubagentResult | undefined>;
  classifier?: typeof runIntentionSubagent;
  topicChecker?: typeof runTopicSwitchSubagent;
  instructionWriter?: typeof runIntentInstructionSubagent;
  reviewLogWriter?: Pick<ReviewLogWriter, "record">;
  triggerKeywords?: () => ReviewTriggerKeywords;
  bundledSkillsDir?: string;
  dataRoot?: string;
};
