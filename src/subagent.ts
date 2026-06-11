import crypto from "node:crypto";
import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import { FALLBACK_INTENT } from "./constants.js";
import { buildIntentionPrompt, parseIntentionResult } from "./prompt.js";
import { resolveCanonicalSessionKeyFromSessionId } from "./session.js";
import type {
  IntentDefinition,
  IntentionResult,
  RecentTurn,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";

export function getModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedIntentionHintPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): { provider: string; model: string } | undefined {
  const candidates: (string | undefined)[] = [
    config.model,
    config.modelFallback,
    currentRun.modelProviderId && currentRun.modelId
      ? `${currentRun.modelProviderId}/${currentRun.modelId}`
      : undefined,
  ];
  for (const ref of candidates) {
    if (!ref) continue;
    try {
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER);
      if (parsed) return { provider: parsed.provider, model: parsed.model };
    } catch (err) {
      logger.debug("skipping invalid model ref", { error: err });
    }
  }
  const agentModelRef = resolveAgentEffectiveModelPrimary(api.config, agentId);
  if (agentModelRef) {
    try {
      const parsed = parseModelRef(agentModelRef, DEFAULT_PROVIDER);
      if (parsed) return { provider: parsed.provider, model: parsed.model };
    } catch (err) {
      logger.debug("skipping invalid agent model ref", {
        error: err,
        agentModelRef,
      });
    }
  }
  return;
}

export function getReviewModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedIntentionHintPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): { provider: string; model: string } | undefined {
  return getModelRef(
    api,
    agentId,
    {
      ...config,
      model: config.selfEvolution.reviewModel ?? config.model,
      modelFallback:
        config.selfEvolution.reviewModelFallback ?? config.modelFallback,
    },
    currentRun,
  );
}

export async function runIntentionSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedIntentionHintPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  conversation?: RecentTurn[];
  latest: string;
  messageProvider?: string;
  channelId?: string;
  modelRef: { provider: string; model: string };
  intents: readonly IntentDefinition[];
}): Promise<IntentionResult | undefined> {
  const subagentSessionId = `intention-hint-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const parentSessionKey =
    params.sessionKey ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const subagentScope =
    parentSessionKey ?? params.sessionId ?? crypto.randomUUID();
  const subagentSuffix = `intention-hint:${crypto.createHash("sha1").update(`${subagentScope}:${params.latest}`).digest("hex").slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;

  const prompt = buildIntentionPrompt({
    conversation: params.conversation,
    latest: params.latest,
    intents: params.intents,
    currentTime: resolveCurrentTime(params.api),
  });
  const embeddedRunParams = buildIntentionEmbeddedRunParams({
    params,
    subagentSessionId,
    subagentSessionKey,
    prompt,
  });

  try {
    const result =
      await params.api.runtime.agent.runEmbeddedPiAgent(embeddedRunParams);

    const rawReply = ((result.payloads ?? []) as { text?: string }[])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    const validIds = [...params.intents.map((i) => i.id), FALLBACK_INTENT.id];

    const parsed = parseIntentionResult(rawReply, validIds);
    if (!parsed) {
      logger.warn("Intention result parse failed", {
        rawReply,
        intents: validIds,
      });
    }
    return parsed;
  } catch (err) {
    logger.warn("Intention subagent error", { error: err });
    return;
  }
}

export function buildIntentionEmbeddedRunParams(params: {
  params: {
    api: OpenClawPluginApi;
    config: ResolvedIntentionHintPluginConfig;
    agentId: string;
    messageProvider?: string;
    modelRef: { provider: string; model: string };
  };
  subagentSessionId: string;
  subagentSessionKey: string;
  prompt: string;
}) {
  return {
    sessionId: params.subagentSessionId,
    sessionKey: params.subagentSessionKey,
    agentId: params.params.agentId,
    messageProvider: params.params.messageProvider,
    config: params.params.api.config,
    prompt: params.prompt,
    provider: params.params.modelRef.provider,
    model: params.params.modelRef.model,
    timeoutMs: params.params.config.timeoutMs,
    runId: params.subagentSessionId,
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    sessionFile: `/tmp/${params.subagentSessionId}.session.jsonl`,
    trigger: "manual" as const,
    modelRun: true,
    promptMode: "none" as const,
    toolsAllow: [],
    disableTools: true,
    disableMessageTool: true,
    allowGatewaySubagentBinding: true,
    bootstrapContextMode: "lightweight" as const,
    verboseLevel: "off" as const,
    thinkLevel: "medium" as const,
    reasoningLevel: "off" as const,
    silentExpected: true,
    authProfileFailurePolicy: "local" as const,
    cleanupBundleMcpOnRunEnd: true,
  };
}

function resolveCurrentTime(api: OpenClawPluginApi): string {
  const userTimezone =
    api.runtime.config?.current?.()?.agents?.defaults?.userTimezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";

  const date = new Date();

  const dayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: userTimezone,
    weekday: "short",
  }).format(date);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: userTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const offsetStr = getTimezoneOffset(userTimezone, date);

  return `[${dayOfWeek} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${offsetStr}]`;
}

function getTimezoneOffset(timezone: string, date: Date): string {
  const utcMs = new Date(
    date.toLocaleString("en-US", { timeZone: "UTC" }),
  ).getTime();
  const tzMs = new Date(
    date.toLocaleString("en-US", { timeZone: timezone }),
  ).getTime();
  const diffMinutes = Math.round((tzMs - utcMs) / 60000);
  const sign = diffMinutes >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(diffMinutes) / 60);
  const minutes = Math.abs(diffMinutes) % 60;
  return minutes > 0
    ? `GMT${sign}${hours}:${String(minutes).padStart(2, "0")}`
    : `GMT${sign}${hours}`;
}
