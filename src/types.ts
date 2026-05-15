export type IntentionHintPluginConfig = {
  agents?: string[];
  model?: string;
  modelFallback?: string;
  allowedChatTypes?: string[];
  allowedChatIds?: string[];
  deniedChatIds?: string[];
  queryMode?: string;
  recentUserTurns?: number;
  recentAssistantTurns?: number;
  recentUserChars?: number;
  recentAssistantChars?: number;
  timeoutMs?: number;
  intentsDir?: string;
  intentsHotReload?: boolean;
  intentsHotReloadIntervalMs?: number;
};

export type ResolvedIntentionHintPluginConfig = {
  agents: string[];
  model: string | undefined;
  modelFallback: string | undefined;
  allowedChatTypes: string[];
  allowedChatIds: string[];
  deniedChatIds: string[];
  queryMode: "message" | "recent" | "full";
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  timeoutMs: number;
  intentsDir: string | undefined;
  intentsHotReload: boolean;
  intentsHotReloadIntervalMs: number;
};

export type IntentDefinition = {
  enabled: boolean;
  id: string;
  name: string;
  triggers: string[];
  examples: string[];
  prompt: string;
};

export type IntentionResult = {
  intent: string;
  reason: string;
  goal: string;
  suggestion?: string;
  /**
   * Confidence level of the intent classification.
   * "low" | "medium" | "high"
   */
  confidence?: string;
  /**
   * Estimated complexity of the task based on the intent.
   * "simple" | "moderate" | "complex"
   */
  complexity?: string;
};

export type RecentTurn = {
  role: string;
  text: string;
};

export type MessageContentPart = {
  type?: string;
  text?: string;
  content?: string;
};

export type PromptMessageLike = {
  role?: string;
  content?: string | Array<string | MessageContentPart>;
};
