import { describe, expect, it } from "vitest";
import { limitConversationTurns } from "./conversation.js";

describe("applyQueryFilters", () => {
  const turns = [
    { role: "user" as const, text: "first question" },
    { role: "assistant" as const, text: "first answer" },
    { role: "user" as const, text: "follow up" },
    { role: "assistant" as const, text: "follow up answer" },
  ];

  it("returns empty in message mode (caller provides latest)", () => {
    expect(limitConversationTurns(turns, "message")).toEqual([]);
  });

  it("returns all turns in full mode", () => {
    const result = limitConversationTurns(turns, "full");
    expect(result).toEqual(turns);
  });

  it("applies turn limits in recent mode", () => {
    const result = limitConversationTurns(turns, "recent", {
      user: { turns: 1, chars: 220 },
      assistant: { turns: 1, chars: 180 },
    });
    // Picks last user turn first, then last assistant turn (unshift order)
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ role: "user", text: "follow up" });
    expect(result[1]).toEqual({ role: "assistant", text: "follow up answer" });
  });

  it("applies character limits in recent mode", () => {
    const longTurn = {
      role: "user" as const,
      text: "This is a very long message that should be truncated because it exceeds the limit",
    };
    const result = limitConversationTurns([longTurn], "recent", {
      user: { turns: 5, chars: 20 },
      assistant: { turns: 5, chars: 180 },
    });
    expect(result.length).toBe(1);
    expect(result[0].text.length).toBeLessThanOrEqual(35);
    expect(result[0].text).toContain("(truncated...)");
  });

  it("counts complete recent-mode role caps in Unicode code points", () => {
    for (const [role, limit] of [
      ["user", 220],
      ["assistant", 180],
    ] as const) {
      const exact = limitConversationTurns(
        [{ role, text: "😀".repeat(limit) }],
        "recent",
      );
      const over = limitConversationTurns(
        [{ role, text: "😀".repeat(limit + 1) }],
        "recent",
      );

      expect(Array.from(exact[0].text)).toHaveLength(limit);
      expect(exact[0].text).not.toContain("(truncated...)");
      expect(Array.from(over[0].text)).toHaveLength(limit);
      expect(over[0].text).toContain("(truncated...)");
      expect(over[0].text).not.toContain("�");
    }
  });

  it("handles empty turns gracefully", () => {
    expect(limitConversationTurns([], "recent")).toEqual([]);
  });
});
