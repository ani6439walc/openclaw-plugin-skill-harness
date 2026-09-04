import { z } from "zod";
import {
  DEFAULT_QUERY_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
} from "./constants.js";
import type {
  ContextWindow,
  ResolvedClassifierConfig,
  ResolvedQmdConfig,
  ResolvedReviewConfig,
  ResolvedRoutingConfig,
  ResolvedScopeConfig,
  ResolvedSkillHarnessPluginConfig,
  ResolvedSkillSearchConfig,
  ResolvedSkillsConfig,
} from "./types.js";
import type { OpenClawConfig } from "../api.js";
import { resolveQmdEndpoint } from "./qmd/provider-resolver.js";

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

const DEFAULT_SCOPE: ResolvedScopeConfig = {
  agents: ["main"],
  chatTypes: ["direct"],
  allowedChatIds: [],
  deniedChatIds: [],
};

const DEFAULT_CLASSIFIER: ResolvedClassifierConfig = {
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  queryMode: DEFAULT_QUERY_MODE,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
};

const DEFAULT_ROUTING: ResolvedRoutingConfig = {
  thresholds: {
    directRouteMinScore: 0.85,
    minCandidateScore: 0.35,
  },
  classifier: DEFAULT_CLASSIFIER,
};

const DEFAULT_SKILL_SEARCH: ResolvedSkillSearchConfig = {
  collectionWeights: { meta: 1, body: 1, references: 1 },
};

const DEFAULT_SKILLS: ResolvedSkillsConfig = {
  search: DEFAULT_SKILL_SEARCH,
};

const DEFAULT_QMD: ResolvedQmdConfig = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  indexRefreshIntervalSeconds: 300,
  embedding: { baseUrl: "", model: "", dimension: 1536 },
  expansion: { baseUrl: "", model: "" },
};

const DEFAULT_REVIEW = {
  enabled: false,
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  timeoutSeconds: 300,
  keywordCoverage: { everyAcceptedTurns: 50 },
  triggers: {
    skillCandidate: { enabled: true, toolCalls: 5 },
    skillPlacement: { enabled: true },
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

const DEFAULT_CONFIG: ResolvedSkillHarnessPluginConfig = {
  scope: DEFAULT_SCOPE,
  routing: DEFAULT_ROUTING,
  skills: DEFAULT_SKILLS,
  qmd: DEFAULT_QMD,
  review: DEFAULT_REVIEW,
};

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

const ScopeSchema = z
  .object({
    agents: stringListWithDefault(["main"]),
    chatTypes: z
      .union([z.string().transform((val) => [val]), z.array(z.unknown())])
      .catch(["direct"])
      .transform((values: unknown[]) => {
        const filtered = values
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v): v is "direct" | "group" | "channel" | "explicit" =>
            ["direct", "group", "channel", "explicit"].includes(v),
          );
        return filtered.length > 0 ? filtered : ["direct"];
      }),
    allowedChatIds: StringListSchema,
    deniedChatIds: StringListSchema,
  })
  .catch(DEFAULT_SCOPE);

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

const ThinkLevelSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])
  .catch("medium");

const ClassifierSchema = z
  .object({
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    timeoutMs: boundedInt(DEFAULT_TIMEOUT_MS, 1_000, 60_000),
    queryMode: z.enum(["message", "recent", "full"]).catch(DEFAULT_QUERY_MODE),
    contextWindow: ContextWindowSchema,
  })
  .catch(DEFAULT_CLASSIFIER)
  .transform((val): ResolvedClassifierConfig => ({
    model: val.model ?? undefined,
    modelFallback: val.modelFallback ?? undefined,
    thinking: val.thinking,
    timeoutMs: val.timeoutMs,
    queryMode: val.queryMode,
    contextWindow: val.contextWindow,
  }));

const RoutingScoreSchema = (fallback: number) =>
  z.number().min(0).max(1).optional().default(fallback);

const RoutingThresholdsSchema = z
  .object({
    directRouteMinScore: RoutingScoreSchema(
      DEFAULT_ROUTING.thresholds.directRouteMinScore,
    ),
    minCandidateScore: RoutingScoreSchema(
      DEFAULT_ROUTING.thresholds.minCandidateScore,
    ),
  })
  .strict()
  .default(DEFAULT_ROUTING.thresholds)
  .superRefine((thresholds, context) => {
    const { directRouteMinScore, minCandidateScore } = thresholds;
    if (minCandidateScore > directRouteMinScore) {
      context.addIssue({
        code: "custom",
        path: ["minCandidateScore"],
        message:
          "minCandidateScore must be less than or equal to directRouteMinScore",
      });
    }
  });

const RoutingSchema = z
  .object({
    thresholds: RoutingThresholdsSchema.optional().default(
      DEFAULT_ROUTING.thresholds,
    ),
    classifier: ClassifierSchema.optional().default(DEFAULT_CLASSIFIER),
  })
  .strict();

function resolveRoutingConfig(raw: unknown): ResolvedRoutingConfig {
  const routing =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).routing
      : undefined;
  return RoutingSchema.parse(routing === undefined ? {} : routing);
}

const SkillSearchSchema = z
  .object({
    collectionWeights: z
      .object({
        meta: z
          .number()
          .positive()
          .default(DEFAULT_SKILL_SEARCH.collectionWeights.meta),
        body: z
          .number()
          .positive()
          .default(DEFAULT_SKILL_SEARCH.collectionWeights.body),
        references: z
          .number()
          .positive()
          .default(DEFAULT_SKILL_SEARCH.collectionWeights.references),
      })
      .default(DEFAULT_SKILL_SEARCH.collectionWeights),
  })
  .default(DEFAULT_SKILL_SEARCH);

