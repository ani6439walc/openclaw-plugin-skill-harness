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
  conversation?: RecentTurn[];
  latest: string;
  intents: readonly IntentDefinition[];
}): string {
  const enabledIntents = params.intents.filter((i) => i.enabled);
  const allIntents = [...enabledIntents, FALLBACK_INTENT];

  const intentCatalog = allIntents
    .map((intent) => {
      const lines = [`<intent id="${intent.id}" name="${intent.name}">`];
      if (intent.triggers.length > 0) {
        lines.push(`triggers:`);
        lines.push(...intent.triggers.map((t) => `- ${t}`));
      }
      if (intent.examples.length > 0) {
        lines.push(`examples:`);
        lines.push(...intent.examples.map((ex) => `- ${ex}`));
      }
      lines.push(`</intent>`);
      return lines.join("\n");
    })
    .join("\n");

  const conversationXml =
    params.conversation && params.conversation.length > 0
      ? params.conversation
          .map((turn) => `<turn role="${turn.role}">${turn.text}</turn>`)
          .join("\n")
      : "";

  return `<input_context>
Three input types are provided:
1. conversation: Recent conversation turns between user and assistant
2. latest: The latest user message to classify
3. intents: Available intent definitions with triggers and examples
</input_context>

<classification_rules>
1. Use conversation history to understand context
2. Classify based on overall conversational goal
3. Prefer intent that explains WHY user said this
4. DO NOT FORCE classification - default to OTHER (Fallback) if uncertain
5. Memory intents: classify first if triggers match
</classification_rules>

<output_format>
Return only defined fields, one per line:
<field_definitions>
intent: <id> (<name>)
reason: <brief reason>
goal: <what user wants>
suggestion: <optional correction — omit if empty>
confidence: <0.0-1.0>
complexity: <low|medium|high>
</field_definitions>

Score definitions:
- confidence: 0.0-1.0 numerical scale
- complexity: low (simple), medium (moderate), high (complex)

Fallback:
If none of the provided intents confidently fit, return:
intent: ${FALLBACK_INTENT.id} (${FALLBACK_INTENT.name})
reason: Unable to confidently classify
goal: <what the user likely wants to achieve>
</output_format>

<intent_catalog>
${intentCatalog}
</intent_catalog>

<input>
<conversation>
${conversationXml}
</conversation>
<latest>
${params.latest}
</latest>
</input>`;
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
      if (value) result.suggestion = value || undefined;
    } else if (key === "confidence") {
      // Expecting 0.0-1.0 numerical scale per prompt definition
      const num = parseFloat(value);
      if (!isNaN(num) && num >= 0 && num <= 1) {
        result.confidence = num.toString();
      }
    } else if (key === "complexity") {
      // Expecting low|medium|high per prompt definition
      const normalized = value.trim().toLowerCase();
      if (["low", "medium", "high"].includes(normalized)) {
        result.complexity = normalized;
      }
    }
  }

  let intent = result.intent ?? FALLBACK_INTENT.id;

  // Find case-insensitive match in validIntentIds
  const caseInsensitiveMatch = validIntentIds.find(
    (id) => id.toLowerCase() === intent.toLowerCase(),
  );
  if (caseInsensitiveMatch) {
    intent = caseInsensitiveMatch;
  } else if (!validIntentIds.includes(intent)) {
    // Fallback: look for "other" case-insensitively, otherwise use first valid intent
    const otherMatch = validIntentIds.find(
      (id) => id.toLowerCase() === FALLBACK_INTENT.id.toLowerCase(),
    );
    intent = otherMatch ?? validIntentIds[0] ?? FALLBACK_INTENT.id;
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
  intents: readonly IntentDefinition[],
): string | undefined {
  const intentDef = intents.find((i) => i.id === result.intent && i.enabled);
  const effectiveDef = intentDef ?? FALLBACK_INTENT;

  const lines: string[] = [];
  lines.push(`reason: ${result.reason}`);
  lines.push(`goal: ${result.goal}`);
  if (result.suggestion) lines.push(`suggestion: ${result.suggestion}`);
  lines.push(`confidence: ${result.confidence ?? "0.5"}`);
  lines.push(`complexity: ${result.complexity ?? "medium"}`);
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
  conversation?: RecentTurn[];
  latest: string;
  messageProvider?: string;
  channelId?: string;
  modelRef: { provider: string; model: string };
  intents: readonly IntentDefinition[];
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
  const subagentSuffix = `intention-hint:${crypto.createHash("sha1").update(`${subagentScope}:${params.latest}`).digest("hex").slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;

  const prompt = buildIntentionPrompt({
    conversation: params.conversation,
    latest: params.latest,
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
      }
    );
  } catch {
    return {
      intent: FALLBACK_INTENT.id,
      reason: "Subagent error",
      goal: "Fallback",
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
