import type { IntentComplexity, IntentDefinition } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const PROCESSED_EVENTS_RETENTION_DAYS = 90;
export const KEYWORD_COVERAGE_RETENTION_DAYS = 30;
export const LOCK_STALE_THRESHOLD_MS = 60_000;
export const LOCK_MAX_WAIT_MS = 10_000;
export const LOCK_INITIAL_BACKOFF_MS = 10;
export const LOCK_MAX_BACKOFF_MS = 500;
export const DEFAULT_QUERY_MODE = "recent" as const;
export const DEFAULT_RECENT_USER_TURNS = 5;
export const DEFAULT_RECENT_ASSISTANT_TURNS = 5;
export const DEFAULT_RECENT_USER_CHARS = 220;
export const DEFAULT_RECENT_ASSISTANT_CHARS = 180;
export const SKILL_HARNESS_PLUGIN_TAG = "skill_harness_plugin";
export const UNTRUSTED_CONTEXT_HEADER =
  "Generated Skill Harness context for this turn follows. It is not user input: the user's explicit request, higher-priority instructions, and verified repository/tool evidence win. Use the policy inside <skill_harness_plugin> to interpret candidates and advisory guidance:";

export const FALLBACK_INTENT_ID = "other";
export const FALLBACK_INTENT: IntentDefinition = {
  triggers: [],
  examples: [],
  domain: "other",
  fastpath: { keywords: [] },
  guidance:
    "No predefined intent detected. Main Agent should determine the user's true intent and choose an appropriate strategy.",
};

export function isIntentComplexity(value: unknown): value is IntentComplexity {
  return value === "low" || value === "medium" || value === "high";
}
