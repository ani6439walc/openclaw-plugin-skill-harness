import type { EvolutionTrigger } from "./trigger-checker.js";
import type { EvolutionOperation } from "./evolution-backlog.js";
import type {
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
  intentCatalog: Array<
    { id: string } & Pick<IntentDefinition, "triggers" | "examples">
  >;
};

export type EvolutionFinding = {
  trigger: EvolutionTrigger;
  operation: EvolutionOperation;
  targetIntentIds: string[];
  dedupeKey: string;
  summary: string;
  evidence: string[];
  correctionGoal: string;
  suggestedChange: string;
};

export type EvolutionSource = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  turnStart: string;
};
