import { logger } from "../../api.js";

export function extractToolText(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      if ("content" in parsed && Array.isArray(parsed.content)) {
        const firstContent = parsed.content[0];
        if (
          typeof firstContent === "object" &&
          firstContent !== null &&
          "text" in firstContent &&
          typeof firstContent.text === "string" &&
          firstContent.text
        ) {
          return firstContent.text;
        }
      }
      if (
        "answerText" in parsed &&
        typeof parsed.answerText === "string" &&
        parsed.answerText
      ) {
        return parsed.answerText;
      }
    }
  } catch (error) {
    logger.warn("failed to parse tool response as JSON, returning raw string", {
      error,
      raw: text,
    });
  }
  return text;
}
