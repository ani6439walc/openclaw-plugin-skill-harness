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
  ResolvedQmdConfig,
  ResolvedRoutingConfig,
  ResolvedSkillHarnessPluginConfig,
  ResolvedSkillSearchConfig,
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

const DEFAULT_CURATION = {
  enabled: true,
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  timeoutSeconds: 30,
} as const;

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

const DEFAULT_SKILL_SEARCH: ResolvedSkillSearchConfig = {
  collectionWeights: { meta: 1, body: 1, references: 1 },
};

const DEFAULT_QMD: ResolvedQmdConfig = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  indexRefreshIntervalSeconds: 300,
  embedding: { baseUrl: "", model: "" },
  expansion: { baseUrl: "", model: "" },
  skillSearch: DEFAULT_SKILL_SEARCH,
};

const DEFAULT_ROUTING: ResolvedRoutingConfig = {
  sameTopic: { minConfidence: 0.8 },
  qmd: {
    minTopicConfidence: 0.8,
    directRouteMinScore: 0.85,
    smallCandidateMinScore: 0.65,
    minCandidateScore: 0.35,
  },
};

const DEFAULT_CONFIG = {
  agents: ["main"],
  model: undefined,
  modelFallback: undefined,
  thinking: "medium",
  lowEffortRoutingMode: "fastpath-only",
  allowedChatTypes: ["direct"],
  allowedChatIds: [],
  deniedChatIds: [],
  queryMode: DEFAULT_QUERY_MODE,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  qmd: DEFAULT_QMD,
  routing: DEFAULT_ROUTING,
  curation: DEFAULT_CURATION,
  review: DEFAULT_REVIEW,
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

const enabledSchema = z.boolean().catch(true);
const ThinkLevelSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])
  .catch("medium");
const LowEffortRoutingModeSchema = z
  .enum(["fastpath-only", "full", "off"])
  .catch("fastpath-only");
const CurationSchema = z
  .object({
    enabled: z.boolean().catch(true),
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    timeoutSeconds: boundedInt(30, 10, 600),
  })
  .catch(DEFAULT_CURATION);
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
  .catch(DEFAULT_REVIEW);

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
  dimension: z.number().int().positive().optional().catch(undefined),
}).catch({ baseUrl: "", model: "" });
const QmdSchema = z
  .object({
    timeoutMs: z.number().optional().catch(undefined),
    indexRefreshIntervalSeconds: boundedInt(300, 0, 86_400),
    embedding: QmdEmbeddingSchema,
    expansion: QmdEndpointSchema,
    skillSearch: z.unknown().optional(),
  })
  .catch(DEFAULT_QMD);

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

function resolveSkillSearchConfig(raw: unknown): ResolvedSkillSearchConfig {
  const qmd =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).qmd
      : undefined;
  const skillSearch =
    qmd && typeof qmd === "object" && !Array.isArray(qmd)
      ? (qmd as Record<string, unknown>).skillSearch
      : undefined;
  return SkillSearchSchema.parse(skillSearch === undefined ? {} : skillSearch);
}

const RoutingScoreSchema = (fallback: number) =>
  z.number().min(0).max(1).optional().default(fallback);
const RoutingSchema = z
  .object({
    sameTopic: z
      .object({
        minConfidence: RoutingScoreSchema(
          DEFAULT_ROUTING.sameTopic.minConfidence,
        ),
      })
      .strict()
      .optional()
      .default(DEFAULT_ROUTING.sameTopic),
    qmd: z
      .object({
        minTopicConfidence: RoutingScoreSchema(
          DEFAULT_ROUTING.qmd.minTopicConfidence,
        ),
        directRouteMinScore: RoutingScoreSchema(
          DEFAULT_ROUTING.qmd.directRouteMinScore,
        ),
        smallCandidateMinScore: RoutingScoreSchema(
          DEFAULT_ROUTING.qmd.smallCandidateMinScore,
        ),
        minCandidateScore: RoutingScoreSchema(
          DEFAULT_ROUTING.qmd.minCandidateScore,
        ),
      })
      .strict()
      .optional()
      .default(DEFAULT_ROUTING.qmd),
  })
  .strict()
  .superRefine((routing, context) => {
    const { directRouteMinScore, smallCandidateMinScore, minCandidateScore } =
      routing.qmd;
    if (
      minCandidateScore > smallCandidateMinScore ||
      smallCandidateMinScore > directRouteMinScore
    ) {
      context.addIssue({
        code: "custom",
        path: ["qmd"],
        message:
          "minCandidateScore must be less than or equal to smallCandidateMinScore, which must be less than or equal to directRouteMinScore",
      });
    }
  });

function resolveRoutingConfig(raw: unknown): ResolvedRoutingConfig {
  const routing =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).routing
      : undefined;
  return RoutingSchema.parse(routing === undefined ? {} : routing);
}

const SkillHarnessConfigSchema = z
  .object({
    agents: stringListWithDefault(["main"]),
    model: z.string().optional().catch(undefined),
    modelFallback: z.string().optional().catch(undefined),
    thinking: ThinkLevelSchema,
    lowEffortRoutingMode: LowEffortRoutingModeSchema,
    allowedChatTypes: stringListWithDefault(["direct"]),
    allowedChatIds: StringListSchema,
    deniedChatIds: StringListSchema,
    queryMode: z.enum(["message", "recent", "full"]).catch(DEFAULT_QUERY_MODE),
    contextWindow: ContextWindowSchema,
    timeoutMs: boundedInt(DEFAULT_TIMEOUT_MS, 1_000, 60_000),
    qmd: QmdSchema,
    routing: z.unknown().optional(),
    curation: CurationSchema,
    review: ReviewSchema,
  })
  .catch(DEFAULT_CONFIG);

export function resolveConfig(raw: unknown): ResolvedSkillHarnessPluginConfig {
  const resolved = SkillHarnessConfigSchema.parse(raw) as Omit<
    ResolvedSkillHarnessPluginConfig,
    "qmd" | "routing"
  > & {
    qmd: Omit<ResolvedQmdConfig, "timeoutMs" | "indexRefreshIntervalSeconds" | "skillSearch"> & {
      timeoutMs?: number;
      indexRefreshIntervalSeconds?: number;
      skillSearch?: unknown;
    };
  };
  return {
    ...resolved,
    qmd: {
      ...resolved.qmd,
      timeoutMs: clampInt(
        resolved.qmd.timeoutMs,
        resolved.timeoutMs,
        1_000,
        60_000,
      ),
      indexRefreshIntervalSeconds: clampInt(
        resolved.qmd.indexRefreshIntervalSeconds,
        300,
        0,
        86_400,
      ),
      skillSearch: resolveSkillSearchConfig(raw),
    },
    routing: resolveRoutingConfig(raw),
  };
}
