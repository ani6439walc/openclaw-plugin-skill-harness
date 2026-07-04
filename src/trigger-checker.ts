import type { IntentionResult } from "./types.js";
import type { ResolvedEvolutionConfig } from "./types.js";
import { FALLBACK_INTENT_ID } from "./constants.js";
import {
  DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
  type EvolutionTriggerKeywords,
} from "./evolution-trigger-keywords.js";

export const EVOLUTION_TRIGGER_TYPES = [
  "skill-candidate",
  "process-gap",
  "successful-pattern",
  "satisfaction-check",
  "missing-intent",
  "weak-intent",
  "behavior-fix",
  "entity-context",
] as const;

export type EvolutionTrigger = (typeof EVOLUTION_TRIGGER_TYPES)[number];

type TriggerToolCall = {
  name?: string;
  params?: Record<string, unknown>;
  error?: string;
};

type TriggerState = {
  input?: string;
  intent?: { result?: IntentionResult } | IntentionResult;
  skillsUsed?: unknown[];
  toolCalls?: TriggerToolCall[];
  result?: string;
  error?: string;
};

const ENTITY_CONTEXT_SOURCE_FILES = ["tools.md", "memory.md"];
const ENTITY_CONTEXT_SOURCE_SUBSTRINGS = ["memory"];
const ENTITY_CONTEXT_READ_TOOLS = new Set([
  "read",
  "read_file",
  "search_files",
]);
const BEHAVIOR_FIX_QUOTED_CONTENT_MARKERS = [
  "dream diary",
  "memory fragments",
  "from these memory fragments",
  "ingest prompt",
  "ingest payload",
];

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

function isQuotedContentPrompt(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLocaleLowerCase();
  return BEHAVIOR_FIX_QUOTED_CONTENT_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
}

function hasEntityContextSourceText(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLocaleLowerCase();
  return (
    ENTITY_CONTEXT_SOURCE_FILES.some((source) => normalized.includes(source)) ||
    normalized.includes("/memory") ||
    normalized.includes("memory/") ||
    normalized.includes("\\memory") ||
    normalized.includes("memory\\")
  );
}

function hasEntityContextSourceParam(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLocaleLowerCase();
  return (
    hasEntityContextSourceText(normalized) ||
    ENTITY_CONTEXT_SOURCE_SUBSTRINGS.some((source) =>
      normalized.includes(source),
    )
  );
}

function stringifyParam(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    return value.map(stringifyParam).filter(Boolean).join(" ");
  }
  return;
}

function toolCallsReadEntityContextSource(
  toolCalls: readonly TriggerToolCall[],
): boolean {
  return toolCalls.some((call) => {
    if (!call.name || !ENTITY_CONTEXT_READ_TOOLS.has(call.name)) return false;
    return Object.values(call.params ?? {}).some((value) =>
      hasEntityContextSourceParam(stringifyParam(value)),
    );
  });
}

function hasEntityContextSourceSignal(
  text: string,
  toolCalls: readonly TriggerToolCall[],
): boolean {
  return (
    hasEntityContextSourceText(text) ||
    toolCallsReadEntityContextSource(toolCalls)
  );
}

export function checkEvolutionTriggers(
  state: TriggerState,
  turnNumber: number,
  config: ResolvedEvolutionConfig["triggers"],
  triggerKeywords: EvolutionTriggerKeywords = DEFAULT_EVOLUTION_TRIGGER_KEYWORDS,
): EvolutionTrigger[] {
  const matches: EvolutionTrigger[] = [];
  const toolCalls = state.toolCalls ?? [];
  const text = `${state.input ?? ""}\n${state.result ?? ""}`;
  const result =
    state.intent && "intent" in state.intent
      ? state.intent
      : state.intent?.result;

  if (
    config.skillCandidate.enabled &&
    toolCalls.length >= config.skillCandidate.toolCalls
  ) {
    matches.push("skill-candidate");
  }
  if (
    config.processGap.enabled &&
    toolCalls.filter((call) => call.error !== undefined).length >=
      config.processGap.toolFailures
  ) {
    matches.push("process-gap");
  }
  if (
    config.successfulPattern.enabled &&
    !state.error &&
    (toolCalls.length >= config.successfulPattern.toolCalls ||
      (state.skillsUsed?.length ?? 0) > 0) &&
    includesAnyKeyword(text, triggerKeywords.successfulPattern)
  ) {
    matches.push("successful-pattern");
  }
  if (
    config.satisfactionCheck.enabled &&
    turnNumber > 0 &&
    turnNumber % config.satisfactionCheck.everyTurns === 0
  ) {
    matches.push("satisfaction-check");
  }
  if (
    config.missingIntent.enabled &&
    result?.intent.match(/^([A-Za-z0-9_-]+)/)?.[1]?.toLowerCase() ===
      FALLBACK_INTENT_ID
  ) {
    matches.push("missing-intent");
  }
  if (
    config.weakIntent.enabled &&
    result &&
    result.confidence < config.weakIntent.confidenceBelow
  ) {
    matches.push("weak-intent");
  }
  if (
    config.behaviorFix.enabled &&
    !isQuotedContentPrompt(state.input) &&
    includesAnyKeyword(state.input, triggerKeywords.behaviorFix)
  ) {
    matches.push("behavior-fix");
  }
  if (
    config.entityContext.enabled &&
    includesAnyKeyword(text, triggerKeywords.entityContext) &&
    hasEntityContextSourceSignal(text, toolCalls)
  ) {
    matches.push("entity-context");
  }

  return matches;
}
