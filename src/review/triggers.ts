import type { ResolvedReviewConfig } from "../types.js";

export const REVIEW_TRIGGER_TYPES = [
  "experience-health-check",
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
  intent?:
    | { result?: { confidence?: number; intent?: string } }
    | { confidence?: number; intent?: string };
  matchedSkills?: Array<{ name: string }> | string[];
  matchedExperiences?: Array<{ id: string }> | string[];
};

export function checkReviewTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedReviewConfig["triggers"],
): ReviewTrigger[] {
  const matches: ReviewTrigger[] = [];
  const toolCalls = state.toolCalls ?? [];

  const healthCheck = config.experienceHealthCheck ?? config.intentHealthCheck;
  if (
    healthCheck?.enabled &&
    turnNumber > 0 &&
    turnNumber % healthCheck.everyTurns === 0
  ) {
    matches.push("experience-health-check");
  }

  const legacyConfidence =
    state.intent && "confidence" in state.intent
      ? state.intent.confidence
      : state.intent && "result" in state.intent
        ? state.intent.result?.confidence
        : undefined;
  const confidence = state.confidence ?? legacyConfidence;

  if (
    config.routingUncertainty.enabled &&
    typeof confidence === "number" &&
    confidence < config.routingUncertainty.confidenceBelow
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
