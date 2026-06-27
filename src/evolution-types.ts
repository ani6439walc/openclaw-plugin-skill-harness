import type { EvolutionTrigger } from "./trigger-checker.js";
import type { EvolutionOperation } from "./evolution-backlog.js";
import type { TriggerKeywordTarget } from "./evolution-trigger-keywords.js";
import type {
  AvailableSkill,
  IntentCatalogEntry,
  IntentDefinition,
  IntentionResult,
} from "./types.js";

export type ReviewState = {
  input?: string;
  intent?: IntentionResult;
  skillsUsed?: Array<{
    name: string;
    description?: string;
    path: string;
  }>;
  toolCalls?: Array<{
    name: string;
    params?: Record<string, string>;
    error?: string;
    durationMs?: number;
  }>;
  result?: string;
  error?: string;
  timestamps?: { start?: string; end?: string };
};

export type ReviewSnapshot = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  eventId: string;
  turnNumber: number;
  current: ReviewState;
  recent: ReviewState[];
  matchedIntent?: IntentCatalogEntry;
  availableSkills?: AvailableSkill[];
  intentCatalog: Array<
    { id: string } & Pick<IntentDefinition, "triggers" | "examples"> &
      Partial<Pick<IntentDefinition, "domain" | "fastpath">>
  >;
};

type BaseEvolutionFinding = {
  trigger: EvolutionTrigger;
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

export type IntentMarkdownEvolutionFinding = BaseEvolutionFinding & {
  targetKind: "intent-markdown";
  operation: EvolutionOperation;
  targetIntentIds: string[];
};

export type TriggerKeywordsEvolutionFinding = BaseEvolutionFinding & {
  targetKind: "trigger-keywords";
  targetTrigger: TriggerKeywordTarget;
  addKeywords: string[];
  removeKeywords: string[];
};

export type EvolutionFinding =
  | IntentMarkdownEvolutionFinding
  | TriggerKeywordsEvolutionFinding;

export type EvolutionSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
