export type ComplexityPromptsConfig = {
  low?: string;
  medium?: string;
  high?: string;
};

export type ResolvedComplexityPromptsConfig = {
  low: string;
  medium: string;
  high: string;
};

export type IntentionHintPluginConfig = {
  agents?: string[];
  intentDeny?: Record<string, string[]>;
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
  complexityPrompts?: ComplexityPromptsConfig;
};

export type ResolvedIntentionHintPluginConfig = {
  agents: string[];
  intentDeny: Record<string, string[]>;
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
  complexityPrompts: ResolvedComplexityPromptsConfig;
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
  confidence: number;
  complexity: "low" | "medium" | "high";
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
