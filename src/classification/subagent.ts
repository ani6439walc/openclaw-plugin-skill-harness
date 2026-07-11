import crypto from "node:crypto";
import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { FALLBACK_INTENT_ID } from "../constants.js";
import {
  buildIntentInstructionPrompt,
  buildIntentionPrompt,
  buildTopicSwitchPrompt,
  parseIntentionResult,
  parseTopicSwitchResult,
  type TopicSwitchResult,
} from "./prompts.js";
import { resolveCanonicalSessionKeyFromSessionId } from "../session/index.js";
import {
  buildEmbeddedSubagentRunDefaults,
  extractEmbeddedRunError,
  formatEmbeddedError,
} from "../subagent-runtime.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentionResult,
  AvailableSkill,
  RecentTurn,
  ResolvedSkillHarnessPluginConfig,
} from "../types.js";

export type EmbeddedSubagentBaseParams = {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  modelRef: { provider: string; model: string };
};

function createSubagentSessionIdentity(
  params: Pick<
    EmbeddedSubagentBaseParams,
    "api" | "agentId" | "sessionId" | "sessionKey"
  >,
  options: { runPrefix: string; keyPrefix: string; hashInput: string },
): { subagentSessionId: string; subagentSessionKey: string } {
  const subagentSessionId = `${options.runPrefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const parentSessionKey =
    params.sessionKey ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const subagentScope =
    parentSessionKey ?? params.sessionId ?? crypto.randomUUID();
  const subagentSuffix = `${options.keyPrefix}:${crypto.createHash("sha1").update(`${subagentScope}:${options.hashInput}`).digest("hex").slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;

  return { subagentSessionId, subagentSessionKey };
}

export function extractPayloadText(result: { payloads?: unknown[] }): string {
  return ((result.payloads ?? []) as { text?: string }[])
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export interface IntentInstructionSubagentResult {
  text?: string;
  error?: string;
}

const INSTRUCTION_SKILL_TOOL_NAMES = ["skill_view"];

type ModelRef = { provider: string; model: string };

function resolveFirstModelRef(
  refs: readonly (string | undefined)[],
): ModelRef | undefined {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      const parsed = parseModelRef(ref, DEFAULT_PROVIDER);
      if (parsed) return { provider: parsed.provider, model: parsed.model };
    } catch (err) {
      logger.debug("skipping invalid model ref", { error: err, modelRef: ref });
    }
  }
  return;
}

function resolveModelRefChain(
  api: OpenClawPluginApi,
  agentId: string,
  beforeAgent: readonly (string | undefined)[],
  afterAgent: readonly (string | undefined)[] = [],
): ModelRef | undefined {
  const beforeAgentModel = resolveFirstModelRef(beforeAgent);
  if (beforeAgentModel) return beforeAgentModel;

  const agentModelRef = resolveAgentEffectiveModelPrimary(api.config, agentId);
  return resolveFirstModelRef([agentModelRef, ...afterAgent]);
}

export function getModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedSkillHarnessPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): ModelRef | undefined {
  const currentModelRef =
    currentRun.modelProviderId && currentRun.modelId
      ? `${currentRun.modelProviderId}/${currentRun.modelId}`
      : undefined;
  return resolveModelRefChain(
    api,
    agentId,
    [config.model, currentModelRef],
    [config.modelFallback],
  );
}

export function getReviewModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedSkillHarnessPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): ModelRef | undefined {
  const currentModelRef =
    currentRun.modelProviderId && currentRun.modelId
      ? `${currentRun.modelProviderId}/${currentRun.modelId}`
      : undefined;
  return resolveModelRefChain(
    api,
    agentId,
    [config.review.model ?? config.model, currentModelRef],
    [config.review.modelFallback ?? config.modelFallback],
  );
}

export function getInstructionModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedSkillHarnessPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): { provider: string; model: string } | undefined {
  return getModelRef(
    api,
    agentId,
    {
      ...config,
      model: config.instruction.model ?? config.model,
      modelFallback: config.instruction.modelFallback ?? config.modelFallback,
    },
    currentRun,
  );
}

