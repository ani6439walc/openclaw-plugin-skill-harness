import { describe, expect, it } from "vitest";
import {
  attachHistoricalIntents,
  limitConversationTurns,
} from "./conversation-extract.js";
import type { HistoricalIntentRecord, RecentTurn } from "./types.js";

describe("attachHistoricalIntents", () => {
  it("attaches matching historical intents to user turns only", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "Plan the release" },
      { role: "assistant", text: "Here is a plan" },
      { role: "user", text: "Ship it" },
    ];
    const records: HistoricalIntentRecord[] = [
      {
        input: "Plan the release",
        intent: "PLANNING",
        topicChanged: true,
        topicChangeReason: "keyword_delta",
      },
    ];

    expect(attachHistoricalIntents(conversation, records)).toEqual([
      {
        role: "user",
        text: "Plan the release",
        historicalIntent: {
          intent: "PLANNING",
          topicChanged: true,
          topicChangeReason: "keyword_delta",
        },
      },
      { role: "assistant", text: "Here is a plan" },
      { role: "user", text: "Ship it" },
    ]);
  });

  it("normalizes whitespace and pairs duplicate messages newest-first", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "same message" },
      { role: "assistant", text: "first reply" },
      { role: "user", text: "same   message" },
      { role: "assistant", text: "second reply" },
      { role: "user", text: "same message" },
    ];
    const records: HistoricalIntentRecord[] = [
      { input: " same message ", intent: "FIRST" },
      { input: "same\nmessage", intent: "SECOND" },
    ];

    expect(attachHistoricalIntents(conversation, records)).toEqual([
      {
        role: "user",
        text: "same message",
        historicalIntent: { intent: "FIRST" },
      },
      { role: "assistant", text: "first reply" },
      {
        role: "user",
        text: "same   message",
        historicalIntent: { intent: "SECOND" },
      },
      { role: "assistant", text: "second reply" },
      { role: "user", text: "same message" },
    ]);
  });

  it("preserves historical intent when recent-mode text is truncated", () => {
    const conversation = attachHistoricalIntents(
      [
        { role: "user", text: "A long historical user message" },
        { role: "assistant", text: "A long assistant reply" },
        { role: "user", text: "latest" },
      ],
      [
        {
          input: "A long historical user message",
          intent: "RESEARCH",
          keywords: ["historical", "topic"],
          topic: "historical / topic",
          topicChanged: false,
          topicChangeReason: "same_topic",
        },
      ],
    );

    expect(
      limitConversationTurns(conversation, "recent", {
        user: { turns: 2, chars: 10 },
        assistant: { turns: 1, chars: 10 },
      })[0],
    ).toEqual({
      role: "user",
      text: "A long his (truncated...)",
      historicalIntent: {
        intent: "RESEARCH",
        keywords: ["historical", "topic"],
        topic: "historical / topic",
        topicChanged: false,
        topicChangeReason: "same_topic",
      },
    });
  });
});
