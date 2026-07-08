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
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";

export type LowThinkingMode = "fastpath-only" | "full" | "off";

export type ReviewTriggersConfig = {
  skillCandidate?: { enabled?: boolean; toolCalls?: number };
  processGap?: { enabled?: boolean; toolFailures?: number };
  successfulPattern?: {
    enabled?: boolean;
    toolCalls?: number;
    keywords?: string[];
  };
  satisfactionCheck?: { enabled?: boolean; everyTurns?: number };
  missingIntent?: { enabled?: boolean };
  weakIntent?: { enabled?: boolean; confidenceBelow?: number };
  behaviorFix?: { enabled?: boolean; keywords?: string[] };
  entityContext?: { enabled?: boolean; keywords?: string[] };
};

export type ReviewConfig = {
  enabled?: boolean;
  model?: string;
  modelFallback?: string;
  thinking?: ThinkLevel;
  timeoutMs?: number;
  triggers?: ReviewTriggersConfig;
};

export type ResolvedReviewConfig = {
  enabled: boolean;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutMs: number;
  triggers: {
    skillCandidate: { enabled: boolean; toolCalls: number };
    processGap: { enabled: boolean; toolFailures: number };
    successfulPattern: {
      enabled: boolean;
      toolCalls: number;
      keywords?: string[];
    };
    satisfactionCheck: { enabled: boolean; everyTurns: number };
    missingIntent: { enabled: boolean };
    weakIntent: { enabled: boolean; confidenceBelow: number };
    behaviorFix: { enabled: boolean; keywords?: string[] };
    entityContext: { enabled: boolean; keywords?: string[] };
  };
};

export type InstructionConfig = {
  enabled?: boolean;
  model?: string;
  modelFallback?: string;
  thinking?: ThinkLevel;
  timeoutMs?: number;
};

export type ResolvedInstructionConfig = {
  enabled: boolean;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutMs: number;
};

export type SkillHarnessPluginConfig = {
  agents?: string[];
  intentDeny?: Record<string, string[]>;
  model?: string;
  modelFallback?: string;
  thinking?: ThinkLevel;
  lowThinkingMode?: LowThinkingMode;
  allowedChatTypes?: string[];
  allowedChatIds?: string[];
  deniedChatIds?: string[];
  queryMode?: string;
  contextWindow?: ContextWindow;
  timeoutMs?: number;
  complexityPrompts?: ComplexityPromptsConfig;
  instruction?: InstructionConfig;
  review?: ReviewConfig;
};

export type ResolvedSkillHarnessPluginConfig = {
  agents: string[];
  intentDeny: Record<string, string[]>;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  lowThinkingMode: LowThinkingMode;
  allowedChatTypes: string[];
  allowedChatIds: string[];
  deniedChatIds: string[];
  queryMode: "message" | "recent" | "full";
  contextWindow: ContextWindow;
  timeoutMs: number;
  complexityPrompts: ResolvedComplexityPromptsConfig;
  instruction: ResolvedInstructionConfig;
  review: ResolvedReviewConfig;
};

export type IntentDefinition = {
  triggers: string[];
  examples: string[];
  domain: string;
  fastpath: {
    keywords: string[];
    hint?: string;
  };
  prompt: string;
};

export type IntentCatalogEntry = {
  id: string;
  definition: IntentDefinition;
};

export type IntentionResult = {
  intent: string;
  reason: string;
  suggestion?: string;
  keywords?: string[];
  domain: string;
  topic?: string;
  topicChangeReason?: "start" | "marker" | "shift" | "change" | "match";
  previousTopic?: string;
  confidence: number;
  complexity: "low" | "medium" | "high";
};

export type IntentTrigger =
  "exact-keyword" | "same-topic" | "topic-keyword-similarity" | "classifier";

export type AvailableSkill = {
  name: string;
  location: string;
  description: string;
};

export type HistoricalIntent = Pick<
  IntentionResult,
  "intent" | "domain" | "keywords" | "topic" | "topicChangeReason"
> &
  Partial<Pick<IntentionResult, "confidence" | "complexity">>;

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
