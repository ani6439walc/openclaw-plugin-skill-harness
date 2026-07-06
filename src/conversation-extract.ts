import { logger } from "../api.js";
import { UNTRUSTED_CONTEXT_HEADER } from "./constants.js";
import type {
  MessageContentPart,
  PromptMessageLike,
  RecentTurn,
  ContextWindow,
  HistoricalIntentRecord,
} from "./types.js";

const INTER_SESSION_PROMPT_MARKER = "[Inter-session message]";
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_HEADER = "OpenClaw runtime context (internal):";
const INTERNAL_RUNTIME_CONTEXT_NOTICE =
  "This context is runtime-generated, not user-authored. Keep internal details private.";
const INTERNAL_TASK_COMPLETION_MARKER = "[Internal task completion event]";
const INPUT_PROVENANCE_KINDS = new Set([
  "external_user",
  "inter_session",
  "internal_system",
]);

function normalizeTurnText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function attachHistoricalIntents(
  conversation: RecentTurn[],
  records: HistoricalIntentRecord[],
  options: { latestInput?: string } = {},
): RecentTurn[] {
  const enriched = conversation.map((turn) => ({ ...turn }));
  const normalizedLatestInput = options.latestInput
    ? normalizeTurnText(options.latestInput)
    : undefined;
  let firstAttachableIndex = enriched.length - 1;

  for (let index = enriched.length - 1; index >= 0; index--) {
    const turn = enriched[index];
    if (turn.role !== "user") continue;

    if (
      !normalizedLatestInput ||
      normalizeTurnText(turn.text) === normalizedLatestInput
    ) {
      firstAttachableIndex = index - 1;
    }
    break;
  }
  const recordsByInput = new Map<string, HistoricalIntentRecord[]>();
  for (const record of records) {
    const normalizedInput = normalizeTurnText(record.input);
    const matchingRecords = recordsByInput.get(normalizedInput) ?? [];
    matchingRecords.push(record);
    recordsByInput.set(normalizedInput, matchingRecords);
  }

  for (let turnIndex = firstAttachableIndex; turnIndex >= 0; turnIndex--) {
    const turn = enriched[turnIndex];
    if (turn.role !== "user") continue;

    const normalizedText = normalizeTurnText(turn.text);
    const record = recordsByInput.get(normalizedText)?.pop();
    if (!record) continue;
    const historicalIntent: RecentTurn["historicalIntent"] = {
      intent: record.intent,
      domain: record.domain ?? "other",
    };
    if (record.keywords?.length) historicalIntent.keywords = record.keywords;
    if (record.topic) historicalIntent.topic = record.topic;
    if (record.topicChangeReason) {
      historicalIntent.topicChangeReason = record.topicChangeReason;
    }
    turn.historicalIntent = historicalIntent;
  }

  return enriched;
}

/**
 * Extract readable text from tool call results.
 * Handles JSON-encoded content blocks (e.g. {"content":[{"type":"text","text":"..."}]}
 * and knowledge base answers (e.g. {"answerText":"..."}).
 */
export function extractToolText(raw: unknown): string {
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const parsed = JSON.parse(str);
    if (parsed?.content?.[0]?.text) return parsed.content[0].text as string;
    if (parsed?.answerText) return parsed.answerText as string;
  } catch (err) {
    logger.warn("failed to parse tool response as JSON, returning raw string", {
      error: err,
      raw: str,
    });
  }
  return str;
}

/**
 * Apply filtering and capping to conversation turns based on query mode settings.
 * Restores the logic that was previously inside buildQuery().
 */
export function limitConversationTurns(
  allTurns: RecentTurn[],
  queryMode: "message" | "recent" | "full",
  cWindow: ContextWindow = {
    user: { turns: 5, chars: 220 },
    assistant: { turns: 5, chars: 180 },
  },
): RecentTurn[] {
  if (queryMode === "message") {
    return [];
  }
  if (queryMode === "full") {
    return allTurns;
  }

  const maxUserTurns = cWindow.user.turns;
  const maxAssistantTurns = cWindow.assistant.turns;
  const userCharLimit = cWindow.user.chars;
  const assistantCharLimit = cWindow.assistant.chars;

  const filtered = allTurns.filter((turn) => turn.text.trim().length > 0);

  // Walk backwards, picking up to maxUserTurns user + maxAssistantTurns assistant
  let remainingUser = maxUserTurns;
  let remainingAssistant = maxAssistantTurns;
  const picked: RecentTurn[] = [];
  for (let i = filtered.length - 1; i >= 0; i--) {
    const turn = filtered[i];
    if (turn.role === "user" && remainingUser > 0) {
      remainingUser--;
      const cleaned = turn.text.trim().replace(/\s+/g, " ");
      picked.unshift({
        ...turn,
        role: turn.role,
        text:
          cleaned.length > userCharLimit
            ? cleaned.slice(0, userCharLimit) + " (truncated...)"
            : cleaned,
      });
    } else if (turn.role === "assistant" && remainingAssistant > 0) {
      remainingAssistant--;
      const cleaned = turn.text.trim().replace(/\s+/g, " ");
      picked.unshift({
        ...turn,
        role: turn.role,
        text:
          cleaned.length > assistantCharLimit
            ? cleaned.slice(0, assistantCharLimit) + " (truncated...)"
            : cleaned,
      });
    }
    if (remainingUser === 0 && remainingAssistant === 0) break;
  }

  return picked;
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractTextContent(
  content: string | Array<string | MessageContentPart> | undefined,
): string {
  if (typeof content === "string") return stripThinkingTags(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(stripThinkingTags(item));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (
      item.type === "thinking" ||
      item.type === "redacted_thinking" ||
      item.type === "tool_use" ||
      item.type === "tool_result"
    )
      continue;
    if (typeof item.text === "string") {
      parts.push(stripThinkingTags(item.text));
      continue;
    }
    if (item.type === "text" && typeof item.content === "string") {
      parts.push(stripThinkingTags(item.content));
    }
  }
  return parts.join(" ").trim();
}

function getProvenanceKind(message: PromptMessageLike): string | undefined {
  const kind = message.provenance?.kind;
  return typeof kind === "string" && INPUT_PROVENANCE_KINDS.has(kind)
    ? kind
    : undefined;
}

function hasInterSessionPromptMarker(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith(INTER_SESSION_PROMPT_MARKER) &&
      /\bisUser=false\b/.test(trimmed)
    );
  });
}

