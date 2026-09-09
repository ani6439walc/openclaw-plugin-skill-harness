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

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export type ConversationMessage = {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly provenance?: unknown;
};

export function isConversationMessage(
  message: unknown,
): message is ConversationMessage {
  return message !== null && typeof message === "object";
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return stripThinkingTags(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(stripThinkingTags(item));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const type = "type" in item ? item.type : undefined;
    if (
      type === "thinking" ||
      type === "redacted_thinking" ||
      type === "tool_use" ||
      type === "tool_result"
    ) {
      continue;
    }
    const text = "text" in item ? item.text : undefined;
    if (typeof text === "string") {
      parts.push(stripThinkingTags(text));
      continue;
    }
    const nestedContent = "content" in item ? item.content : undefined;
    if (type === "text" && typeof nestedContent === "string") {
      parts.push(stripThinkingTags(nestedContent));
    }
  }
  return parts.join(" ").trim();
}

function getProvenanceKind(message: ConversationMessage): string | undefined {
  const provenance = message.provenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const kind = "kind" in provenance ? provenance.kind : undefined;
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

export function isInterSessionUserMessage(
  message: ConversationMessage,
): boolean {
  const provenanceKind = getProvenanceKind(message);
  if (provenanceKind) return provenanceKind === "inter_session";
  return hasInternalUserTurnText(extractTextContent(message.content));
}

export function promptRepresentsMessage(
  prompt: string,
  messageText: string,
): boolean {
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
        .find((message): message is ConversationMessage => {
          if (!isConversationMessage(message)) return false;
          return message.role === "user" || message.role === "assistant";
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
