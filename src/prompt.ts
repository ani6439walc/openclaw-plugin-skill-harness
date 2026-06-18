import {
  DEFAULT_LOW_COMPLEXITY_PROMPT,
  DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  DEFAULT_HIGH_COMPLEXITY_PROMPT,
  FALLBACK_INTENT,
  FALLBACK_INTENT_ID,
  INTENTION_HINT_PLUGIN_TAG,
  UNTRUSTED_CONTEXT_HEADER,
} from "./constants.js";
import type {
  HistoricalIntentRecord,
  IntentCatalogEntry,
  IntentDefinition,
  IntentionResult,
  RecentTurn,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";

export type TopicChangeReason = NonNullable<
  IntentionResult["topicChangeReason"]
>;

export type TopicSwitchResult = {
  keywords: string[];
  topic: string;
  topicChanged: boolean;
  topicChangeReason: Exclude<TopicChangeReason, "initial">;
  complexity: IntentionResult["complexity"];
};

const COMPLEXITIES = ["low", "medium", "high"] as const;

const FALLBACK_INTENT_ENTRY: IntentCatalogEntry = {
  id: FALLBACK_INTENT_ID,
  definition: FALLBACK_INTENT,
};

function getIntentsWithFallback(
  intents: readonly IntentCatalogEntry[],
): IntentCatalogEntry[] {
  return [...intents, FALLBACK_INTENT_ENTRY];
}

function buildIntentCatalog(intents: readonly IntentCatalogEntry[]): string {
  return getIntentsWithFallback(intents)
    .map((entry) => {
      const lines = [`<intent id="${entry.id}">`];
      if (entry.definition.triggers.length > 0) {
        lines.push(`triggers:`);
        lines.push(
          ...entry.definition.triggers.map((trigger) => `- ${trigger}`),
        );
      }
      if (entry.definition.examples.length > 0) {
        lines.push(`examples:`);
        lines.push(
          ...entry.definition.examples.map((example) => `- ${example}`),
        );
      }
      lines.push(`</intent>`);
      return lines.join("\n");
    })
    .join("\n");
}

function buildIntentCategories(intents: readonly IntentCatalogEntry[]): string {
  const categoryMap = new Map<string, string[]>();
  const standaloneIntents: string[] = [];
  for (const intent of getIntentsWithFallback(intents)) {
    const separatorIndex = intent.id.indexOf("-");
    if (separatorIndex <= 0) {
      standaloneIntents.push(intent.id);
      continue;
    }
    const prefix = intent.id.slice(0, separatorIndex);
    if (!categoryMap.has(prefix)) {
      categoryMap.set(prefix, []);
    }
    categoryMap.get(prefix)!.push(intent.id);
  }

  const categoryLines: string[] = [];
  for (const [prefix, ids] of categoryMap) {
    if (ids.length >= 2) {
      categoryLines.push(`- ${prefix}-*: ${ids.join(", ")}`);
    } else {
      standaloneIntents.push(...ids);
    }
  }
  if (standaloneIntents.length > 0) {
    categoryLines.push(`- standalone: ${standaloneIntents.join(", ")}`);
  }

  return categoryLines.length > 0
    ? categoryLines.join("\n")
    : "- No categories with 2+ intents";
}

function buildConversationMarkdown(
  conversation: RecentTurn[] | undefined,
): string {
  if (!conversation || conversation.length === 0) return "";

  const historyLines = conversation.map((turn) => {
    const rolePrefix = `**${turn.role}**:`;
    const turnLines = [`- ${rolePrefix} ${turn.text}`];

    if (turn.role === "user" && turn.historicalIntent) {
      const { intent, keywords, topic } = turn.historicalIntent;
      const metadata = [`intent: ${intent}`];
      if (topic) metadata.push(`topic: ${topic}`);
      if (keywords?.length) metadata.push(`keywords: ${keywords.join(", ")}`);
      turnLines.push(`  > *${metadata.join("; ")}*`);
    }

    return turnLines.join("\n");
  });

  return ["# Conversation context", "## Recent history", ...historyLines].join(
    "\n",
  );
}

export function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const keyword = item.trim().toLowerCase().replace(/\s+/g, " ");
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length === 8) break;
  }
  return keywords;
}

