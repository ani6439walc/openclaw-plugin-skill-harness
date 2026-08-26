import {
  UNTRUSTED_CONTEXT_HEADER,
  USER_MESSAGE_BOUNDARY,
} from "../constants.js";
import type { RecentTurn } from "../types.js";
import {
  extractTextContent,
  isConversationMessage,
  isInterSessionUserMessage,
  promptRepresentsMessage,
} from "./conversation-provenance.js";

const ESCAPED_USER_MESSAGE_BOUNDARY = USER_MESSAGE_BOUNDARY.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
);
const OPENCLAW_ASSEMBLED_CONTEXT_HEADER =
  "OpenClaw assembled context for this turn:";
const CONTEXT_WARNINGS_HEADER = "--- Context Warnings ---";
const ATTACHED_CONTEXT_HEADER = "--- Attached Context ---";
const CONVERSATION_CONTEXT_END_TAG = "</conversation_context>";

// Build per call: the /g flag mutates lastIndex on shared RegExp instances.
function routingBlockWithOptionalBoundary(): RegExp {
  return new RegExp(
    `<skill_harness_plugin\\b[^>]*>[\\s\\S]*?<\\/skill_harness_plugin>\\s*(?:${ESCAPED_USER_MESSAGE_BOUNDARY})?\\s*`,
    "gi",
  );
}

export function sanitizeConversationText(text: string): string {
  // Header split must run before tag matching: the header mentions the tag inline.
  return text
    .split(UNTRUSTED_CONTEXT_HEADER)
    .join(" ")
    .replace(routingBlockWithOptionalBoundary(), " ")
    .replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/gi, " ")
    .replace(
      /Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
      " ",
    )
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, " ")
    .replace(/^\s*System:\s*\[[^\]]+\]\s*Model switched to .*$/gim, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeHistoricalIntentInput(text: string): string {
  const prompt = text.trimStart();
  if (!prompt.startsWith(OPENCLAW_ASSEMBLED_CONTEXT_HEADER)) {
    return sanitizeConversationText(text);
  }

  const conversationEndIndex = prompt.lastIndexOf(CONVERSATION_CONTEXT_END_TAG);
  if (conversationEndIndex === -1) return "";
  const requestMatch = /^\s*Current user request:\s*/.exec(
    prompt.slice(conversationEndIndex + CONVERSATION_CONTEXT_END_TAG.length),
  );
  if (!requestMatch) return "";

  const requestStart =
    conversationEndIndex +
    CONVERSATION_CONTEXT_END_TAG.length +
    requestMatch.index +
    requestMatch[0].length;
  const contextEnd = [
    prompt.indexOf(CONTEXT_WARNINGS_HEADER, requestStart),
    prompt.indexOf(ATTACHED_CONTEXT_HEADER, requestStart),
  ]
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  return sanitizeConversationText(prompt.slice(requestStart, contextEnd));
}

function isHeartbeatMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (role === "assistant" && trimmed === "HEARTBEAT_OK") return true;
  return role === "user" && trimmed.toLowerCase().includes("heartbeat poll");
}

export function extractRecentTurns(
  messages: unknown[] | undefined,
): RecentTurn[] {
  if (!Array.isArray(messages)) return [];

  const turns: RecentTurn[] = [];
  let pendingUser: RecentTurn | undefined;
  let skipNextAssistant = false;

  for (const message of messages) {
    if (!isConversationMessage(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const rawText = extractTextContent(message.content);
    const text =
      role === "user"
        ? sanitizeHistoricalIntentInput(rawText)
        : sanitizeConversationText(rawText);
    if (!text || isHeartbeatMessage(role, text)) continue;

    if (role === "user") {
      if (isInterSessionUserMessage(message)) {
        skipNextAssistant = true;
        continue;
      }
      skipNextAssistant = false;
      pendingUser = { role: "user", text };
    } else if (skipNextAssistant) {
      skipNextAssistant = false;
    } else if (pendingUser) {
      turns.push(pendingUser);
      turns.push({ role: "assistant", text });
      pendingUser = undefined;
    }
  }

  if (pendingUser) turns.push(pendingUser);
  return turns;
}

export function extractLatestUserMessage(
  messages: unknown[] | undefined,
  prompt?: string,
): string {
  let latestUserMessage = "";

  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        !isConversationMessage(message) ||
        message.role !== "user" ||
        isInterSessionUserMessage(message)
      ) {
        continue;
      }
      const text = sanitizeHistoricalIntentInput(
        extractTextContent(message.content),
      );
      if (text && !isHeartbeatMessage("user", text)) {
        latestUserMessage = text;
        break;
      }
    }
  }

  if (
    latestUserMessage &&
    (!prompt || promptRepresentsMessage(prompt, latestUserMessage))
  ) {
    return latestUserMessage;
  }
  return prompt ? sanitizeHistoricalIntentInput(prompt) : latestUserMessage;
}
