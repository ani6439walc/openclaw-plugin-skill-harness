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

export type ContextWindow = {
  user: { turns: number; chars: number };
  assistant: { turns: number; chars: number };
};

export type ThinkLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type EvolutionTriggersConfig = {
  skillCandidate?: { enabled?: boolean; toolCalls?: number };
  processGap?: { enabled?: boolean; toolFailures?: number };
  satisfactionCheck?: { enabled?: boolean; everyTurns?: number };
  missingIntent?: { enabled?: boolean };
  weakIntent?: { enabled?: boolean; confidenceBelow?: number };
  behaviorFix?: { enabled?: boolean; keywords?: string[] };
};

export type EvolutionConfig = {
  enabled?: boolean;
  model?: string;
  modelFallback?: string;
  thinking?: ThinkLevel;
  timeoutMs?: number;
  triggers?: EvolutionTriggersConfig;
};

export type ResolvedEvolutionConfig = {
  enabled: boolean;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutMs: number;
  triggers: {
    skillCandidate: { enabled: boolean; toolCalls: number };
    processGap: { enabled: boolean; toolFailures: number };
    satisfactionCheck: { enabled: boolean; everyTurns: number };
    missingIntent: { enabled: boolean };
    weakIntent: { enabled: boolean; confidenceBelow: number };
    behaviorFix: { enabled: boolean; keywords: string[] };
  };
};

export type IntentionHintPluginConfig = {
  agents?: string[];
  intentDeny?: Record<string, string[]>;
  model?: string;
  modelFallback?: string;
  thinking?: ThinkLevel;
  allowedChatTypes?: string[];
  allowedChatIds?: string[];
  deniedChatIds?: string[];
  queryMode?: string;
  contextWindow?: ContextWindow;
  timeoutMs?: number;
  intentsDir?: string;
  complexityPrompts?: ComplexityPromptsConfig;
  evolution?: EvolutionConfig;
};

export type ResolvedIntentionHintPluginConfig = {
  agents: string[];
  intentDeny: Record<string, string[]>;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  allowedChatTypes: string[];
  allowedChatIds: string[];
  deniedChatIds: string[];
  queryMode: "message" | "recent" | "full";
  contextWindow: ContextWindow;
  timeoutMs: number;
  intentsDir: string | undefined;
  complexityPrompts: ResolvedComplexityPromptsConfig;
  evolution: ResolvedEvolutionConfig;
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

export type HistoricalIntent = Pick<IntentionResult, "intent" | "goal">;

export type HistoricalIntentRecord = HistoricalIntent & {
  input: string;
};

export type RecentTurn = {
  role: string;
  text: string;
  historicalIntent?: HistoricalIntent;
};

export type MessageContentPart = {
  type?: string;
  text?: string;
  content?: string;
};

export type PromptMessageLike = {
  role?: string;
  content?: string | Array<string | MessageContentPart>;
  provenance?: {
    kind?: string;
    sourceTool?: string;
  };
};
