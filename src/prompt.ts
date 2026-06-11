import {
  DEFAULT_LOW_COMPLEXITY_PROMPT,
  DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  DEFAULT_HIGH_COMPLEXITY_PROMPT,
  FALLBACK_INTENT,
  INTENTION_HINT_PLUGIN_TAG,
  UNTRUSTED_CONTEXT_HEADER,
} from "./constants.js";
import type {
  IntentDefinition,
  IntentionResult,
  RecentTurn,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";

function getEnabledIntentsWithFallback(
  intents: readonly IntentDefinition[],
): IntentDefinition[] {
  return [...intents.filter((intent) => intent.enabled), FALLBACK_INTENT];
}

function buildIntentCatalog(intents: readonly IntentDefinition[]): string {
  return getEnabledIntentsWithFallback(intents)
    .map((intent) => {
      const lines = [`<intent id="${intent.id}" name="${intent.name}">`];
      if (intent.triggers.length > 0) {
        lines.push(`triggers:`);
        lines.push(...intent.triggers.map((trigger) => `- ${trigger}`));
      }
      if (intent.examples.length > 0) {
        lines.push(`examples:`);
        lines.push(...intent.examples.map((example) => `- ${example}`));
      }
      lines.push(`</intent>`);
      return lines.join("\n");
    })
    .join("\n");
}

function buildIntentCategories(intents: readonly IntentDefinition[]): string {
  const categoryMap = new Map<string, string[]>();
  for (const intent of getEnabledIntentsWithFallback(intents)) {
    const underscoreIndex = intent.id.indexOf("_");
    const prefix =
      underscoreIndex > 0 ? intent.id.slice(0, underscoreIndex) : "OTHER";
    if (!categoryMap.has(prefix)) {
      categoryMap.set(prefix, []);
    }
    categoryMap.get(prefix)!.push(intent.id);
  }

  const categoryLines: string[] = [];
  const standaloneIntents: string[] = [];
  for (const [prefix, ids] of categoryMap) {
    if (ids.length >= 2) {
      categoryLines.push(`- ${prefix}_*: ${ids.join(", ")}`);
    } else {
      standaloneIntents.push(...ids);
    }
  }
  if (standaloneIntents.length > 0) {
    categoryLines.push(`- STANDALONE: ${standaloneIntents.join(", ")}`);
  }

  return categoryLines.length > 0
    ? categoryLines.join("\n")
    : "- No categories with 2+ intents";
}

function buildConversationXml(conversation: RecentTurn[] | undefined): string {
  if (!conversation || conversation.length === 0) return "";

  const turns = conversation
    .map((turn) => {
      const lines = [`<turn role="${turn.role}">`, turn.text];
      if (turn.role === "user" && turn.historicalIntent) {
        lines.push(
          "<historical_intent>",
          JSON.stringify(turn.historicalIntent),
          "</historical_intent>",
        );
      }
      lines.push("</turn>");
      return lines.join("\n");
    })
    .join("\n");
  return `<conversation>\n${turns}\n</conversation>`;
}

export function buildIntentionPrompt(params: {
  conversation?: RecentTurn[];
  latest: string;
  intents: readonly IntentDefinition[];
  currentTime?: string;
}): string {
  const timeLine = params.currentTime ? `${params.currentTime}\n\n` : "";

  const intentCatalog = buildIntentCatalog(params.intents);
  const intentCategories = buildIntentCategories(params.intents);
  const conversationXml = buildConversationXml(params.conversation);
  const conversationSection = conversationXml ? `\n${conversationXml}\n` : "";

  return `${timeLine}You are an intent classification agent.
Another model is preparing the final user-facing answer with hints and subagent routing.
Your job is to analyze conversation context and the user's latest message, then classify which intent best matches.
You receive conversation history, the latest user message, and available intent definitions with triggers and examples.

<classification_rules>
1. Use conversation history and historical_intent annotations to understand context. Treat historical intents and historical goals as evidence, not answers that must be inherited.
2. Classify the latest message based on the user's current goal and prefer the intent that best explains WHY the user said it.
3. **Goal continuity**: If the latest message continues, corrects, refines, or asks to execute a relevant historical goal, prefer its related intent and preserve or refine the relevant historical goal in the new output goal.
4. **Topic switch**: If the latest message introduces an independent topic, a different subject, or a different desired outcome, classify it fresh and replace the output goal with the new goal.
5. **Short messages**: First determine whether the message points to a specific historical goal. Do not inherit the most recent intent merely because the message is short or contains a continuation marker.
6. DO NOT FORCE classification - default to OTHER (Fallback) if uncertain.
7. Validate output: ensure all required JSON fields are present, intent exists in catalog (or OTHER), confidence is 0.0-1.0, complexity is low|medium|high.
</classification_rules>

<output_format>
Return classification as a JSON object. Output MUST be plain JSON only — do NOT wrap in \`\`\`json code blocks.

Required fields:
- "intent": string - Format: "<id> (<name>)" (e.g., "MEMORY_LOOKUP (Memory Lookup)" or "OTHER (Fallback)")
- "reason": string - Brief reason for classification
- "goal": string - What the user wants to achieve
- "confidence": number - 0.0 (guessing) to 1.0 (certain)
- "complexity": string - "low", "medium", or "high"

Optional fields:
- "suggestion": string - Only when confidence < 0.8; provide general guidance

Example output:
{
  "intent": "MEMORY_LOOKUP (Memory Lookup)",
  "reason": "User asked to recall previous conversation topic",
  "goal": "Retrieve memory of past discussion about Python async",
  "confidence": 0.9,
  "complexity": "medium"
}

Complexity levels:
- "low": simple greeting, acknowledgment, straightforward question or task with clear/unambiguous scope requiring direct execution. (narrow or standard scope — no additional investigation needed)
- "medium": task requiring moderate context analysis or broader scope that needs some investigation before execution.
- "high": multi-step investigation, research, complex code operations, or broad scope requiring full SOP workflow and structural changes.

Fallback: If no intent confidently matches, return intent as "OTHER" (Fallback).
</output_format>

<intent_catalog>
Categories (grouped by ID prefix): ${intentCategories}

${intentCatalog}
</intent_catalog>
${conversationSection}
<latest>
${params.latest}
</latest>`;
}

export function parseIntentionResult(
  raw: string,
  validIntentIds: string[],
): IntentionResult | undefined {
  try {
    // Strip ```json code block markers if present
    let cleaned = raw.trim();
    const jsonBlockMatch = cleaned.match(/^```json\s*\n([\s\S]*?)\n?```\s*$/);
    if (jsonBlockMatch) {
      cleaned = jsonBlockMatch[1].trim();
    }

    // Also strip any stray ``` markers
    cleaned = cleaned.replace(/^```/gm, "").replace(/```$/gm, "").trim();

    // Parse JSON
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (
      typeof parsed.intent !== "string" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.goal !== "string" ||
      typeof parsed.confidence !== "number" ||
      typeof parsed.complexity !== "string"
    ) {
      return undefined;
    }

    // Validate confidence range
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      return undefined;
    }

    // Validate complexity
    if (!["low", "medium", "high"].includes(parsed.complexity)) {
      return undefined;
    }

    // Resolve intent ID
    let intent = parsed.intent;
    let intentName: string | undefined;

    const idNameMatch = intent.match(/^([A-Za-z0-9_-]+)\s*\(([^)]+)\)/);
    if (idNameMatch) {
      intent = idNameMatch[1];
      intentName = idNameMatch[2];
    }

    const caseInsensitiveMatch = validIntentIds.find(
      (id) => id.toLowerCase() === intent.toLowerCase(),
    );
    if (caseInsensitiveMatch) {
      intent = caseInsensitiveMatch;
      if (intentName) {
        intent = `${caseInsensitiveMatch.toUpperCase()} (${intentName})`;
      }
    } else if (!validIntentIds.includes(intent)) {
      const otherMatch = validIntentIds.find(
        (id) => id.toLowerCase() === FALLBACK_INTENT.id.toLowerCase(),
      );
      intent = otherMatch ?? validIntentIds[0] ?? FALLBACK_INTENT.id;
    }

    // Build result
    const result: IntentionResult = {
      intent,
      reason: parsed.reason,
      goal: parsed.goal,
      confidence: parsed.confidence,
      complexity: parsed.complexity as "low" | "medium" | "high",
    };

    // Optional suggestion
    if (typeof parsed.suggestion === "string" && parsed.suggestion) {
      result.suggestion = parsed.suggestion;
    }

    return result;
  } catch {
    // Graceful fallback on any parse failure
    return undefined;
  }
}

