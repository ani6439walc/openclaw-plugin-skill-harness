import { extractToolText } from "../classification/index.js";

const STRUCTURED_RESULT_TOOL_NAMES = new Set([
  "skill_list",
  "skill_search",
  "skill_view",
]);

export function resolveToolCallKey(params: {
  toolCallId?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): string | undefined {
  return params.toolCallId;
}

export function resolveToolResultText(message: unknown): string {
  if (typeof message === "object" && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (typeof block === "string") return block;
          if (typeof block === "object" && block !== null) {
            const blockText = (block as { text?: unknown }).text;
            if (typeof blockText === "string") return blockText;
          }
          return "";
        })
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return extractToolText(message);
}

export function isToolResultError(
  message: unknown,
  toolName?: string,
): boolean {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { isError?: unknown }).isError === true
  ) {
    return true;
  }

  if (!toolName || !STRUCTURED_RESULT_TOOL_NAMES.has(toolName)) return false;

  const output = resolveToolResultText(message);
  try {
    const parsed = JSON.parse(output) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { success?: unknown }).success === false
    );
  } catch {
    return false;
  }
}
