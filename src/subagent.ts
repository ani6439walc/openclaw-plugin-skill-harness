import crypto from "node:crypto";
import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  UNTRUSTED_CONTEXT_HEADER,
  FALLBACK_INTENT,
  INTENTION_HINT_PLUGIN_TAG,
} from "./constants.js";
import { resolveCanonicalSessionKeyFromSessionId } from "./session.js";
import type {
  IntentDefinition,
  IntentionResult,
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
    } catch {
      // skip invalid refs
    }
  }
  const agentModelRef = resolveAgentEffectiveModelPrimary(api.config, agentId);
  if (agentModelRef) {
    try {
      const parsed = parseModelRef(agentModelRef, DEFAULT_PROVIDER);
      if (parsed) return { provider: parsed.provider, model: parsed.model };
    } catch {
      // skip invalid refs
    }
  }
  return undefined;
}

export function buildIntentionPrompt(params: {
  query: string;
  intents: IntentDefinition[];
}): string {
  const enabledIntents = params.intents.filter((i) => i.enabled);
  const allIntents = [...enabledIntents, FALLBACK_INTENT];

  const intentDescriptions = allIntents
    .map((intent) => {
      const lines = [`<INTENT>`, `id: ${intent.id}`, `name: ${intent.name}`];
      if (intent.triggers.length > 0) {
        lines.push(`triggers:`);
        lines.push(...intent.triggers.map((t) => `- ${t}`));
      }
      if (intent.examples.length > 0) {
        lines.push(`examples:`);
        lines.push(...intent.examples.map((ex) => `- ${ex}`));
      }
      lines.push(`</INTENT>`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `You are an intention classification agent.
Another model is preparing the final user-facing answer.
Your job is to analyze the user's intent and return a structured hint.
Do not answer the user directly.

IMPORTANT CLASSIFICATION RULES:
1. Use the conversation history to understand the latest message in context — pronouns, implicit references, and topic continuations all depend on prior turns.
2. If the latest message is a follow-up to an ongoing topic (e.g., discussing design then asking to create a related file), classify based on the OVERALL conversational goal, not just the surface action.
3. When in doubt, prefer the intent that best explains WHY the user said this given what came before.
4. DO NOT FORCE a classification. If you are not highly confident in any single intent, default to OTHER. A correct "other" is better than a wrong specific label.

CONFIDENCE & COMPLEXITY CLASSIFICATION:
- confidence: "high" — clear intent match, unambiguous language, obvious topic
- confidence: "medium" — reasonably clear but some ambiguity or mixed signals
- confidence: "low" — ambiguous, unclear, or multiple conflicting intents possible
- complexity: "simple" — single-step, well-defined, trivial (Trivial + Explicit in OmO terms)
- complexity: "moderate" — some investigation needed, bounded scope (Exploratory in OmO terms)
- complexity: "complex" — open-ended, multi-step, ambiguous scope, needs clarification (Open-ended + Ambiguous in OmO terms)

Return exactly in this format (one key per line, with NO markdown code blocks or xml tags):
intent: <id> (<name>)
reason: <brief reason for classification>
goal: <what the user likely wants to achieve>
suggestion: <optional correction or recommendation>
confidence: <low | medium | high — how certain you are about the classification>
complexity: <simple | moderate | complex — how complex the task is>

FALLBACK:
If none of the provided intents confidently fit, return:
intent: ${FALLBACK_INTENT.id} (${FALLBACK_INTENT.name})
reason: <brief reason for classification>
goal: <what the user likely wants to achieve>
suggestion: <optional correction or recommendation>

Classify the LATEST USER MESSAGE into ONE of these categories:
${intentDescriptions}

CONVERSATIONS:
${params.query}
`;
}

export function parseIntentionResult(
  raw: string,
  validIntentIds: string[],
): IntentionResult | undefined {
  const cleaned = raw.replace(/<\/?output_format>/gi, "").trim();
  const lines = cleaned.split(/\r?\n/);
  const result: Partial<IntentionResult> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key === "intent") {
      const match = value.match(/^([a-z0-9_-]+)/i);
      result.intent = match ? match[1] : value;
    } else if (key === "reason") {
      result.reason = value || undefined;
    } else if (key === "goal") {
      result.goal = value || undefined;
    } else if (key === "suggestion") {
      if (value) result.suggestion = value;
    } else if (key === "confidence") {
      const normalized = value.trim().toLowerCase();
      if (["low", "medium", "high"].includes(normalized)) {
        result.confidence = normalized;
      }
    } else if (key === "complexity") {
      const normalized = value.trim().toLowerCase();
      if (["simple", "moderate", "complex"].includes(normalized)) {
        result.complexity = normalized;
      }
    }
  }

  let intent = result.intent ?? FALLBACK_INTENT.id;
  // Case-insensitive OTHER check
  const isOther =
    intent.toUpperCase() === FALLBACK_INTENT.id &&
    validIntentIds.some((id) => id.toUpperCase() === FALLBACK_INTENT.id);
  if (!validIntentIds.includes(intent) && !isOther) {
    intent = FALLBACK_INTENT.id;
  }

  if (!result.reason || !result.goal) {
    return undefined;
  }

  return {
    intent,
    reason: result.reason!,
    goal: result.goal!,
    ...(result.suggestion ? { suggestion: result.suggestion } : {}),
    ...(result.confidence ? { confidence: result.confidence } : {}),
    ...(result.complexity ? { complexity: result.complexity } : {}),
  };
}

export function buildPromptPrefix(
  result: IntentionResult,
  intents: IntentDefinition[],
): string | undefined {
  const intentDef = intents.find((i) => i.id === result.intent && i.enabled);
  const effectiveDef = intentDef ?? FALLBACK_INTENT;

  const lines: string[] = [];
  lines.push(`reason: ${result.reason}`);
  lines.push(`goal: ${result.goal}`);
  if (result.suggestion) lines.push(`suggestion: ${result.suggestion}`);
  lines.push(`confidence: ${result.confidence ?? "medium"}`);
  lines.push(`complexity: ${result.complexity ?? "moderate"}`);
  lines.push("");
  lines.push(effectiveDef.prompt);

  return `${UNTRUSTED_CONTEXT_HEADER}
<${INTENTION_HINT_PLUGIN_TAG}>
${lines.join("\n")}
</${INTENTION_HINT_PLUGIN_TAG}>`;
}

export async function runIntentionSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedIntentionHintPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  query: string;
  messageProvider?: string;
  channelId?: string;
  modelRef: { provider: string; model: string };
  intents: IntentDefinition[];
}): Promise<IntentionResult> {
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
  const subagentSuffix = `intention-hint:${crypto.createHash("sha1").update(`${subagentScope}:${params.query}`).digest("hex").slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;

  const prompt = buildIntentionPrompt({
    query: params.query,
    intents: params.intents,
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

    const validIds = params.intents.map((i) => i.id);

    return (
      parseIntentionResult(rawReply, validIds) || {
        intent: FALLBACK_INTENT.id,
        reason: "Parse failed",
        goal: "Fallback",
        confidence: "low",
        complexity: "complex",
      }
    );
  } catch {
    return {
      intent: FALLBACK_INTENT.id,
      reason: "Subagent error",
      goal: "Fallback",
      confidence: "low",
      complexity: "complex",
    };
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
    sessionFile: "/tmp/session.jsonl",
    trigger: "manual" as const,
    modelRun: true,
    promptMode: "none" as const,
    toolsAllow: [],
    disableTools: true,
    disableMessageTool: true,
    allowGatewaySubagentBinding: true,
    bootstrapContextMode: "lightweight" as const,
    verboseLevel: "off" as const,
    thinkLevel: "off" as const,
    reasoningLevel: "off" as const,
    silentExpected: true,
    authProfileFailurePolicy: "local" as const,
    cleanupBundleMcpOnRunEnd: true,
  };
}