function resolveComplexityPrompt(
  result: IntentionResult,
  config: ResolvedIntentionHintPluginConfig,
): string {
  return (
    config.complexityPrompts[result.complexity] ??
    (result.complexity === "low"
      ? DEFAULT_LOW_COMPLEXITY_PROMPT
      : result.complexity === "medium"
        ? DEFAULT_MEDIUM_COMPLEXITY_PROMPT
        : DEFAULT_HIGH_COMPLEXITY_PROMPT)
  );
}

function buildPromptPrefixLines(
  result: IntentionResult,
  intentDef: IntentDefinition,
  config: ResolvedIntentionHintPluginConfig,
): string[] {
  const lines: string[] = [];
  lines.push(`reason: ${result.reason}`);
  lines.push(`goal: ${result.goal}`);
  if (result.suggestion) lines.push(`suggestion: ${result.suggestion}`);
  lines.push(`confidence: ${result.confidence}`);
  lines.push(`complexity: ${result.complexity}`);
  lines.push("");
  lines.push(intentDef.prompt);
  lines.push("");
  lines.push(resolveComplexityPrompt(result, config));
  return lines;
}

function resolveIntentId(intent: string): string {
  const trimmed = intent.trim();
  const idNameMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*\(/);
  return idNameMatch ? idNameMatch[1] : trimmed;
}

function findEnabledIntent(
  result: IntentionResult,
  intents: readonly IntentDefinition[],
): IntentDefinition | undefined {
  const intentId = resolveIntentId(result.intent).toLowerCase();
  return intents.find(
    (intent) => intent.enabled && intent.id.toLowerCase() === intentId,
  );
}

export function buildPromptPrefix(
  result: IntentionResult,
  intents: readonly IntentDefinition[],
  config: ResolvedIntentionHintPluginConfig,
): string | undefined {
  const intentDef = findEnabledIntent(result, intents);
  const effectiveDef = intentDef ?? FALLBACK_INTENT;
  const lines = buildPromptPrefixLines(result, effectiveDef, config);

  return `${UNTRUSTED_CONTEXT_HEADER}
<${INTENTION_HINT_PLUGIN_TAG}>
${lines.join("\n")}
</${INTENTION_HINT_PLUGIN_TAG}>`;
}
