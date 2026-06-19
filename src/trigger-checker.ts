import type { IntentionResult } from "./types.js";
import type { ResolvedEvolutionConfig } from "./types.js";
import { FALLBACK_INTENT_ID } from "./constants.js";

export const EVOLUTION_TRIGGER_TYPES = [
  "skill_candidate",
  "process_gap",
  "successful_pattern",
  "satisfaction_check",
  "missing_intent",
  "weak_intent",
  "behavior_fix",
] as const;

export type EvolutionTrigger = (typeof EVOLUTION_TRIGGER_TYPES)[number];

type TriggerState = {
  input?: string;
  intent?: { result?: IntentionResult } | IntentionResult;
  skillsUsed?: unknown[];
  toolCalls?: Array<{ error?: string }>;
  result?: string;
  error?: string;
};

function includesAnyKeyword(
  text: string | undefined,
  keywords: readonly string[],
): boolean {
  if (!text) return false;
  const normalizedText = text.toLocaleLowerCase();
  return keywords.some((keyword) =>
    normalizedText.includes(keyword.toLocaleLowerCase()),
  );
}

export function checkEvolutionTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedEvolutionConfig["triggers"],
): EvolutionTrigger[] {
  const matches: EvolutionTrigger[] = [];
  const toolCalls = state.toolCalls ?? [];
  const result =
    state.intent && "intent" in state.intent
      ? state.intent
      : state.intent?.result;

  if (
    config.skillCandidate.enabled &&
    toolCalls.length >= config.skillCandidate.toolCalls
  ) {
    matches.push("skill_candidate");
  }
  if (
    config.processGap.enabled &&
    toolCalls.filter((call) => call.error !== undefined).length >=
      config.processGap.toolFailures
  ) {
    matches.push("process_gap");
  }
  if (
    config.successfulPattern.enabled &&
    !state.error &&
    (toolCalls.length >= config.successfulPattern.toolCalls ||
      (state.skillsUsed?.length ?? 0) > 0) &&
    includesAnyKeyword(
      `${state.input ?? ""}\n${state.result ?? ""}`,
      config.successfulPattern.keywords,
    )
  ) {
    matches.push("successful_pattern");
  }
  if (
    config.satisfactionCheck.enabled &&
    turnNumber > 0 &&
    turnNumber % config.satisfactionCheck.everyTurns === 0
  ) {
    matches.push("satisfaction_check");
  }
  if (
    config.missingIntent.enabled &&
    result?.intent.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase() ===
      FALLBACK_INTENT_ID
  ) {
    matches.push("missing_intent");
  }
  if (
    config.weakIntent.enabled &&
    result &&
    result.confidence < config.weakIntent.confidenceBelow
  ) {
    matches.push("weak_intent");
  }
  if (
    config.behaviorFix.enabled &&
    includesAnyKeyword(state.input, config.behaviorFix.keywords)
  ) {
    matches.push("behavior_fix");
  }

  return matches;
}
