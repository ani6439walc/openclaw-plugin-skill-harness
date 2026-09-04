import { describe, expect, it } from "vitest";
import {
  ROUTING_ADVISORY_HEADER,
  UNTRUSTED_CONTEXT_HEADER,
} from "../constants.js";
import { extractRecentTurns } from "./conversation.js";

describe("extractRecentTurns", () => {
  it("extracts user and assistant text messages", () => {
    const result = extractRecentTurns([
      { role: "system", content: "ignore me" },
      { role: "user", content: "hello there" },
      {
        role: "assistant",
        content: ["prefix", { type: "text", content: "hi back" }],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "hello there" },
      { role: "assistant", text: "prefix hi back" },
    ]);
  });

  it("keeps valid text from a mixed malformed content array", () => {
    const result = extractRecentTurns([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [42, { type: "text", content: "still visible" }],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "still visible" },
    ]);
  });

  it("strips skill-harness injected blocks from extracted text", () => {
    const result = extractRecentTurns([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: `${ROUTING_ADVISORY_HEADER}\n<skill_harness_plugin>Chat hint test</skill_harness_plugin>\nreal reply`,
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "test" },
      { role: "assistant", text: "real reply" },
    ]);
  });

  it("strips active-memory injected blocks from extracted text", () => {
    const result = extractRecentTurns([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content:
          "<active_memory_plugin>memory hint</active_memory_plugin>\nactual answer",
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "test" },
      { role: "assistant", text: "actual answer" },
    ]);
  });

  it("excludes thinking and redacted_thinking blocks from assistant content", () => {
    const result = extractRecentTurns([
      { role: "user", content: "what is 2+2?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me calculate this..." },
          { type: "text", content: "It's 4." },
        ],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "what is 2+2?" },
      { role: "assistant", text: "It's 4." },
    ]);
  });

  it("excludes redacted_thinking blocks from assistant content", () => {
    const result = extractRecentTurns([
      { role: "user", content: "answer me" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", thinking: "[redacted]" },
          { type: "text", content: "Here is my answer." },
        ],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "answer me" },
      { role: "assistant", text: "Here is my answer." },
    ]);
  });

  it("returns empty when thinking is the only content block", () => {
    const result = extractRecentTurns([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret reasoning" }],
      },
    ]);

    expect(result).toEqual([{ role: "user", text: "test" }]);
  });

  it("handles multiple <think> blocks in a single message", () => {
    const result = extractRecentTurns([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content:
          "<think>first thought</think>part1 <think>second thought</think>part2",
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "test" },
      { role: "assistant", text: "part1 part2" },
    ]);
  });

  it("returns only text when thinking is the only content block", () => {
    const result = extractRecentTurns([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "secret reasoning" }],
      },
    ]);

    expect(result).toEqual([]);
  });

  it("excludes tool_use and tool_result blocks from assistant content", () => {
    const result = extractRecentTurns([
      { role: "user", content: "search for me" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "web_search", input: {} },
          { type: "text", content: "Searching for you..." },
        ],
      },
    ]);

    expect(result).toEqual([
      { role: "user", text: "search for me" },
      { role: "assistant", text: "Searching for you..." },
    ]);
  });

  it("excludes assistant HEARTBEAT_OK messages", () => {
    const result = extractRecentTurns([
      { role: "user", content: "hello" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "real reply here" },
    ]);

    expect(result).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "real reply here" },
    ]);
  });

  it("excludes user heartbeat poll messages", () => {
    const result = extractRecentTurns([
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      { role: "user", content: "actual question" },
    ]);

    expect(result).toEqual([{ role: "user", text: "actual question" }]);
  });

  it("excludes inter-session user turns and their assistant replies", () => {
    const result = extractRecentTurns([
      { role: "user", content: "original question" },
      { role: "assistant", content: "original answer" },
      {
        role: "user",
        content: "subagent completion payload",
        provenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
        },
      },
      { role: "assistant", content: "processed completion payload" },
      { role: "user", content: "actual follow-up" },
    ]);

    expect(result).toEqual([
      { role: "user", text: "original question" },
      { role: "assistant", text: "original answer" },
      { role: "user", text: "actual follow-up" },
    ]);
  });

  it("excludes legacy inter-session turns identified by their prompt marker", () => {
    const result = extractRecentTurns([
      {
        role: "user",
        content:
          "[Inter-session message] sourceTool=subagent_announce isUser=false\nThis content was routed by OpenClaw from another session or internal tool.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]",
      },
      { role: "assistant", content: "processed completion payload" },
      { role: "user", content: "actual question" },
    ]);

    expect(result).toEqual([{ role: "user", text: "actual question" }]);
  });

  it("excludes protected task-completion envelopes from conversation history", () => {
    const result = extractRecentTurns([
      {
        role: "user",
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored. Keep internal details private.\n\n[Internal task completion event]\nsource: subagent\nstatus: completed\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
      { role: "assistant", content: "processed completion payload" },
      { role: "user", content: "actual question" },
    ]);

    expect(result).toEqual([{ role: "user", text: "actual question" }]);
  });
});
