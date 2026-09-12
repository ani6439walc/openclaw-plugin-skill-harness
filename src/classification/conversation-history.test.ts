import { describe, expect, it } from "vitest";
import type { HistoricalIntentRecord, RecentTurn } from "../types.js";
import {
  attachHistoricalIntents,
  limitConversationTurns,
} from "./conversation.js";

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
        domain: "planning",
      },
    ];

    expect(attachHistoricalIntents(conversation, records)).toEqual([
      {
        role: "user",
        text: "Plan the release",
        historicalIntent: {
          intent: "PLANNING",
          domain: "planning",
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
      { input: " same message ", intent: "FIRST", domain: "unknown" },
      { input: "same\nmessage", intent: "SECOND", domain: "unknown" },
    ];

    expect(attachHistoricalIntents(conversation, records)).toEqual([
      {
        role: "user",
        text: "same message",
        historicalIntent: { intent: "FIRST", domain: "unknown" },
      },
      { role: "assistant", text: "first reply" },
      {
        role: "user",
        text: "same   message",
        historicalIntent: { intent: "SECOND", domain: "unknown" },
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
          keywords: ["historical", "feature"],
          domain: "research",
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
      text: "A long his",
      historicalIntent: {
        intent: "RESEARCH",
        domain: "research",
        keywords: ["historical", "feature"],
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
        domain: "chat",
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
          domain: "chat",
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
        domain: "unknown",
      },
      {
        input: "不然這三個 幫我看看",
        intent: "prompt-engineering",
        domain: "unknown",
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
        historicalIntent: { intent: "chat", domain: "unknown" },
      },
      { role: "assistant", text: "快去睡吧" },
      { role: "user", text: "不然這三個 幫我看看" },
    ]);
  });
});
