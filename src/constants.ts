import type { IntentDefinition } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const PROCESSED_EVENTS_RETENTION_DAYS = 90;
export const KEYWORD_COVERAGE_RETENTION_DAYS = 30;
export const LOCK_MAX_WAIT_MS = 10_000;
export const LOCK_INITIAL_BACKOFF_MS = 10;
export const LOCK_MAX_BACKOFF_MS = 500;
export const DEFAULT_QUERY_MODE = "recent" as const;
export const DEFAULT_RECENT_USER_TURNS = 5;
export const DEFAULT_RECENT_ASSISTANT_TURNS = 5;
export const DEFAULT_RECENT_USER_CHARS = 220;
export const DEFAULT_RECENT_ASSISTANT_CHARS = 180;
export const SKILL_HARNESS_PLUGIN_TAG = "skill_harness_plugin";
export const ROUTING_ADVISORY_HEADER =
  "Inferred intent and candidate skills (advisory, non-user input; load with `skill_view` if relevant):";
export const ROUTING_ADVISORY_INTENT_ONLY_HEADER =
  "Inferred user intent from conversation (advisory, non-user input):";
export const INTERNAL_RUNTIME_CONTEXT_BEGIN =
  "<<<BEGIN_SKILL_HARNESS_CONTEXT>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_SKILL_HARNESS_CONTEXT>>>";
export const UNTRUSTED_CONTEXT_HEADER =
  "Skill Harness context (advisory, non-user input):";
export const CANDIDATE_SKILLS_GUIDANCE =
  "When relevant, load candidate skills with `skill_view` before proceeding:";
export const USER_MESSAGE_BOUNDARY = INTERNAL_RUNTIME_CONTEXT_END;

export const FALLBACK_INTENT_ID = "other";
export const FALLBACK_INTENT: IntentDefinition = {
  triggers: [],
  examples: [],
  domain: "other",
  keywords: [],
  guidance:
    "No predefined intent detected. Main Agent should determine the user's true intent and choose an appropriate strategy.",
};
