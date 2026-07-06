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
  ResolvedSkillHarnessPluginConfig,
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

const DEFAULT_EVOLUTION = {
  enabled: false,
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  timeoutMs: 30_000,
  triggers: {
    skillCandidate: { enabled: true, toolCalls: 5 },
    processGap: { enabled: true, toolFailures: 2 },
    successfulPattern: {
      enabled: true,
      toolCalls: 5,
    },
    satisfactionCheck: { enabled: true, everyTurns: 10 },
    missingIntent: { enabled: true },
    weakIntent: { enabled: true, confidenceBelow: 0.5 },
    behaviorFix: { enabled: true },
    entityContext: { enabled: true },
  },
} as const;

const DEFAULT_CONFIG = {
  agents: ["main"],
  intentDeny: {},
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  lowThinkingMode: "fastpath-only",
  allowedChatTypes: ["direct"],
  allowedChatIds: [],
  deniedChatIds: [],
  queryMode: DEFAULT_QUERY_MODE,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  complexityPrompts: DEFAULT_COMPLEXITY_PROMPTS,
  evolution: DEFAULT_EVOLUTION,
} satisfies ResolvedSkillHarnessPluginConfig;

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

const enabledSchema = z.boolean().catch(true);
const ThinkLevelSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])
  .catch("medium");
const LowThinkingModeSchema = z
  .enum(["fastpath-only", "full", "off"])
  .catch("fastpath-only");
const EvolutionSchema = z
  .object({
    enabled: z.boolean().catch(false),
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    timeoutMs: boundedInt(30_000, 250, 600_000),
    triggers: z
      .object({
        skillCandidate: z
          .object({
            enabled: enabledSchema,
            toolCalls: boundedInt(5, 1, 100),
          })
          .catch(DEFAULT_EVOLUTION.triggers.skillCandidate),
        processGap: z
          .object({
            enabled: enabledSchema,
            toolFailures: boundedInt(2, 1, 100),
          })
          .catch(DEFAULT_EVOLUTION.triggers.processGap),
        successfulPattern: z
          .object({
            enabled: enabledSchema,
            toolCalls: boundedInt(5, 1, 100),
            keywords: StringListSchema.optional().catch(undefined),
          })
          .catch(DEFAULT_EVOLUTION.triggers.successfulPattern),
        satisfactionCheck: z
          .object({
            enabled: enabledSchema,
            everyTurns: boundedInt(10, 1, 1000),
          })
          .catch(DEFAULT_EVOLUTION.triggers.satisfactionCheck),
        missingIntent: z
          .object({ enabled: enabledSchema })
          .catch(DEFAULT_EVOLUTION.triggers.missingIntent),
        weakIntent: z
          .object({
            enabled: enabledSchema,
            confidenceBelow: z
              .number()
              .catch(0.5)
              .transform((value) => Math.max(0, Math.min(1, value))),
          })
          .catch(DEFAULT_EVOLUTION.triggers.weakIntent),
        behaviorFix: z
          .object({
            enabled: enabledSchema,
            keywords: StringListSchema.optional().catch(undefined),
          })
          .catch(DEFAULT_EVOLUTION.triggers.behaviorFix),
        entityContext: z
          .object({
            enabled: enabledSchema,
            keywords: StringListSchema.optional().catch(undefined),
          })
          .catch(DEFAULT_EVOLUTION.triggers.entityContext),
      })
      .catch(DEFAULT_EVOLUTION.triggers),
  })
  .catch(DEFAULT_EVOLUTION);

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

const SkillHarnessConfigSchema = z
  .object({
    agents: stringListWithDefault(["main"]),
    intentDeny: IntentDenySchema,
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    lowThinkingMode: LowThinkingModeSchema,
    allowedChatTypes: stringListWithDefault(["direct"]),
    allowedChatIds: StringListSchema,
    deniedChatIds: StringListSchema,
    queryMode: z.enum(["message", "recent", "full"]).catch(DEFAULT_QUERY_MODE),
    contextWindow: ContextWindowSchema,
    timeoutMs: boundedInt(DEFAULT_TIMEOUT_MS, 250, 120_000),
    complexityPrompts: ComplexityPromptsSchema,
    evolution: EvolutionSchema,
  })
  .catch(DEFAULT_CONFIG);

export function resolveConfig(raw: unknown): ResolvedSkillHarnessPluginConfig {
  return SkillHarnessConfigSchema.parse(
    raw,
  ) as ResolvedSkillHarnessPluginConfig;
}