const SkillsSchema = z
  .object({
    search: SkillSearchSchema.optional().default(DEFAULT_SKILL_SEARCH),
  })
  .default(DEFAULT_SKILLS);

function resolveSkillsConfig(raw: unknown): ResolvedSkillsConfig {
  const skills =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).skills
      : undefined;
  return SkillsSchema.parse(skills === undefined ? {} : skills);
}

const enabledSchema = z.boolean().catch(true);
const ReviewSchema = z
  .object({
    enabled: z.boolean().catch(false),
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    timeoutSeconds: boundedInt(300, 60, 1_800),
    keywordCoverage: z
      .object({ everyAcceptedTurns: boundedInt(50, 10, 1_000) })
      .catch(DEFAULT_REVIEW.keywordCoverage),
    triggers: z
      .object({
        skillCandidate: z
          .object({
            enabled: enabledSchema,
            toolCalls: boundedInt(5, 1, 100),
          })
          .catch(DEFAULT_REVIEW.triggers.skillCandidate),
        skillPlacement: z
          .object({ enabled: enabledSchema })
          .catch(DEFAULT_REVIEW.triggers.skillPlacement),
        processGap: z
          .object({
            enabled: enabledSchema,
            toolFailures: boundedInt(2, 1, 100),
          })
          .catch(DEFAULT_REVIEW.triggers.processGap),
        successfulPattern: z
          .object({
            enabled: enabledSchema,
            toolCalls: boundedInt(5, 1, 100),
          })
          .catch(DEFAULT_REVIEW.triggers.successfulPattern),
        satisfactionCheck: z
          .object({
            enabled: enabledSchema,
            everyTurns: boundedInt(10, 1, 1000),
          })
          .catch(DEFAULT_REVIEW.triggers.satisfactionCheck),
        missingIntent: z
          .object({ enabled: enabledSchema })
          .catch(DEFAULT_REVIEW.triggers.missingIntent),
        weakIntent: z
          .object({
            enabled: enabledSchema,
            confidenceBelow: z
              .number()
              .catch(0.5)
              .transform((value) => Math.max(0, Math.min(1, value))),
          })
          .catch(DEFAULT_REVIEW.triggers.weakIntent),
        behaviorFix: z
          .object({ enabled: enabledSchema })
          .catch(DEFAULT_REVIEW.triggers.behaviorFix),
        entityContext: z
          .object({ enabled: enabledSchema })
          .catch(DEFAULT_REVIEW.triggers.entityContext),
      })
      .catch(DEFAULT_REVIEW.triggers),
  })
  .catch(DEFAULT_REVIEW)
  .transform((val): ResolvedReviewConfig => ({
    enabled: val.enabled,
    model: val.model ?? undefined,
    modelFallback: val.modelFallback ?? undefined,
    thinking: val.thinking,
    timeoutSeconds: val.timeoutSeconds,
    keywordCoverage: val.keywordCoverage,
    triggers: val.triggers,
  }));

const QmdEndpointObjectSchema = z.object({
  baseUrl: z.string().trim().catch(""),
  model: z.string().trim().catch(""),
  apiKey: z.string().trim().optional().catch(undefined),
});
const QmdEndpointSchema = QmdEndpointObjectSchema.catch({
  baseUrl: "",
  model: "",
});
const QmdEmbeddingSchema = QmdEndpointObjectSchema.extend({
  dimension: z.number().int().positive().default(1536).catch(1536),
}).catch({ baseUrl: "", model: "", dimension: 1536 });

const QmdSchema = z
  .object({
    timeoutMs: z.number().optional().catch(undefined),
    indexRefreshIntervalSeconds: boundedInt(300, 0, 86_400),
    embedding: QmdEmbeddingSchema,
    expansion: QmdEndpointSchema,
  })
  .catch(DEFAULT_QMD);

const SkillHarnessConfigSchema = z
  .object({
    scope: ScopeSchema.optional().default(DEFAULT_SCOPE),
    routing: z.unknown().optional(),
    skills: z.unknown().optional(),
    qmd: QmdSchema,
    review: ReviewSchema.optional().default(DEFAULT_REVIEW),
  })
  .catch({
    scope: DEFAULT_SCOPE,
    routing: DEFAULT_ROUTING,
    skills: DEFAULT_SKILLS,
    qmd: DEFAULT_QMD,
    review: DEFAULT_REVIEW,
  });

export function resolveConfig(
  raw: unknown,
  options?: { openClawConfig?: OpenClawConfig; env?: NodeJS.ProcessEnv },
): ResolvedSkillHarnessPluginConfig {
  const resolved = SkillHarnessConfigSchema.parse(raw);
  const resolvedRouting = resolveRoutingConfig(raw);
  const resolvedSkills = resolveSkillsConfig(raw);

  const resolvedEmbedding = resolveQmdEndpoint(resolved.qmd.embedding, {
    ...options,
    defaultDimension: 1536,
  });
  const resolvedExpansion = resolveQmdEndpoint(resolved.qmd.expansion, options);

  const timeoutMs = clampInt(
    resolved.qmd.timeoutMs,
    resolvedRouting.classifier.timeoutMs,
    1_000,
    60_000,
  );

  return {
    scope: resolved.scope,
    routing: resolvedRouting,
    skills: resolvedSkills,
    qmd: {
      timeoutMs,
      indexRefreshIntervalSeconds: clampInt(
        resolved.qmd.indexRefreshIntervalSeconds,
        300,
        0,
        86_400,
      ),
      embedding: {
        ...resolved.qmd.embedding,
        ...resolvedEmbedding,
        dimension:
          resolvedEmbedding.dimension ??
          resolved.qmd.embedding.dimension ??
          1536,
      },
      expansion: {
        ...resolved.qmd.expansion,
        ...resolvedExpansion,
      },
    },
    review: resolved.review,
  };
}
