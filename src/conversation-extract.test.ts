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

  it("attaches the previous user turn when the latest prompt is not in conversation messages", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "好累想睡了" },
      { role: "assistant", text: "快去睡吧" },
    ];
    const records: HistoricalIntentRecord[] = [
      {
        input: "好累想睡了",
        intent: "chat",
        topic: "User is tired and wants to sleep.",
        topicChanged: true,
        topicChangeReason: "keyword_delta",
      },
    ];

    expect(
      attachHistoricalIntents(conversation, records, {
        latestInput: "不然這三個 幫我用意圖提示技能看看怎麼處理最好",
      }),
    ).toEqual([
      {
        role: "user",
        text: "好累想睡了",
        historicalIntent: {
          intent: "chat",
          topic: "User is tired and wants to sleep.",
          topicChanged: true,
          topicChangeReason: "keyword_delta",
        },
      },
      { role: "assistant", text: "快去睡吧" },
    ]);
  });

  it("does not attach historical intent to the current latest prompt when present in conversation messages", () => {
    const conversation: RecentTurn[] = [
      { role: "user", text: "好累想睡了" },
      { role: "assistant", text: "快去睡吧" },
      { role: "user", text: "不然這三個 幫我看看" },
    ];
    const records: HistoricalIntentRecord[] = [
      {
        input: "好累想睡了",
        intent: "chat",
      },
      {
        input: "不然這三個 幫我看看",
        intent: "prompt-engineering",
      },
    ];

    expect(
      attachHistoricalIntents(conversation, records, {
        latestInput: "不然這三個 幫我看看",
      }),
    ).toEqual([
      {
        role: "user",
        text: "好累想睡了",
        historicalIntent: { intent: "chat" },
      },
      { role: "assistant", text: "快去睡吧" },
      { role: "user", text: "不然這三個 幫我看看" },
    ]);
  });
});
