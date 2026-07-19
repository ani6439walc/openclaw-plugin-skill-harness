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

export const DEFAULT_LOW_COMPLEXITY_PROMPT = `The main agent is handling a LOW / QUICK task.
Calibrate only the optional instruction_hint for that task.

Optional hint content:
- Suggest only the immediate action and expected outcome.
- Keep the hint minimal, direct, and specific to the current turn.
- Omit multi-step sequencing unless ordering is necessary for correctness.

Evidence to suggest:
- If behavior changes, suggest the smallest direct observation that confirms it.
- Omit broader investigation, delegation, full-suite testing, rollback planning, and edge-case inventories unless latest_message explicitly requires them.`;

export const DEFAULT_MEDIUM_COMPLEXITY_PROMPT = `The main agent is handling a MEDIUM / STANDARD task.
Calibrate only the optional instruction_hint for that task.

Optional hint content:
- Start with the single dominant risk, constraint, or affected user-facing surface.
- Suggest one narrow recommended path and its decision criterion; add only the necessary steps in logical order.
- When success is not already observable, name one concrete success condition.
- Preserve only pitfalls or reversibility details that could change the recommendation.

Evidence to suggest:
- Suggest the smallest observation that directly exercises the affected surface or dominant risk.
- Mention test categories only for code changes with a credible test seam.
- Mention rollback only for relevant state-changing operations.
- Increase evidence depth, not task scope; omit unrelated cleanup, redesign, and generic full-suite recommendations.`;

export const DEFAULT_HIGH_COMPLEXITY_PROMPT = `The main agent is handling a HIGH / DEEP task.
Calibrate only the optional instruction_hint for that task.

Optional hint content:
- Start with the dominant uncertainty, irreversible decision, or failure mode.
- When unresolved scope, dependencies, or outward/irreversible risk could change the recommendation, state the smallest decision boundary and evidence needed to resolve it; otherwise retain one recommended path.
- Ground recommendations about unfamiliar APIs, repository behavior, or task-specific claims in a directly relevant source or observed output.
- Suggest only the load-bearing phases, dependencies, and decision points; keep the hint concise rather than turning it into an end-to-end playbook.
- Mention critical risks or reversibility details only when they could change the recommendation.

Evidence to suggest:
- Tie evidence to the core behavior and most material edge or regression risk; when a dominant assumption matters, name one proportionate observation that could disconfirm it.
- When a verification claim relies on a changed check, surface whether it traces to a user-stated requirement, documented intended behavior, or an independent observed surface; a passing altered expectation alone is not completion evidence.
- For a defect, consider a bounded sibling-path sweep only when the same construct could plausibly recur; surface extra scope rather than expanding silently.
- Suggest additional discovery, planning, or review only when it could change the implementation choice; do not prescribe host-specific tools or delegation.
- Preserve authorization, rollback, and safety considerations for relevant state-changing or irreversible operations.
- If evidence cannot support the key decision, surface the observed blocker; otherwise stop after the smallest evidence set that establishes the requested outcome.`;

export const INSTRUCTION_COMPLEXITY_PROMPTS = {
  low: DEFAULT_LOW_COMPLEXITY_PROMPT,
  medium: DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  high: DEFAULT_HIGH_COMPLEXITY_PROMPT,
} as const;

export function isIntentComplexity(value: unknown): value is IntentComplexity {
  return value === "low" || value === "medium" || value === "high";
}
