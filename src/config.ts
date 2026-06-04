import { z } from "zod";
import {
  DEFAULT_QUERY_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
  DEFAULT_LOW_COMPLEXITY_PROMPT,
  DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  DEFAULT_HIGH_COMPLEXITY_PROMPT,
} from "./constants.js";
import type {
  ContextWindow,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";

export function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const DEFAULT_CONTEXT_WINDOW: ContextWindow = {
  user: {
    turns: DEFAULT_RECENT_USER_TURNS,
    chars: DEFAULT_RECENT_USER_CHARS,
  },
  assistant: {
    turns: DEFAULT_RECENT_ASSISTANT_TURNS,
    chars: DEFAULT_RECENT_ASSISTANT_CHARS,
  },
};

const DEFAULT_COMPLEXITY_PROMPTS = {
  low: DEFAULT_LOW_COMPLEXITY_PROMPT,
  medium: DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  high: DEFAULT_HIGH_COMPLEXITY_PROMPT,
};

const DEFAULT_CONFIG = {
  agents: ["main"],
  intentDeny: {},
  model: undefined,
  modelFallback: undefined,
  allowedChatTypes: ["direct"],
  allowedChatIds: [],
  deniedChatIds: [],
  queryMode: DEFAULT_QUERY_MODE,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  intentsDir: "./intents",
  complexityPrompts: DEFAULT_COMPLEXITY_PROMPTS,
} satisfies ResolvedIntentionHintPluginConfig;

const StringListSchema = z
  .union([
    z.string().transform((value) => {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }),
    z.array(z.unknown()).transform((values) =>
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ])
  .catch([]);

const stringListWithDefault = (fallback: string[]) =>
  StringListSchema.transform((values) =>
    values.length > 0 ? values : [...fallback],
  );

const boundedInt = (fallback: number, min: number, max: number) =>
  z
    .number()
    .catch(fallback)
    .transform((value) => clampInt(value, fallback, min, max));

const promptString = (fallback: string) =>
  z
    .string()
    .catch(fallback)
    .transform((value) => (value.trim() ? value : fallback));

const UserContextWindowSchema = z
  .object({
    turns: boundedInt(DEFAULT_RECENT_USER_TURNS, 0, 20),
    chars: boundedInt(DEFAULT_RECENT_USER_CHARS, 40, 1000),
  })
  .catch(DEFAULT_CONTEXT_WINDOW.user);

const AssistantContextWindowSchema = z
  .object({
    turns: boundedInt(DEFAULT_RECENT_ASSISTANT_TURNS, 0, 10),
    chars: boundedInt(DEFAULT_RECENT_ASSISTANT_CHARS, 40, 1000),
  })
  .catch(DEFAULT_CONTEXT_WINDOW.assistant);

const ContextWindowSchema = z
  .object({
    user: UserContextWindowSchema,
    assistant: AssistantContextWindowSchema,
  })
  .catch(DEFAULT_CONTEXT_WINDOW);

const ComplexityPromptsSchema = z
  .object({
    low: promptString(DEFAULT_LOW_COMPLEXITY_PROMPT),
    medium: promptString(DEFAULT_MEDIUM_COMPLEXITY_PROMPT),
    high: promptString(DEFAULT_HIGH_COMPLEXITY_PROMPT),
  })
  .catch(DEFAULT_COMPLEXITY_PROMPTS);

const IntentDenySchema = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((entries) => {
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(entries)) {
      const normalizedKey = key.trim();
      if (!normalizedKey || !Array.isArray(value)) continue;
      const patterns = StringListSchema.parse(value);
      if (patterns.length > 0) {
        result[normalizedKey] = patterns;
      }
    }
    return result;
  });

const IntentionHintConfigSchema = z
  .object({
    agents: stringListWithDefault(["main"]),
    intentDeny: IntentDenySchema,
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    allowedChatTypes: stringListWithDefault(["direct"]),
    allowedChatIds: StringListSchema,
    deniedChatIds: StringListSchema,
    queryMode: z.enum(["message", "recent", "full"]).catch(DEFAULT_QUERY_MODE),
    contextWindow: ContextWindowSchema,
    timeoutMs: boundedInt(DEFAULT_TIMEOUT_MS, 250, 120_000),
    intentsDir: z.string().catch("./intents"),
    complexityPrompts: ComplexityPromptsSchema,
  })
  .catch(DEFAULT_CONFIG);

export function resolveConfig(raw: unknown): ResolvedIntentionHintPluginConfig {
  return IntentionHintConfigSchema.parse(
    raw,
  ) as ResolvedIntentionHintPluginConfig;
}
