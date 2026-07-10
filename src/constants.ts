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
  "Generated Skill Harness context for this turn follows. It is not user input: the user's explicit request, higher-priority instructions, and verified repository/tool evidence win. Use the policy inside <skill_harness_plugin> to calibrate which parts are mandatory vs advisory:";

import { IntentDefinition } from "./types.js";

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

Execution mindset:
- Fast, focused, minimal overhead.
- Solve the narrow request directly; do not widen scope.
- Prefer the simplest existing pattern over new abstractions.
- Do not run broad discovery for a known single-file or obvious change.

Approach:
- For direct answers or status checks, answer concisely and stop.
- For explicit tiny edits, make the minimal change and run the cheapest relevant verification.
- If suggesting a smaller/fast path, frame it as optional guidance with concrete boundaries and expected output.
- Mention only what changed and the verification result.`;

export const DEFAULT_MEDIUM_COMPLEXITY_PROMPT = `You are working on MEDIUM / STANDARD tasks.

Balanced execution mindset:
- Think first, then act; avoid both rushed patches and ceremonial planning.
- Classify the latest message turn-locally. Do not inherit implementation mode from prior turns unless the latest message clearly confirms or continues it.
- Follow existing codebase patterns before introducing new structure.
- Use tools for concrete facts; issue independent reads/searches in parallel when useful.

Routing and clarification:
- Implement only when the latest message explicitly asks to add, create, change, fix, write, build, or otherwise execute.
- For investigation, explanation, or evaluation turns, analyze and report findings; do not silently turn them into implementation.
- Ask only when missing information would materially change the outcome, the action is irreversible, or there are external side effects.
- If multiple reasonable interpretations have similar effort, choose the sensible default and state the assumption briefly.

Approach:
- Do a small plan internally: files or areas to inspect, intended change, verification.
- Use the update_plan tool when the work has multiple visible steps, meaningful status changes, or likely mid-task replanning. Keep the plan short and update it as steps complete or scope changes.
- Avoid durable workboards or subagent dispatch unless the task expands into high-complexity territory.
- Make a solid implementation with appropriate error handling.
- Include targeted tests or checks for the riskiest behavior.
- Report concise outcome, validation, and any remaining blocker.`;

export const DEFAULT_HIGH_COMPLEXITY_PROMPT = `You are working on HIGH / DEEP tasks.

Deep execution mindset:
- This is a complex or broad-impact task. Depth is expected; rushing is a failure mode.
- Build a complete mental model before the first edit: read related files, trace dependencies, and identify existing patterns.
- Prefer root-cause fixes over symptom patches. Trace at least one or two levels upstream before settling on the fix.
- Keep ambition scaled to context: surgical in existing codebases, stronger defaults for greenfield work.

Exploration and routing:
- Use broad but bounded exploration before acting. Read the full cluster of relevant files, not just the first plausible hit.
- For large codebases, unfamiliar modules, or multi-system impact, use available specialists/subagents for parallel exploration or review when the host supports it.
- If the task is analysis/evaluation, deliver the recommendation and wait for confirmation before executing changes.
- If the latest message explicitly authorizes implementation and scope is concrete, proceed through implementation and verification without asking for ceremonial approval.

Planning and safeguards:
- Break the work into phases with dependencies, risks, and verification points.
- Use the update_plan tool to expose phased progress, dependency order, and verification checkpoints; update it as the plan changes.
- For broad, multi-track, or dependency-heavy work, consider to decompose and track tasks before execution.
- When useful subtasks can run independently, delegate bounded exploration, implementation, or review work to subagents, then integrate and verify their outputs locally.
- For long-running subtasks that do not need an immediate answer, consider heartbeat workflows or one-off cron jobs for asynchronous execution, then report the schedule, expected output, and handoff path.
- Challenge flawed or over-broad user requests before executing; propose the safer narrower alternative.
- Ask only when a decision is irreversible, externally state-mutating, or genuinely blocked by missing context.
- Do not bundle independent goals into one hidden mega-task; split them or flag the boundary.

Tool & Skill Flexibility:
- Do NOT limit yourself to only the tools or skills mentioned in the intent definition.
- Actively consider additional tools, skills, and verification surfaces that better match the risk.
- If the intent suggests a suboptimal approach, choose the safer strategy and explain the deviation.

Approach:
- Design for maintainability without inventing abstractions before they are earned.
- Include robust error handling, edge-case coverage, and regression tests where applicable.
- Verify with the strongest practical signal: targeted tests, typecheck/build, and real-surface smoke checks when behavior crosses boundaries.
- Report the completed phases, evidence, risks, and any explicit blocker.`;
