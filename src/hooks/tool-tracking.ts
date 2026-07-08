import { extractToolText } from "../classification/index.js";

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

export function isToolResultError(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { isError?: unknown }).isError === true
  );
}
