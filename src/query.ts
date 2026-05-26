import { UNTRUSTED_CONTEXT_HEADER } from "./constants.js";
import type {
  MessageContentPart,
  PromptMessageLike,
  RecentTurn,
} from "./types.js";

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
  } catch {
    // not JSON
  }
  return str;
}

/**
 * Apply filtering and capping to conversation turns based on query mode settings.
 * Restores the logic that was previously inside buildQuery().
 */
export function applyQueryFilters(
  allTurns: RecentTurn[],
  params: {
    queryMode: "message" | "recent" | "full";
    recentUserTurns?: number;
    recentAssistantTurns?: number;
    recentUserChars?: number;
    recentAssistantChars?: number;
  },
): RecentTurn[] {
  if (params.queryMode === "message") {
    // Only return the latest user turn (caller provides latest separately)
    return [];
  }
  if (params.queryMode === "full") {
    // No filtering - return all turns
    return allTurns;
  }

  // recent mode: bounded turns with per-turn char caps
  const maxUserTurns = params.recentUserTurns ?? 5;
  const maxAssistantTurns = params.recentAssistantTurns ?? 5;
  const userCharLimit = params.recentUserChars ?? 220;
  const assistantCharLimit = params.recentAssistantChars ?? 180;

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
    if (item.type === "thinking" || item.type === "redacted_thinking") continue;
    if (item.type === "tool_use" || item.type === "tool_result") continue;
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

function stripMetadataBlocks(text: string): string {
  return text
    .replace(/<intention_hint_plugin>[\s\S]*?<\/intention_hint_plugin>/gi, " ")
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

const HEARTBEAT_POLL = "heartbeat poll";

function isHeartbeatMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (role === "assistant" && trimmed === "HEARTBEAT_OK") return true;
  if (role === "user" && trimmed.toLowerCase().includes(HEARTBEAT_POLL))
    return true;
  return false;
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

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const typed = message as PromptMessageLike;
    const role =
      typed.role === "user" || typed.role === "assistant"
        ? typed.role
        : undefined;
    if (!role) continue;

    const text = stripMetadataBlocks(extractTextContent(typed.content));
    if (!text || isHeartbeatMessage(role, text)) continue;

    if (role === "user") {
      // If we already have a pending user without assistant, the previous
      // user turn is incomplete. Keep it and replace with the new one.
      pendingUser = { role: "user", text };
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
