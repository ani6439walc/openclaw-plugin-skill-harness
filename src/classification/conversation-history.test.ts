import { describe, expect, it } from "vitest";
import type { RecentTurn } from "../types.js";
import { limitConversationTurns } from "./conversation.js";

describe("limitConversationTurns", () => {
  it("returns empty array when queryMode is message", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "Plan the release" },
      { role: "assistant", text: "Here is a plan" },
    ];
    expect(limitConversationTurns(conversation, "message")).toEqual([]);
  });

  it("returns all turns when queryMode is full", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "Plan the release" },
      { role: "assistant", text: "Here is a plan" },
    ];
    expect(limitConversationTurns(conversation, "full")).toEqual(conversation);
  });

  it("filters out empty turns in recent mode", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "   " },
      { role: "assistant", text: "" },
      { role: "user", text: "Actual request" },
    ];
    const result = limitConversationTurns(conversation, "recent");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Actual request");
  });

  it("truncates long turns and honors user/assistant limits", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "Turn 1 user" },
      { role: "assistant", text: "Turn 1 assistant" },
      {
        role: "user",
        text: "A very long user prompt that exceeds character limits",
      },
      {
        role: "assistant",
        text: "A detailed assistant response exceeding limits",
      },
    ];

    const result = limitConversationTurns(conversation, "recent", {
      user: { turns: 1, chars: 20 },
      assistant: { turns: 1, chars: 20 },
    });

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].text.length).toBeLessThanOrEqual(20);
    expect(result[0].text).toContain("(truncated...)");
    expect(result[1].role).toBe("assistant");
    expect(result[1].text.length).toBeLessThanOrEqual(20);
    expect(result[1].text).toContain("(truncated...)");
  });
});