export function buildTopicFromKeywords(keywords: readonly string[]): string {
  return keywords.slice(0, 3).join(" / ");
}

function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function buildHistoricalTopicContext(
  records: readonly HistoricalIntentRecord[],
): string {
  return records
    .slice(-3)
    .map((record) =>
      [
        `- intent: ${record.intent}`,
        record.topic ? `  topic: ${record.topic}` : undefined,
        record.keywords?.length
          ? `  keywords: ${record.keywords.join(", ")}`
          : undefined,
        record.complexity ? `  complexity: ${record.complexity}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

export function buildTopicSwitchPrompt(params: {
  latest: string;
  history: readonly HistoricalIntentRecord[];
  currentTime?: string;
}): string {
  const timeLine = params.currentTime ? `${params.currentTime} ` : "";
  const history = buildHistoricalTopicContext(params.history);

  return `${timeLine}You are a lightweight topic continuity checker.
Decide whether the user's latest message continues the recent topic or switches to a new one.
Use only the latest message and recent historical intent metadata. Do not classify intent.

<rules>
1. Extract 3-8 core nouns or short phrases from the latest user message as keywords.
2. Normalize keywords to lowercase and remove duplicates.
3. topic is deterministic: the first 1-3 keywords joined by " / ".
4. topicChanged=true when the user uses an explicit transition marker, requests a new or modified category, or the latest message is independent from the previous topic.
5. topicChanged=false when the user is continuing, correcting, approving, or implementing the same topic.
6. Classify the latest message complexity as low, medium, or high.
</rules>

<output_format>
Return JSON only:
{
  "keywords": ["keyword"],
  "topicChanged": false,
  "topicChangeReason": "same_topic",
  "complexity": "medium"
}

topicChangeReason must be one of: same_topic, transition_marker, keyword_delta, explicit_change.
complexity must be one of: low, medium, high.
</output_format>

<recent_history>
${history || "- No history"}
</recent_history>

## Latest message:
${params.latest}`;
}

export function parseTopicSwitchResult(
  raw: string,
): TopicSwitchResult | undefined {
  try {
    const parsed = JSON.parse(stripCodeFence(raw));
    const keywords = normalizeKeywords(parsed.keywords);
    if (keywords.length === 0 || typeof parsed.topicChanged !== "boolean") {
      return;
    }
    if (
      ![
        "same_topic",
        "transition_marker",
        "keyword_delta",
        "explicit_change",
      ].includes(parsed.topicChangeReason)
    ) {
      return;
    }
    if (!COMPLEXITIES.includes(parsed.complexity)) {
      return;
    }
    return {
      keywords,
      topic: buildTopicFromKeywords(keywords),
      topicChanged: parsed.topicChanged,
      topicChangeReason: parsed.topicChangeReason,
      complexity: parsed.complexity,
    };
  } catch {
    return;
  }
}

export function buildIntentInstructionPrompt(params: {
  latest: string;
  result: IntentionResult;
  intentBody: string;
  currentTime?: string;
}): string {
  const timeLine = params.currentTime ? `${params.currentTime} ` : "";
  return `${timeLine}You are an intention-hint instruction writer.
Read the matched intent Markdown and the latest user message.
Write concise internal instructions for the main agent.

<rules>
1. Output plain text only, not JSON and not Markdown fences.
2. Include the concrete workflow the main agent should follow.
3. Name any relevant skills and tools from the intent Markdown.
4. Preserve useful pitfalls, parameters, and experience notes when they matter for this turn.
5. Do not quote the whole intent file. Keep only actionable guidance.
</rules>

<intent_metadata>
intent: ${params.result.intent}
complexity: ${params.result.complexity}
topic: ${params.result.topic ?? ""}
keywords: ${params.result.keywords?.join(", ") ?? ""}
intentChange: ${params.result.intentChange ?? true}
</intent_metadata>

<matched_intent_markdown>
${params.intentBody}
</matched_intent_markdown>

## Latest message:
${params.latest}`;
}

export function buildIntentionPrompt(params: {
  conversation?: RecentTurn[];
  latest: string;
  intents: readonly IntentCatalogEntry[];
  topicContext?: TopicSwitchResult;
  currentTime?: string;
}): string {
  const timeLine = params.currentTime ? `${params.currentTime} ` : "";

  const intentCatalog = buildIntentCatalog(params.intents);
  const intentCategories = buildIntentCategories(params.intents);
  const conversationMd = buildConversationMarkdown(params.conversation);
  const conversationSection = conversationMd ? `\n${conversationMd}\n` : "";
  const topicContextSection = params.topicContext
    ? `
<topic_switch_context>
keywords: ${params.topicContext.keywords.join(", ")}
topic: ${params.topicContext.topic}
topicChanged: ${params.topicContext.topicChanged}
topicChangeReason: ${params.topicContext.topicChangeReason}
complexity: ${params.topicContext.complexity}
</topic_switch_context>
`
    : "";

  return `${timeLine}You are an intent classification agent.
Another model is preparing the final user-facing answer with hints and subagent routing.
Your job is to analyze conversation context and the user's latest message, then classify which intent best matches.
You receive conversation history, the latest user message, and available intent definitions with triggers and examples.

<classification_rules>
1. Use conversation history and historical_intent annotations to understand context. Treat historical intents as evidence, not answers that must be inherited.
2. Classify the latest message based on what the user is asking for now and prefer the intent that best explains WHY the user said it.
3. **Topic switch**: If the latest message introduces an independent topic, a different subject, or a different desired outcome, classify it fresh.
4. **Short messages**: First determine whether the message points to a specific historical topic. Do not inherit the most recent intent merely because the message is short or contains a continuation marker.
5. If topic_switch_context is present and topicChanged=true, classify fresh.
6. If topic_switch_context is present, use its complexity value.
7. If topic_switch_context is present and topicChanged=false, continuity with the previous topic is allowed but not mandatory.
8. Extract 3-8 lowercase core nouns or short phrases as keywords.
9. DO NOT FORCE classification - default to other if uncertain.
10. Validate output: ensure all required JSON fields are present, intent exists in catalog (or other), confidence is 0.0-1.0, complexity is low|medium|high.
</classification_rules>

<output_format>
Return classification as a JSON object. Output MUST be plain JSON only — do NOT wrap in \`\`\`json code blocks.

Required fields:
- "intent": string - Intent id exactly as shown in the catalog (e.g., "memory-lookup" or "other")
- "reason": string - Brief reason for classification
- "keywords": string[] - 3-8 normalized core nouns or short phrases from the latest message
- "confidence": number - 0.0 (guessing) to 1.0 (certain)
- "complexity": string - "low", "medium", or "high"

Optional fields:
- "suggestion": string - Only when confidence < 0.8; provide general guidance

Example output:
{
  "intent": "memory-lookup",
  "reason": "User asked to recall previous conversation topic",
  "keywords": ["python", "async", "memory"],
  "confidence": 0.9,
  "complexity": "medium"
}

Complexity levels:
- "low": simple greeting, acknowledgment, straightforward question or task with clear/unambiguous scope requiring direct execution. (narrow or standard scope — no additional investigation needed)
- "medium": task requiring moderate context analysis or broader scope that needs some investigation before execution.
- "high": multi-step investigation, research, complex code operations, or broad scope requiring full SOP workflow and structural changes.

Fallback: If no intent confidently matches, return intent as "other".
</output_format>

<intent_catalog>
Categories (grouped by ID prefix):
${intentCategories}

${intentCatalog}
</intent_catalog>
${topicContextSection}
${conversationSection}
## Latest message:
${params.latest}`;
}

export function parseIntentionResult(
  raw: string,
  validIntentIds: string[],
  topicContext?: TopicSwitchResult,
): IntentionResult | undefined {
  try {
    // Strip ```json code block markers if present
    const cleaned = stripCodeFence(raw);

    // Parse JSON
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (
      typeof parsed.intent !== "string" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.confidence !== "number" ||
      (topicContext ? false : typeof parsed.complexity !== "string")
    ) {
      return undefined;
    }

    // Validate confidence range
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      return undefined;
    }

    // Validate complexity
    const complexity = topicContext?.complexity ?? parsed.complexity;
    if (!COMPLEXITIES.includes(complexity)) {
      return undefined;
    }

    // Resolve intent ID
    let intent = parsed.intent;

    const idNameMatch = intent.match(/^([A-Za-z0-9_-]+)\s*\(([^)]+)\)/);
    if (idNameMatch) {
      intent = idNameMatch[1];
    }

    const caseInsensitiveMatch = validIntentIds.find(
      (id) => id.toLowerCase() === intent.toLowerCase(),
    );
    if (caseInsensitiveMatch) {
      intent = caseInsensitiveMatch;
    } else if (!validIntentIds.includes(intent)) {
      const otherMatch = validIntentIds.find(
        (id) => id.toLowerCase() === FALLBACK_INTENT_ID.toLowerCase(),
      );
      intent = otherMatch ?? validIntentIds[0] ?? FALLBACK_INTENT_ID;
    }

    // Build result
    const keywords = normalizeKeywords(parsed.keywords);
    const effectiveKeywords =
      keywords.length > 0 ? keywords : (topicContext?.keywords ?? []);
    const result: IntentionResult = {
      intent,
      reason: parsed.reason,
      keywords: effectiveKeywords.length > 0 ? effectiveKeywords : undefined,
      topic:
        effectiveKeywords.length > 0
          ? buildTopicFromKeywords(effectiveKeywords)
          : undefined,
      topicChanged: topicContext?.topicChanged ?? false,
      topicChangeReason: topicContext?.topicChangeReason ?? "initial",
      confidence: parsed.confidence,
      complexity,
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
  instructionText?: string,
): string[] {
  const lines: string[] = [];
  lines.push(`reason: ${result.reason}`);
  if (result.suggestion) lines.push(`suggestion: ${result.suggestion}`);
  if (result.topic) lines.push(`topic: ${result.topic}`);
  if (result.keywords?.length)
    lines.push(`keywords: ${result.keywords.join(", ")}`);
  if (result.topicChangeReason) {
    lines.push(`topicChanged: ${result.topicChanged ?? false}`);
    lines.push(`topicChangeReason: ${result.topicChangeReason}`);
  }
  if (result.intentChange !== undefined)
    lines.push(`intentChange: ${result.intentChange}`);
  if (result.previousTopic)
    lines.push(`previousTopic: ${result.previousTopic}`);
  lines.push(`confidence: ${result.confidence}`);
  lines.push(`complexity: ${result.complexity}`);
  lines.push("");
  lines.push(instructionText?.trim() || intentDef.prompt);
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
  intents: readonly IntentCatalogEntry[],
): IntentDefinition | undefined {
  const intentId = resolveIntentId(result.intent).toLowerCase();
  return intents.find((intent) => intent.id.toLowerCase() === intentId)
    ?.definition;
}

export function buildPromptPrefix(
  result: IntentionResult,
  intents: readonly IntentCatalogEntry[],
  config: ResolvedIntentionHintPluginConfig,
  instructionText?: string,
): string | undefined {
  const intentDef = findEnabledIntent(result, intents);
  const effectiveDef = intentDef ?? FALLBACK_INTENT;
  const lines = buildPromptPrefixLines(
    result,
    effectiveDef,
    config,
    instructionText,
  );

  return `${UNTRUSTED_CONTEXT_HEADER}
<${INTENTION_HINT_PLUGIN_TAG}>
${lines.join("\n")}
</${INTENTION_HINT_PLUGIN_TAG}>`;
}
