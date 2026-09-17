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
  triggers: {
    intentHealthCheck: { enabled: boolean; everyTurns: number };
    routingUncertainty: { enabled: boolean; confidenceBelow: number };
    capabilityFit: {
      enabled: boolean;
      toolCalls: number;
      toolFailures: number;
    };
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

export type ResolvedRoutingScopeConfig = {
  agents: string[];
  chatTypes: string[];
  allowedChatIds: string[];
  deniedChatIds: string[];
};

export type ResolvedScopeConfig = ResolvedRoutingScopeConfig;

export type ResolvedClassifierConfig = {
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutMs: number;
  queryMode: "message" | "recent" | "full";
  contextWindow: ContextWindow;
};
export type ResolvedSkillCandidateSearchConfig = {
  minCandidateScore: number;
  timeoutMs: number;
};

export type ResolvedSkillCandidateNameMatchConfig = {
  maxEditDistance: number;
  minJaccardScore: number;
  genericTokens: string[];
};

export type ResolvedSkillCandidatesConfig = {
  enabled: boolean;
  search: ResolvedSkillCandidateSearchConfig;
  nameMatch: ResolvedSkillCandidateNameMatchConfig;
  maxInjectedSkills: number;
};

export type ResolvedRoutingConfig = {
  scope: ResolvedRoutingScopeConfig;
  thresholds: {
    keyword: {
      directRouteMinScore: number;
    };
    hybrid: {
      directRouteMinScore: number;
      directRouteMinMargin: number;
      minCandidateScore: number;
    };
  };
  classifier: ResolvedClassifierConfig;
  skillCandidates: ResolvedSkillCandidatesConfig;
};

export type ResolvedSkillSearchConfig = {
  collectionWeights: {
    meta: number;
    body: number;
    references: number;
  };
};

export type ResolvedWorkingSetConfig = {
  defaults: string[];
  agents: Record<string, string[]>;
};

export type ResolvedSkillsConfig = {
  workingSet: ResolvedWorkingSetConfig;
  includeWorkspaceSkills: boolean;
  includeWorkshopSkills: boolean;
  suppressNativeSkillPrompt: boolean;
  suppressNativeExtraDirs: boolean;
  sharedRoots: string[];
  search: ResolvedSkillSearchConfig;
};

export type ResolvedQmdConfig = {
  timeoutMs: number;
  indexRefreshIntervalSeconds: number;
  embedding: Required<
    Pick<QmdEmbeddingConfig, "baseUrl" | "model" | "dimension">
  > &
    Omit<QmdEmbeddingConfig, "baseUrl" | "model" | "dimension">;
  expansion: Required<Pick<QmdEndpointConfig, "baseUrl" | "model">> &
    Omit<QmdEndpointConfig, "baseUrl" | "model">;
};

export type ResolvedSkillHarnessPluginConfig = {
  qmd: ResolvedQmdConfig;
  skills: ResolvedSkillsConfig;
  routing: ResolvedRoutingConfig;
  review: ResolvedReviewConfig;
};

export type IntentDefinition = {
  triggers: string[];
  examples: string[];
  skills?: string[];
  keywords: string[];
  guidance: string;
};

export type IntentCatalogEntry = {
  id: string;
  definition: IntentDefinition;
};

export type IntentProjectionSelectionReason =
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

export type IntentRoutingSearchHit = {
  intentId: string;
  score: number;
  collection: string;
  explain?: unknown;
};

export type IntentRoutingRawSearchResult = {
  filepath?: string;
  file?: string;
  displayPath?: string;
  body?: string;
  score: number;
  explain?: unknown;
};

export type IntentRoutingSearchEvidence = {
  query: string;
  hits?: IntentRoutingSearchHit[];
  rawResults?: IntentRoutingRawSearchResult[];
  outcome:
    | "routed"
    | "below-threshold"
    | "below-margin-threshold"
    | "below-score-and-margin-threshold"
    | "unrecognized-intent"
    | "none"
    | "unavailable";
  directRouteMinScore: number;
  directRouteMinMargin?: number;
};

export type IntentRoutingEvidence = {
  keyword?: IntentRoutingSearchEvidence;
  hybrid?: IntentRoutingSearchEvidence & { expansionContext?: string };
};

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

export type IntentionResult = {
  intent: string;
  reason: string;
  keywords?: string[];
  confidence: number;
};

export type ClassifiedIntentionResult = IntentionResult;

export type IntentTrigger = "qmd-keyword" | "qmd-hybrid" | "llm-classifier";

export type AvailableSkill = {
  name: string;
  location: string;
  description: string;
};

export type HistoricalIntent = Pick<IntentionResult, "intent" | "keywords"> &
  Partial<Pick<IntentionResult, "confidence">>;

export type HistoricalIntentRecord = HistoricalIntent & {
  input: string;
};

export type RecentTurn = {
  role: string;
  text: string;
  historicalIntent?: HistoricalIntent;
};
