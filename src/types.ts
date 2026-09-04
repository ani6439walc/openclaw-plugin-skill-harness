export type ContextWindow = {
  user: { turns: number; chars: number };
  assistant: { turns: number; chars: number };
};

export type ThinkLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";

export type ResolvedReviewConfig = {
  enabled: boolean;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutSeconds: number;
  keywordCoverage: { everyAcceptedTurns: number };
  triggers: {
    skillCandidate: { enabled: boolean; toolCalls: number };
    skillPlacement: { enabled: boolean };
    processGap: { enabled: boolean; toolFailures: number };
    successfulPattern: {
      enabled: boolean;
      toolCalls: number;
    };
    satisfactionCheck: { enabled: boolean; everyTurns: number };
    missingIntent: { enabled: boolean };
    weakIntent: { enabled: boolean; confidenceBelow: number };
    behaviorFix: { enabled: boolean };
    entityContext: { enabled: boolean };
  };
};

export type QmdEndpointConfig = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

export type QmdEmbeddingConfig = QmdEndpointConfig & {
  dimension?: number;
};

export type ResolvedRoutingConfig = {
  qmd: {
    directRouteMinScore: number;
    minCandidateScore: number;
  };
};

export type ResolvedSkillSearchConfig = {
  collectionWeights: {
    meta: number;
    body: number;
    references: number;
  };
};
export type ResolvedQmdConfig = {
  timeoutMs: number;
  indexRefreshIntervalSeconds: number;
  embedding: Required<Pick<QmdEmbeddingConfig, "baseUrl" | "model">> &
    Omit<QmdEmbeddingConfig, "baseUrl" | "model">;
  expansion: Required<Pick<QmdEndpointConfig, "baseUrl" | "model">> &
    Omit<QmdEndpointConfig, "baseUrl" | "model">;
  skillSearch: ResolvedSkillSearchConfig;
};

export type ResolvedSkillHarnessPluginConfig = {
  agents: string[];
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  allowedChatTypes: string[];
  allowedChatIds: string[];
  deniedChatIds: string[];
  queryMode: "message" | "recent" | "full";
  contextWindow: ContextWindow;
  timeoutMs: number;
  qmd: ResolvedQmdConfig;
  routing: ResolvedRoutingConfig;
  review: ResolvedReviewConfig;
};

export type IntentDefinition = {
  triggers: string[];
  examples: string[];
  domain: string;
  skills?: string[];
  keywords: string[];
  guidance: string;
};

export type IntentCatalogEntry = {
  id: string;
  definition: IntentDefinition;
};

export type IntentProjectionSelectionReason =
  | "predicted-domain"
  | "authorized-history"
  | "candidate-keyword"
  | "intent-id"
  | "qmd-hit"
  | "recent-history";

export type IntentProjectionSupportReason =
  | "high-overall-confidence"
  | "authorized-history"
  | "exact-evidence"
  | "qmd-retrieval";

export type IntentProjectionTelemetry = {
  decision: "projected" | "full-fallback";
  effectiveInput: "projected" | "full-fallback";
  fallbackReason?: string;
  originalIntentCount: number;
  candidateIntentCount: number;
  originalCatalogCodePoints?: number;
  candidateCatalogCodePoints?: number;
  durationMs: number;
  candidateIntentIds: string[];
  candidateSelections: Array<{
    intentId: string;
    selectionReasons: IntentProjectionSelectionReason[];
    matchedKeywords: string[];
  }>;
  supportReasons: IntentProjectionSupportReason[];
  selectionReasons: IntentProjectionSelectionReason[];
  matchedKeywords: string[];
};

export type IntentComplexity = "low" | "medium" | "high";

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
  complexity?: IntentComplexity;
};

export type ClassifiedIntentionResult = IntentionResult;

export type IntentTrigger =
  | "keyword"
  | "exact-keyword"
  | "same-topic"
  | "qmd-topic-keyword"
  | "qmd-trigger"
  | "classifier";

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
