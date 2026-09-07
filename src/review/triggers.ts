import type { IntentionResult, ResolvedReviewConfig } from "../types.js";
import { FALLBACK_INTENT_ID } from "../constants.js";

export const REVIEW_TRIGGER_TYPES = [
  "intent-health-check",
  "routing-uncertainty",
  "capability-fit",
] as const;

export type ReviewTrigger = (typeof REVIEW_TRIGGER_TYPES)[number];

type TriggerToolCall = {
  name?: string;
  error?: string;
};

export type TriggerState = {
  intent?: { result?: IntentionResult } | IntentionResult;
  toolCalls?: TriggerToolCall[];
};

function resolveIntentResult(
  intent: TriggerState["intent"],
): IntentionResult | undefined {
  return intent && "intent" in intent ? intent : intent?.result;
}

export function checkReviewTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedReviewConfig["triggers"],
): ReviewTrigger[] {
  const matches: ReviewTrigger[] = [];
  const result = resolveIntentResult(state.intent);
  const toolCalls = state.toolCalls ?? [];

  if (
    config.intentHealthCheck.enabled &&
    turnNumber > 0 &&
    turnNumber % config.intentHealthCheck.everyTurns === 0
  ) {
    matches.push("intent-health-check");
  }

  if (
    config.routingUncertainty.enabled &&
    result &&
    (result.intent.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase() ===
      FALLBACK_INTENT_ID ||
      result.confidence < config.routingUncertainty.confidenceBelow)
  ) {
    matches.push("routing-uncertainty");
  }

  if (
    config.capabilityFit.enabled &&
    (toolCalls.length >= config.capabilityFit.toolCalls ||
      toolCalls.filter((call) => call.error !== undefined).length >=
        config.capabilityFit.toolFailures)
  ) {
    matches.push("capability-fit");
  }

  return matches;
}