export async function runIntentionSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  conversation?: RecentTurn[];
  latest: string;
  messageProvider?: string;
  channelId?: string;
  modelRef: { provider: string; model: string };
  intents: readonly IntentCatalogEntry[];
  topicContext?: TopicSwitchResult;
}): Promise<IntentionResult | undefined> {
  const { subagentSessionId, subagentSessionKey } =
    createSubagentSessionIdentity(params, {
      runPrefix: "skill-harness",
      keyPrefix: "skill-harness",
      hashInput: params.latest,
    });

  const prompt = buildIntentionPrompt({
    conversation: params.conversation,
    latest: params.latest,
    intents: params.intents,
    topicContext: params.topicContext,
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
      await params.api.runtime.agent.runEmbeddedAgent(embeddedRunParams);

    const rawReply = extractPayloadText(result);

    const validIds = [...params.intents.map((i) => i.id), FALLBACK_INTENT_ID];

    const parsed = parseIntentionResult(
      rawReply,
      validIds,
      params.topicContext,
    );
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

export async function runTopicSwitchSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  conversation?: RecentTurn[];
  latest: string;
  domains: readonly string[];
  history: readonly HistoricalIntentRecord[];
  messageProvider?: string;
  modelRef: { provider: string; model: string };
}): Promise<TopicSwitchResult | undefined> {
  const { subagentSessionId, subagentSessionKey } =
    createSubagentSessionIdentity(params, {
      runPrefix: "skill-harness",
      keyPrefix: "skill-harness",
      hashInput: params.latest,
    });

  const prompt = buildTopicSwitchPrompt({
    latest: params.latest,
    history: params.history,
    domains: params.domains,
    conversation: params.conversation,
    currentTime: resolveCurrentTime(params.api),
  });

  try {
    const result = await params.api.runtime.agent.runEmbeddedAgent(
      buildIntentionEmbeddedRunParams({
        params,
        subagentSessionId,
        subagentSessionKey,
        prompt,
      }),
    );
    const rawReply = extractPayloadText(result);
    const parsed = parseTopicSwitchResult(rawReply, {
      domains: params.domains,
    });
    if (!parsed) {
      logger.warn("Topic switch result parse failed", { rawReply });
    }
    return parsed;
  } catch (err) {
    logger.warn("Topic switch subagent error", { error: err });
    return;
  }
}

export async function runIntentInstructionSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  conversation?: RecentTurn[];
  latest: string;
  result: IntentionResult;
  intentBody: string;
  availableSkills?: AvailableSkill[];
  messageProvider?: string;
  modelRef: { provider: string; model: string };
}): Promise<IntentInstructionSubagentResult> {
  const { subagentSessionId, subagentSessionKey } =
    createSubagentSessionIdentity(params, {
      runPrefix: "skill-harness",
      keyPrefix: "skill-harness",
      hashInput: `${params.latest}:${params.result.intent}`,
    });

  const prompt = buildIntentInstructionPrompt({
    latest: params.latest,
    result: params.result,
    intentBody: params.intentBody,
    availableSkills: params.availableSkills,
    complexityContext:
      params.config.complexityPrompts[params.result.complexity],
    conversation: params.conversation,
    currentTime: resolveCurrentTime(params.api),
  });

  try {
    const result = await params.api.runtime.agent.runEmbeddedAgent({
      ...buildIntentionEmbeddedRunParams({
        params,
        subagentSessionId,
        subagentSessionKey,
        prompt,
      }),
      timeoutMs: params.config.instruction.timeoutMs,
      thinkLevel: params.config.instruction.thinking,
      modelRun: false,
      promptMode: "minimal",
      toolsAllow: INSTRUCTION_SKILL_TOOL_NAMES,
      disableTools: false,
    });
    const embeddedError = extractEmbeddedRunError(result);
    if (embeddedError) {
      logger.warn("Intent instruction subagent returned an error", {
        error: embeddedError,
        intent: params.result.intent,
      });
      return { error: embeddedError };
    }

    const rawReply = extractPayloadText(result);
    const instruction = rawReply
      .replace(/^```(?:markdown|md|text)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    if (!instruction) {
      logger.warn("Intent instruction result was empty", {
        intent: params.result.intent,
      });
      return { error: "instruction writer produced no text" };
    }
    return { text: instruction };
  } catch (err) {
    logger.warn("Intent instruction subagent error", { error: err });
    return { error: formatEmbeddedError(err) ?? "instruction writer threw" };
  }
}

export function buildIntentionEmbeddedRunParams(params: {
  params: EmbeddedSubagentBaseParams;
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
    ...buildEmbeddedSubagentRunDefaults(),
    modelRun: true,
    promptMode: "none" as const,
    toolsAllow: [],
    disableTools: true,
    thinkLevel: params.params.config.thinking,
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
    timeZoneName: "shortOffset",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const offsetStr = get("timeZoneName") || "GMT+0";

  return `[${dayOfWeek} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${offsetStr}]`;
}
