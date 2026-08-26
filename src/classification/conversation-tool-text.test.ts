import { describe, expect, it } from "vitest";
import { extractToolText } from "./conversation.js";

describe("extractToolText", () => {
  it("extracts text from JSON content blocks", () => {
    expect(
      extractToolText(
        JSON.stringify({ content: [{ type: "text", text: "tool output" }] }),
      ),
    ).toBe("tool output");
  });

  it("extracts knowledge-base answer text", () => {
    expect(extractToolText(JSON.stringify({ answerText: "answer" }))).toBe(
      "answer",
    );
  });

  it("returns malformed JSON strings unchanged", () => {
    expect(extractToolText("not JSON")).toBe("not JSON");
  });

  it("serializes non-string values without recognized text", () => {
    expect(extractToolText({ status: "ok" })).toBe('{"status":"ok"}');
  });
});
