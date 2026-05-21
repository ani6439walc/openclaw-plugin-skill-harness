import {
  DEFAULT_QUERY_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
} from "./constants.js";
import type { ResolvedIntentionHintPluginConfig } from "./types.js";

export function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizePluginConfig(
  raw: unknown,
): ResolvedIntentionHintPluginConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const asStringArray = (v: unknown): string[] => {
    if (Array.isArray(v))
      return v.filter((x): x is string => typeof x === "string");
    if (typeof v === "string") return [v];
    return [];
  };
  const asBool = (v: unknown, fallback: boolean): boolean => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() === "true";
    return fallback;
  };
  const queryMode = (cfg.queryMode ?? DEFAULT_QUERY_MODE) as string;
  return {
    agents: asStringArray(cfg.agents).length
      ? asStringArray(cfg.agents)
      : ["main"],
    model: typeof cfg.model === "string" ? cfg.model : undefined,
    modelFallback:
      typeof cfg.modelFallback === "string" ? cfg.modelFallback : undefined,
    allowedChatTypes: asStringArray(cfg.allowedChatTypes).length
      ? asStringArray(cfg.allowedChatTypes)
      : ["direct"],
    allowedChatIds: asStringArray(cfg.allowedChatIds),
    deniedChatIds: asStringArray(cfg.deniedChatIds),
    queryMode: (["message", "recent", "full"].includes(queryMode)
      ? queryMode
      : DEFAULT_QUERY_MODE) as "message" | "recent" | "full",
    recentUserTurns: clampInt(
      cfg.recentUserTurns as number | undefined,
      DEFAULT_RECENT_USER_TURNS,
      0,
      20,
    ),
    recentAssistantTurns: clampInt(
      cfg.recentAssistantTurns as number | undefined,
      DEFAULT_RECENT_ASSISTANT_TURNS,
      0,
      10,
    ),
    recentUserChars: clampInt(
      cfg.recentUserChars as number | undefined,
      DEFAULT_RECENT_USER_CHARS,
      40,
      1000,
    ),
    recentAssistantChars: clampInt(
      cfg.recentAssistantChars as number | undefined,
      DEFAULT_RECENT_ASSISTANT_CHARS,
      40,
      1000,
    ),
    timeoutMs: clampInt(
      cfg.timeoutMs as number | undefined,
      DEFAULT_TIMEOUT_MS,
      250,
      120_000,
    ),
    intentsDir:
      typeof cfg.intentsDir === "string" ? cfg.intentsDir : "./intents",
    intentsHotReload: asBool(cfg.intentsHotReload, true),
    intentsHotReloadIntervalMs: clampInt(
      cfg.intentsHotReloadIntervalMs as number | undefined,
      5_000,
      1_000,
      300_000,
    ),
  };
}
