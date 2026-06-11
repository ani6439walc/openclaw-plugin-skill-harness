import type { IntentionResult } from "./types.js";
import type { ResolvedSelfEvolutionConfig } from "./types.js";

export const EVOLUTION_TRIGGER_TYPES = [
  "skill_candidate",
  "process_gap",
  "satisfaction_check",
  "missing_intent",
  "weak_intent",
  "behavior_fix",
] as const;

export type EvolutionTrigger = (typeof EVOLUTION_TRIGGER_TYPES)[number];

type TriggerState = {
  input?: string;
  intent?: { result?: IntentionResult } | IntentionResult;
  toolCalls?: Array<{ error?: string }>;
};

export function checkEvolutionTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedSelfEvolutionConfig["triggers"],
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
    config.satisfactionCheck.enabled &&
    turnNumber > 0 &&
    turnNumber % config.satisfactionCheck.everyTurns === 0
  ) {
    matches.push("satisfaction_check");
  }
  if (
    config.missingIntent.enabled &&
    result?.intent.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toUpperCase() === "OTHER"
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
    state.input &&
    config.behaviorFix.keywords.some((keyword) =>
      state.input!.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
    )
  ) {
    matches.push("behavior_fix");
  }

  return matches;
}
