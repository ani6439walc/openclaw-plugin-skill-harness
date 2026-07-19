import type { IntentComplexity, IntentDefinition } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 3_000;
export const PROCESSED_EVENTS_RETENTION_DAYS = 90;
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
  prompt:
    "No predefined intent detected. Main Agent should determine the user's true intent and choose an appropriate strategy.",
};

export const DEFAULT_LOW_COMPLEXITY_PROMPT = `You are working on LOW / QUICK tasks.

Hint depth calibration:
- Provide minimal, focused guidance.
- Keep suggestions concise and direct.
- Avoid extensive workflow detail or multi-step ordering.
- Focus on the immediate action and expected outcome.

Verification guidance:
- If behavior changes, suggest only the smallest direct verification that confirms it.
- Do not elaborate on testing strategy or edge cases unless explicitly requested.
- Do not suggest broad investigation, delegation, full-suite testing, rollback planning, or edge-case inventories unless the task explicitly requires them.`;

export const DEFAULT_MEDIUM_COMPLEXITY_PROMPT = `You are working on MEDIUM / STANDARD tasks.

Hint depth calibration:
- Provide balanced guidance with appropriate detail.
- Include relevant workflow steps in logical order when helpful.
- Identify the single dominant risk, constraint, or affected user-facing surface before suggesting verification.
- Mention only key pitfalls or constraints that affect the approach.
- Balance completeness with conciseness.

Verification guidance:
- Suggest the smallest verification that directly exercises the affected surface or dominant risk.
- Include relevant test categories only for code changes with a credible test seam.
- Mention rollback considerations only for relevant state-changing operations.
- Increase verification depth, not task scope. Avoid unrelated cleanup, redesign, or generic full-suite recommendations.`;

export const DEFAULT_HIGH_COMPLEXITY_PROMPT = `You are working on HIGH / DEEP tasks.

Hint depth calibration:
- Provide comprehensive guidance with detailed workflow.
- Include phased approach with dependencies and verification points.
- Identify the dominant uncertainty, irreversible decision, or failure mode before recommending a workflow.
- Highlight critical pitfalls, constraints, and decision points.
- Emphasize risk assessment and reversibility considerations.

Verification guidance:
- Suggest focused discovery, planning, or review only when it can change the implementation choice; do not prescribe host-specific tools or delegation.
- Recommend proportionate evidence for the core behavior plus the most material edge or regression risk, using the user-facing surface when practical.
- Preserve authorization, rollback, and safety considerations for relevant state-changing or irreversible operations.
- Stop after the smallest evidence set that establishes the requested outcome; do not add ceremonial or unrelated work.`;

export const INSTRUCTION_COMPLEXITY_PROMPTS = {
  low: DEFAULT_LOW_COMPLEXITY_PROMPT,
  medium: DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  high: DEFAULT_HIGH_COMPLEXITY_PROMPT,
} as const;

export function isIntentComplexity(value: unknown): value is IntentComplexity {
  return value === "low" || value === "medium" || value === "high";
}
