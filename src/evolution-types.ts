import type { EvolutionTrigger } from "./trigger-checker.js";
import type { IntentDefinition, IntentionResult } from "./types.js";

export type ReviewState = {
  input?: string;
  intent?: IntentionResult;
  skillsUsed?: string[];
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
  matchedIntent?: IntentDefinition;
  intentCatalog: Array<
    Pick<IntentDefinition, "id" | "name" | "triggers" | "examples">
  >;
};

export type EvolutionFinding = {
  trigger: EvolutionTrigger;
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
