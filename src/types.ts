export type ThinkLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";

export type ResolvedReviewConfig = {
  enabled: boolean;
  model: string | undefined;
  modelFallback: string | undefined;
  thinking: ThinkLevel;
  timeoutSeconds: number;
  triggers: {
    experienceHealthCheck: { enabled: boolean; everyTurns: number };
    intentHealthCheck?: { enabled: boolean; everyTurns: number };
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

export type ResolvedExperienceCandidateSearchConfig = {
  minCandidateScore: number;
  timeoutMs: number;
};

export type ResolvedRoutingExperiencesConfig = {
  search: ResolvedExperienceCandidateSearchConfig;
  relevanceThreshold: number;
  maxInjectedExperiences: number;
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

export type ResolvedRoutingSkillsConfig = {
  search: ResolvedSkillCandidateSearchConfig;
  nameMatch: ResolvedSkillCandidateNameMatchConfig;
  relevanceThreshold: number;
  maxInjectedSkills: number;
};

export type ResolvedSkillCandidatesConfig = ResolvedRoutingSkillsConfig;

export type RoutingLlmResult = {
  skills: string[];
  experiences: string[];
  confidence: number;
  reason: string;
};

export type SkillRerankerResult = RoutingLlmResult;

export type ContextWindow = {
  user: { turns: number; chars: number };
  assistant: { turns: number; chars: number };
};

export type ResolvedRoutingConfig = {
  scope: ResolvedRoutingScopeConfig;
  experiences: ResolvedRoutingExperiencesConfig;
  skills: ResolvedRoutingSkillsConfig;
  timeoutMs: number;
  queryMode: "message" | "recent" | "full";
  contextWindow: ContextWindow;
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
  jev?: QmdEndpointConfig;
};

export type ResolvedSkillHarnessPluginConfig = {
  qmd: ResolvedQmdConfig;
  jev: QmdEndpointConfig;
  skills: ResolvedSkillsConfig;
  routing: ResolvedRoutingConfig;
  review: ResolvedReviewConfig;
};

export type AvailableSkill = {
  name: string;
  location: string;
  description: string;
};

export type RecentTurn = {
  role: string;
  text: string;
};
