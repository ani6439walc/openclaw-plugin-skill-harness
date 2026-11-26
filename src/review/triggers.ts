import type { ResolvedReviewConfig } from "../types.js";

export const REVIEW_TRIGGER_TYPES = [
  "relation-health-check",
  "routing-uncertainty",
  "capability-fit",
] as const;

export type ReviewTrigger = (typeof REVIEW_TRIGGER_TYPES)[number];

type TriggerToolCall = {
  name?: string;
  error?: string;
};

export type TriggerState = {
  toolCalls?: TriggerToolCall[];
  confidence?: number;
};

export function checkReviewTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedReviewConfig["triggers"],
): ReviewTrigger[] {
  const matches: ReviewTrigger[] = [];
  const toolCalls = state.toolCalls ?? [];

  const healthCheck = config.relationHealthCheck;
  if (
    healthCheck?.enabled &&
    turnNumber > 0 &&
    turnNumber % healthCheck.everyTurns === 0
  ) {
    matches.push("relation-health-check");
  }

  if (
    config.routingUncertainty.enabled &&
    typeof state.confidence === "number" &&
    state.confidence < config.routingUncertainty.confidenceBelow
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