function hasInternalTaskCompletionContext(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let searchFrom = 0;

  for (;;) {
    const beginIndex = lines.indexOf(
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      searchFrom,
    );
    if (beginIndex === -1) return false;
    const endIndex = lines.indexOf(
      INTERNAL_RUNTIME_CONTEXT_END,
      beginIndex + 1,
    );
    if (endIndex === -1) return false;

    const block = lines.slice(beginIndex + 1, endIndex);
    const headerIndex = block.indexOf(INTERNAL_RUNTIME_CONTEXT_HEADER);
    const noticeIndex = block.indexOf(INTERNAL_RUNTIME_CONTEXT_NOTICE);
    const completionIndex = block.indexOf(INTERNAL_TASK_COMPLETION_MARKER);
    if (
      headerIndex !== -1 &&
      noticeIndex > headerIndex &&
      completionIndex > noticeIndex
    ) {
      return true;
    }
    searchFrom = endIndex + 1;
  }
}

function hasInternalUserTurnText(text: string): boolean {
  return (
    hasInterSessionPromptMarker(text) || hasInternalTaskCompletionContext(text)
  );
}

function isInterSessionUserMessage(message: PromptMessageLike): boolean {
  const provenanceKind = getProvenanceKind(message);
  if (provenanceKind) return provenanceKind === "inter_session";
  return hasInternalUserTurnText(extractTextContent(message.content));
}

function promptRepresentsMessage(prompt: string, messageText: string): boolean {
  const normalizedPrompt = prompt.trim();
  const normalizedMessage = messageText.trim();
  if (!normalizedPrompt || !normalizedMessage) return false;
  return (
    normalizedPrompt === normalizedMessage ||
    normalizedPrompt.endsWith(normalizedMessage)
  );
}

export function isInternalUserTurn(params: {
  prompt: string;
  messages: unknown[] | undefined;
}): boolean {
  const promptHasInternalTurnSignal = hasInternalUserTurnText(params.prompt);
  const latestConversationMessage = Array.isArray(params.messages)
    ? params.messages
        .slice()
        .reverse()
        .find((message): message is PromptMessageLike => {
          if (!message || typeof message !== "object") return false;
          const role = (message as PromptMessageLike).role;
          return role === "user" || role === "assistant";
        })
    : undefined;

  if (latestConversationMessage?.role === "user") {
    const provenanceKind = getProvenanceKind(latestConversationMessage);
    const latestUserText = extractTextContent(
      latestConversationMessage.content,
    );
    if (!promptRepresentsMessage(params.prompt, latestUserText)) {
      return promptHasInternalTurnSignal;
    }
    if (provenanceKind) return provenanceKind === "inter_session";
    return (
      hasInternalUserTurnText(latestUserText) || promptHasInternalTurnSignal
    );
  }

  return promptHasInternalTurnSignal;
}

function stripMetadataBlocks(text: string): string {
  return text
    .replace(
      /<skill_harness_plugin\b[^>]*>[\s\S]*?<\/skill_harness_plugin>/gi,
      " ",
    )
    .replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/gi, " ")
    .replace(
      /Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
      " ",
    )
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, " ")
    .split(UNTRUSTED_CONTEXT_HEADER)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeartbeatMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (role === "assistant" && trimmed === "HEARTBEAT_OK") return true;
  return role === "user" && trimmed.toLowerCase().includes("heartbeat poll");
}

/**
 * Extract user-assistant conversation turns from raw messages.
 * Each turn is defined as user→assistant pair.
 * Intermediate content (thinking, tool_use, system messages) is discarded.
 * Only complete pairs and the latest standalone user message are kept.
 */
export function extractRecentTurns(
  messages: unknown[] | undefined,
): RecentTurn[] {
  if (!Array.isArray(messages)) return [];

  const turns: RecentTurn[] = [];
  let pendingUser: RecentTurn | undefined;
  let skipNextAssistant = false;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const typed = message as PromptMessageLike;
    const role = typed.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = stripMetadataBlocks(extractTextContent(typed.content));
    if (!text || isHeartbeatMessage(role, text)) continue;

    if (role === "user") {
      if (isInterSessionUserMessage(typed)) {
        skipNextAssistant = true;
        continue;
      }
      skipNextAssistant = false;
      // If we already have a pending user without assistant, the previous
      // user turn is incomplete. Keep it and replace with the new one.
      pendingUser = { role: "user", text };
    } else if (skipNextAssistant) {
      skipNextAssistant = false;
    } else if (role === "assistant" && pendingUser) {
      // Complete the pair.
      turns.push(pendingUser);
      turns.push({ role: "assistant", text });
      pendingUser = undefined;
    }
  }

  // If there's a trailing user message with no assistant response, include it
  // (the conversation is still in progress).
  if (pendingUser) {
    turns.push(pendingUser);
  }

  return turns;
}
