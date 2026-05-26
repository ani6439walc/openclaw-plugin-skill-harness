import { UNTRUSTED_CONTEXT_HEADER } from "./constants.js";
import type {
  MessageContentPart,
  PromptMessageLike,
  RecentTurn,
} from "./types.js";

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

function extractTextContent(
  content: string | Array<string | MessageContentPart> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "text" && typeof item.content === "string") {
      parts.push(item.content);
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

export function extractRecentTurns(
  messages: unknown[] | undefined,
): RecentTurn[] {
  if (!Array.isArray(messages)) return [];

  const turns: RecentTurn[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as PromptMessageLike;
    const role =
      typed.role === "user" || typed.role === "assistant"
        ? typed.role
        : undefined;
    if (!role) continue;

    const text = stripMetadataBlocks(extractTextContent(typed.content));
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}
