import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { checkEvolutionTriggers } from "./trigger-checker.js";
import type { EvolutionTriggerKeywords } from "./evolution-trigger-keywords.js";
import type { SessionState } from "./session-tracker.js";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    input: "Please do this",
    intent: {
      result: {
        intent: "CODE_REVIEW",
        reason: "test",
        confidence: 0.9,
        complexity: "medium",
      },
    },
    ...overrides,
  };
}

describe("checkEvolutionTriggers", () => {
  const triggers = resolveConfig({}).evolution.triggers;
  const customKeywords: EvolutionTriggerKeywords = {
    successfulPattern: ["verified"],
    behaviorFix: ["redo"],
    entityContext: ["means"],
  };

  it("returns all matching current-turn triggers", () => {
    expect(
      checkEvolutionTriggers(
        state({
          input: "不對，應該是另一個做法，以後看到先看 TOOLS.md",
          result: "完成，驗證通過。",
          intent: {
            result: {
              intent: "other",
              reason: "unclear",
              confidence: 0.2,
              complexity: "high",
            },
          },
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
            error: index < 2 ? "failed" : undefined,
          })),
        }),
        10,
        triggers,
      ),
    ).toEqual([
      "skill-candidate",
      "process-gap",
      "successful-pattern",
      "satisfaction-check",
      "missing-intent",
      "weak-intent",
      "behavior-fix",
      "entity-context",
    ]);
  });

  it("only runs satisfaction checks on the configured turn interval", () => {
    expect(checkEvolutionTriggers(state(), 9, triggers)).not.toContain(
      "satisfaction-check",
    );
    expect(checkEvolutionTriggers(state(), 10, triggers)).toContain(
      "satisfaction-check",
    );
    expect(checkEvolutionTriggers(state(), 20, triggers)).toContain(
      "satisfaction-check",
    );
  });

  it("honors custom thresholds and disabled triggers", () => {
    const custom = resolveConfig({
      evolution: {
        triggers: {
          skillCandidate: { enabled: false },
          processGap: { toolFailures: 1 },
          successfulPattern: { toolCalls: 2 },
          satisfactionCheck: { everyTurns: 3 },
          weakIntent: { confidenceBelow: 0.95 },
          behaviorFix: {},
        },
      },
    }).evolution.triggers;

    expect(
      checkEvolutionTriggers(
        state({
          input: "redo this",
          toolCalls: [{ name: "exec", params: {}, error: "failed" }],
        }),
        3,
        custom,
        customKeywords,
      ),
    ).toEqual([
      "process-gap",
      "satisfaction-check",
      "weak-intent",
      "behavior-fix",
    ]);
  });

  it("detects successful reusable patterns from completed tool-heavy turns", () => {
    expect(
      checkEvolutionTriggers(
        state({
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "Implemented the feature and verified tests passed.",
        }),
        1,
        triggers,
      ),
    ).toContain("successful-pattern");
  });

  it("detects successful reusable patterns from skill-assisted completed turns", () => {
    expect(
      checkEvolutionTriggers(
        state({
          skillsUsed: [{ name: "test-driven-development", path: "skills/tdd" }],
          result: "完成，驗證通過。",
        }),
        1,
        triggers,
      ),
    ).toContain("successful-pattern");
  });

  it("uses runtime evolution trigger keywords instead of plugin config keywords", () => {
    const runtimeKeywords: EvolutionTriggerKeywords = {
      successfulPattern: ["ship it"],
      behaviorFix: ["try again"],
      entityContext: ["means"],
    };

    expect(
      checkEvolutionTriggers(
        state({
          input: "try again with the other helper",
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "ship it",
        }),
        1,
        triggers,
        runtimeKeywords,
      ),
    ).toEqual(["skill-candidate", "successful-pattern", "behavior-fix"]);
  });

  it("does not detect successful patterns for failed turns or completion text without reusable work", () => {
    expect(
      checkEvolutionTriggers(
        state({
          error: "failed",
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "verified",
        }),
        1,
        triggers,
      ),
    ).not.toContain("successful-pattern");

    expect(
      checkEvolutionTriggers(state({ result: "done" }), 1, triggers),
    ).not.toContain("successful-pattern");
  });

  it("detects entity-context only from learning keywords plus narrow source signals", () => {
    expect(
      checkEvolutionTriggers(
        state({ input: "Yumi 指的是 Hermes/RG476H，之後先看 TOOLS.md" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({ input: "幫我看一下 TOOLS.md 裡有沒有 Yumi 的紀錄" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({ input: "看下 MEMORY.md 裡有沒有 RG476H 的紀錄" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");
  });

  it("uses read/search tool params as entity-context source signals", () => {
    expect(
      checkEvolutionTriggers(
        state({
          input: "Yumi 指的是 Hermes/RG476H",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({
          input: "看看這個 alias 之前是不是有記",
          toolCalls: [
            {
              name: "read_file",
              params: { path: "/profile/memory/MEMORY.md" },
            },
          ],
        }),
        1,
        triggers,
      ),
    ).toContain("entity-context");
  });

  it("does not detect entity-context from source or learning keywords alone", () => {
    expect(
      checkEvolutionTriggers(
        state({
          input: "幫我看 TOOLS.md",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({ input: "Yumi 指的是 Hermes/RG476H" }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({
          input: "RG476H 怎麼設定 Wi-Fi",
          toolCalls: [{ name: "read_file", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkEvolutionTriggers(state({ input: "Yumi 好可愛" }), 1, triggers),
    ).not.toContain("entity-context");
  });

  it("does not treat unrelated docs as entity-context source signals", () => {
    expect(
      checkEvolutionTriggers(
        state({ input: "以後看到 Yumi 先看 AGENTS.md" }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkEvolutionTriggers(
        state({
          input: "Yumi 指的是 Hermes/RG476H",
          toolCalls: [{ name: "read", params: { path: "AGENTS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");
  });
});
