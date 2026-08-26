import { describe, expect, it } from "vitest";
import {
  limitConversationTurns,
  projectCurationConversation,
} from "./conversation.js";

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

describe("projectCurationConversation", () => {
  const state = (
    input: string,
    result: string,
    topicEpoch: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    input,
    result,
    timestamps: { end: "2026-08-13T00:00:00.000Z" },
    intent: {
      recommendationState: {
        topicEpoch,
        curationRevision: 0,
        candidates: [],
      },
    },
    ...overrides,
  });

  it("projects only finalized non-error history from the selected topic epoch", () => {
    const result = projectCurationConversation(
      {
        sessionId: "must-not-render",
        current: state("current user", "current assistant", 2),
        history: [
          state("prior user", "prior assistant", 1),
          state("kept user", "kept assistant", 2),
          state("errored user", "errored assistant", 2, { error: "failed" }),
          state("unfinished user", "unfinished assistant", 2, {
            timestamps: { start: "2026-08-13T00:00:00.000Z" },
          }),
        ],
      },
      2,
    );

    expect(result).toEqual([
      { role: "user", text: "kept user" },
      { role: "assistant", text: "kept assistant" },
    ]);
  });

  it("reuses recent-mode role and Unicode code-point caps", () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      state(`${index}:${"😀".repeat(220)}`, `${index}:${"😀".repeat(180)}`, 4),
    );
    const result = projectCurationConversation(
      { sessionId: "session", current: {}, history },
      4,
    );

    expect(result).toHaveLength(10);
    expect(result[0].text.startsWith("1:")).toBe(true);
    for (const turn of result) {
      expect(Array.from(turn.text).length).toBeLessThanOrEqual(
        turn.role === "user" ? 220 : 180,
      );
      expect(turn.text).not.toContain("�");
    }
  });
});
