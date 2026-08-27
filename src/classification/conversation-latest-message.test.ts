import { describe, expect, it } from "vitest";
import { extractLatestUserMessage } from "./conversation.js";

describe("extractLatestUserMessage", () => {
  it("uses the latest user message and excludes native tool parts", () => {
    expect(
      extractLatestUserMessage([
        { role: "user", content: "Earlier question" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I checked it." },
            { type: "tool_use", text: "memory_search" },
            { type: "tool_result", text: "tool output" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", text: "must not appear" },
            { type: "text", text: "Compare the models" },
          ],
        },
      ]),
    ).toBe("Compare the models");
  });

  it("does not fall back to assembled prompt-like data when no user message exists", () => {
    expect(
      extractLatestUserMessage([
        {
          role: "assistant",
          content: "[toolResult] must not become a latest user message",
        },
      ]),
    ).toBe("");
  });

  it("extracts the current request instead of assembled prompt tool output", () => {
    expect(
      extractLatestUserMessage(
        [{ role: "user", content: "stale user message" }],
        `OpenClaw assembled context for this turn:
<conversation_context>
[toolResult] must not appear
</conversation_context>
Current user request: current clean request`,
      ),
    ).toBe("current clean request");
  });

  it("sanitizes an assembled context delivered as the latest user message", () => {
    const assembledPrompt = `OpenClaw assembled context for this turn:
<conversation_context>
[assistant] tool call: memory_search
[toolResult] MESSAGE_TOOL_OUTPUT_MUST_NOT_APPEAR
</conversation_context>
Current user request: current clean request
--- Context Warnings ---
<memory-context>recalled context</memory-context>`;
    const flattenedAssembledPrompt = assembledPrompt
      .replace(/\s+/g, " ")
      .trim();

    expect(
      extractLatestUserMessage(
        [{ role: "user", content: flattenedAssembledPrompt }],
        flattenedAssembledPrompt,
      ),
    ).toBe("current clean request");
  });
});
