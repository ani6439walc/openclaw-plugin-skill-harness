import { describe, it, expect } from "vitest";
import { resolveConfig, clampInt } from "./config.js";
import {
  DEFAULT_QUERY_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
  DEFAULT_LOW_COMPLEXITY_PROMPT,
  DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
  DEFAULT_HIGH_COMPLEXITY_PROMPT,
} from "./constants.js";

describe("resolveConfig", () => {
  describe("default values", () => {
    it("should use default values for empty config", () => {
      const result = resolveConfig({});
      expect(result.agents).toEqual(["main"]);
      expect(result.allowedChatTypes).toEqual(["direct"]);
      expect(result.queryMode).toBe(DEFAULT_QUERY_MODE);
      expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.thinking).toBe("medium");
      expect(result.contextWindow.user.turns).toBe(DEFAULT_RECENT_USER_TURNS);
      expect(result.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(result.contextWindow.user.chars).toBe(DEFAULT_RECENT_USER_CHARS);
      expect(result.contextWindow.assistant.chars).toBe(
        DEFAULT_RECENT_ASSISTANT_CHARS,
      );
      expect(result.evolution).toMatchObject({
        enabled: false,
        model: undefined,
        modelFallback: undefined,
        thinking: "medium",
        timeoutMs: 30000,
        triggers: {
          skillCandidate: { enabled: true, toolCalls: 5 },
          processGap: { enabled: true, toolFailures: 2 },
          successfulPattern: {
            enabled: true,
            toolCalls: 5,
          },
          satisfactionCheck: { enabled: true, everyTurns: 10 },
          missingIntent: { enabled: true },
          weakIntent: { enabled: true, confidenceBelow: 0.5 },
          behaviorFix: { enabled: true },
          entityContext: { enabled: true },
        },
      });
      expect(result.instruction).toMatchObject({
        enabled: false,
        model: undefined,
        modelFallback: undefined,
        thinking: "medium",
        timeoutMs: 30000,
      });
    });

    it("should handle empty object loading", () => {
      const result = resolveConfig({});
      expect(result.intentDeny).toEqual({});
      expect(result.allowedChatIds).toEqual([]);
      expect(result.deniedChatIds).toEqual([]);
      expect(result.model).toBeUndefined();
      expect(result.modelFallback).toBeUndefined();
    });

    it("should use default values for non-object config", () => {
      for (const raw of [undefined, null, "invalid", []]) {
        const result = resolveConfig(raw);
        expect(result.agents).toEqual(["main"]);
        expect(result.allowedChatTypes).toEqual(["direct"]);
        expect(result.intentDeny).toEqual({});
        expect(result.queryMode).toBe(DEFAULT_QUERY_MODE);
        expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      }
    });
  });

  describe("evolution", () => {
    it("parses and clamps review and trigger settings", () => {
      const result = resolveConfig({
        evolution: {
          enabled: true,
          model: "google/gemini-3-flash",
          modelFallback: "openai/gpt-5-mini",
          thinking: "high",
          timeoutMs: 600000,
          triggers: {
            skillCandidate: { enabled: false, toolCalls: 0 },
            processGap: { toolFailures: 500 },
            successfulPattern: {
              toolCalls: 0,
              keywords: ["ship it", "ship it"],
            },
            satisfactionCheck: { everyTurns: 3 },
            missingIntent: { enabled: false },
            weakIntent: { confidenceBelow: 2 },
            behaviorFix: { enabled: false, keywords: [] },
            entityContext: { enabled: false, keywords: ["看一下"] },
          },
        },
      });

      expect(result.evolution).toMatchObject({
        enabled: true,
        model: "google/gemini-3-flash",
        modelFallback: "openai/gpt-5-mini",
        thinking: "high",
        timeoutMs: 600000,
        triggers: {
          skillCandidate: { enabled: false, toolCalls: 1 },
          processGap: { enabled: true, toolFailures: 100 },
          successfulPattern: {
            enabled: true,
            toolCalls: 1,
            keywords: ["ship it", "ship it"],
          },
          satisfactionCheck: { enabled: true, everyTurns: 3 },
          missingIntent: { enabled: false },
          weakIntent: { enabled: true, confidenceBelow: 1 },
          behaviorFix: { enabled: false, keywords: [] },
          entityContext: { enabled: false, keywords: ["看一下"] },
        },
      });
    });

    it("falls back for invalid classifier, instruction, and review thinking levels", () => {
      const result = resolveConfig({
        thinking: "invalid",
        instruction: { thinking: "invalid" },
        evolution: { thinking: "invalid" },
      });

      expect(result.thinking).toBe("medium");
      expect(result.instruction.thinking).toBe("medium");
      expect(result.evolution.thinking).toBe("medium");
    });

    it("defaults low thinking mode to deterministic fastpath only", () => {
      const result = resolveConfig({});

      expect(result.lowThinkingMode).toBe("fastpath-only");
    });

    it("accepts low thinking mode values and falls back on invalid values", () => {
      expect(resolveConfig({ lowThinkingMode: "full" }).lowThinkingMode).toBe(
        "full",
      );
      expect(resolveConfig({ lowThinkingMode: "off" }).lowThinkingMode).toBe(
        "off",
      );
      expect(
        resolveConfig({ lowThinkingMode: "fastpath-only" }).lowThinkingMode,
      ).toBe("fastpath-only");
      expect(
        resolveConfig({ lowThinkingMode: "invalid" }).lowThinkingMode,
      ).toBe("fastpath-only");
    });
  });

  describe("instruction", () => {
    it("parses and clamps instruction-writer settings without triggers", () => {
      const result = resolveConfig({
        instruction: {
          enabled: true,
          model: "google/gemini-3-flash",
          modelFallback: "openai/gpt-5-mini",
          thinking: "high",
          timeoutMs: 700000,
          triggers: { ignored: true },
        },
      });

      expect(result.instruction).toMatchObject({
        enabled: true,
        model: "google/gemini-3-flash",
        modelFallback: "openai/gpt-5-mini",
        thinking: "high",
        timeoutMs: 600000,
      });
      expect(result.instruction).not.toHaveProperty("triggers");
    });
  });

  describe("enum validation", () => {
    it("should accept valid queryMode values", () => {
      const messageResult = resolveConfig({ queryMode: "message" });
      expect(messageResult.queryMode).toBe("message");

      const recentResult = resolveConfig({ queryMode: "recent" });
      expect(recentResult.queryMode).toBe("recent");

      const fullResult = resolveConfig({ queryMode: "full" });
      expect(fullResult.queryMode).toBe("full");
    });

    it("should fall back to default for invalid queryMode", () => {
      const result = resolveConfig({ queryMode: "invalid" });
      expect(result.queryMode).toBe(DEFAULT_QUERY_MODE);
    });

    it("should use default when queryMode is undefined", () => {
      const result = resolveConfig({});
      expect(result.queryMode).toBe(DEFAULT_QUERY_MODE);
    });
  });

  describe("complex structure - intentDeny map", () => {
    it("should parse intentDeny with valid structure", () => {
      const result = resolveConfig({
        intentDeny: {
          agent1: ["pattern1", "pattern2"],
          agent2: ["pattern3"],
        },
      });
      expect(result.intentDeny).toEqual({
        agent1: ["pattern1", "pattern2"],
        agent2: ["pattern3"],
      });
    });

    it("should filter out empty patterns in intentDeny", () => {
      const result = resolveConfig({
        intentDeny: {
          agent1: ["pattern1", "", "  ", "pattern2"],
          agent2: [],
        },
      });
      expect(result.intentDeny).toEqual({
        agent1: ["pattern1", "pattern2"],
      });
    });

    it("should trim keys in intentDeny", () => {
      const result = resolveConfig({
        intentDeny: {
          "  agent1  ": ["pattern1"],
        },
      });
      expect(result.intentDeny).toHaveProperty("agent1");
      expect(result.intentDeny).not.toHaveProperty("  agent1  ");
    });

    it("should return empty object for non-object intentDeny", () => {
      const result = resolveConfig({ intentDeny: "invalid" });
      expect(result.intentDeny).toEqual({});
    });

    it("should return empty object for array intentDeny", () => {
      const result = resolveConfig({ intentDeny: ["invalid"] });
      expect(result.intentDeny).toEqual({});
    });
  });

  describe("clampInt behavior", () => {
    it("should clamp timeoutMs within bounds (250-120000)", () => {
      const lowResult = resolveConfig({ timeoutMs: 100 });
      expect(lowResult.timeoutMs).toBe(250);

      const highResult = resolveConfig({ timeoutMs: 200000 });
      expect(highResult.timeoutMs).toBe(120000);

      const validResult = resolveConfig({ timeoutMs: 5000 });
      expect(validResult.timeoutMs).toBe(5000);
    });

    it("should clamp contextWindow.user.turns within bounds (0-20)", () => {
      const lowResult = resolveConfig({
        contextWindow: { user: { turns: -5 }, assistant: {} } as never,
      });
      expect(lowResult.contextWindow.user.turns).toBe(0);

      const highResult = resolveConfig({
        contextWindow: { user: { turns: 50 }, assistant: {} } as never,
      });
      expect(highResult.contextWindow.user.turns).toBe(20);

      const validResult = resolveConfig({
        contextWindow: { user: { turns: 10 }, assistant: {} } as never,
      });
      expect(validResult.contextWindow.user.turns).toBe(10);
    });

    it("should clamp contextWindow.assistant.turns within bounds (0-10)", () => {
      const lowResult = resolveConfig({
        contextWindow: { user: {}, assistant: { turns: -1 } } as never,
      });
      expect(lowResult.contextWindow.assistant.turns).toBe(0);

      const highResult = resolveConfig({
        contextWindow: { user: {}, assistant: { turns: 20 } } as never,
      });
      expect(highResult.contextWindow.assistant.turns).toBe(10);

      const validResult = resolveConfig({
        contextWindow: { user: {}, assistant: { turns: 5 } } as never,
      });
      expect(validResult.contextWindow.assistant.turns).toBe(5);
    });

    it("should clamp contextWindow.user.chars within bounds (40-1000)", () => {
      const lowResult = resolveConfig({
        contextWindow: { user: { chars: 10 }, assistant: {} } as never,
      });
      expect(lowResult.contextWindow.user.chars).toBe(40);

      const highResult = resolveConfig({
        contextWindow: { user: { chars: 5000 }, assistant: {} } as never,
      });
      expect(highResult.contextWindow.user.chars).toBe(1000);

      const validResult = resolveConfig({
        contextWindow: { user: { chars: 500 }, assistant: {} } as never,
      });
      expect(validResult.contextWindow.user.chars).toBe(500);
    });

    it("should clamp contextWindow.assistant.chars within bounds (40-1000)", () => {
      const lowResult = resolveConfig({
        contextWindow: { user: {}, assistant: { chars: 20 } } as never,
      });
      expect(lowResult.contextWindow.assistant.chars).toBe(40);

      const highResult = resolveConfig({
        contextWindow: { user: {}, assistant: { chars: 2000 } } as never,
      });
      expect(highResult.contextWindow.assistant.chars).toBe(1000);

      const validResult = resolveConfig({
        contextWindow: { user: {}, assistant: { chars: 300 } } as never,
      });
      expect(validResult.contextWindow.assistant.chars).toBe(300);
    });

    it("should use default for NaN values", () => {
      const result = resolveConfig({ timeoutMs: NaN });
      expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("should use default for undefined numeric values", () => {
      const result = resolveConfig({ timeoutMs: undefined });
      expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("should use default for invalid primitive numeric values", () => {
      const result = resolveConfig({
        timeoutMs: "5000",
        contextWindow: {
          user: { turns: "3", chars: false },
          assistant: { turns: {}, chars: [] },
        },
      });
      expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.contextWindow.user.turns).toBe(DEFAULT_RECENT_USER_TURNS);
      expect(result.contextWindow.user.chars).toBe(DEFAULT_RECENT_USER_CHARS);
      expect(result.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(result.contextWindow.assistant.chars).toBe(
        DEFAULT_RECENT_ASSISTANT_CHARS,
      );
    });
  });

  describe("string array fields", () => {
    it("should parse agents as string array", () => {
      const result = resolveConfig({ agents: ["agent1", "agent2"] });
      expect(result.agents).toEqual(["agent1", "agent2"]);
    });

    it("should trim and filter empty strings in agents", () => {
      const result = resolveConfig({
        agents: ["  agent1  ", "", "  ", "agent2"],
      });
      expect(result.agents).toEqual(["agent1", "agent2"]);
    });

    it("should convert single string to array", () => {
      const result = resolveConfig({ agents: "singleAgent" });
      expect(result.agents).toEqual(["singleAgent"]);
    });

    it("should use default for empty agents array", () => {
      const result = resolveConfig({ agents: [] });
      expect(result.agents).toEqual(["main"]);
    });

    it("should parse allowedChatIds as string array", () => {
      const result = resolveConfig({ allowedChatIds: ["id1", "id2"] });
      expect(result.allowedChatIds).toEqual(["id1", "id2"]);
    });

    it("should parse deniedChatIds as string array", () => {
      const result = resolveConfig({ deniedChatIds: ["id1", "id2"] });
      expect(result.deniedChatIds).toEqual(["id1", "id2"]);
    });

    it("should parse allowedChatTypes as string array", () => {
      const result = resolveConfig({ allowedChatTypes: ["direct", "group"] });
      expect(result.allowedChatTypes).toEqual(["direct", "group"]);
    });

    it("should fall back for invalid primitive string and array fields", () => {
      const result = resolveConfig({
        agents: 123,
        allowedChatTypes: false,
        allowedChatIds: {},
        deniedChatIds: 0,
        model: {},
        modelFallback: [],
      });
      expect(result.agents).toEqual(["main"]);
      expect(result.allowedChatTypes).toEqual(["direct"]);
      expect(result.allowedChatIds).toEqual([]);
      expect(result.deniedChatIds).toEqual([]);
      expect(result.model).toBeUndefined();
      expect(result.modelFallback).toBeUndefined();
    });
  });

  describe("complexityPrompts", () => {
    it("should use default prompts when not provided", () => {
      const result = resolveConfig({});
      expect(result.complexityPrompts.low).toBe(DEFAULT_LOW_COMPLEXITY_PROMPT);
      expect(result.complexityPrompts.low).toContain(
        "frame it as optional guidance with concrete boundaries and expected output",
      );
      expect(result.complexityPrompts.low).not.toContain(
        "MUST DO / MUST NOT DO",
      );
      expect(result.complexityPrompts.medium).toBe(
        DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
      );
      expect(result.complexityPrompts.high).toBe(
        DEFAULT_HIGH_COMPLEXITY_PROMPT,
      );
    });

    it("should parse custom complexity prompts", () => {
      const result = resolveConfig({
        complexityPrompts: {
          low: "Custom low prompt",
          medium: "Custom medium prompt",
          high: "Custom high prompt",
        },
      });
      expect(result.complexityPrompts.low).toBe("Custom low prompt");
      expect(result.complexityPrompts.medium).toBe("Custom medium prompt");
      expect(result.complexityPrompts.high).toBe("Custom high prompt");
    });

    it("should use default for empty or whitespace-only prompts", () => {
      const result = resolveConfig({
        complexityPrompts: {
          low: "",
          medium: "   ",
          high: "Valid prompt",
        },
      });
      expect(result.complexityPrompts.low).toBe(DEFAULT_LOW_COMPLEXITY_PROMPT);
      expect(result.complexityPrompts.medium).toBe(
        DEFAULT_MEDIUM_COMPLEXITY_PROMPT,
      );
      expect(result.complexityPrompts.high).toBe("Valid prompt");
    });

    it("should support missing nested config and partial overrides", () => {
      const emptyNested = resolveConfig({
        contextWindow: {},
        complexityPrompts: {},
      });
      expect(emptyNested.contextWindow.user.turns).toBe(
        DEFAULT_RECENT_USER_TURNS,
      );
      expect(emptyNested.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(emptyNested.complexityPrompts.low).toBe(
        DEFAULT_LOW_COMPLEXITY_PROMPT,
      );

      const partial = resolveConfig({
        contextWindow: { user: { turns: 7 } },
        complexityPrompts: { medium: "Custom medium only" },
      } as never);
      expect(partial.contextWindow.user.turns).toBe(7);
      expect(partial.contextWindow.user.chars).toBe(DEFAULT_RECENT_USER_CHARS);
      expect(partial.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(partial.complexityPrompts.low).toBe(DEFAULT_LOW_COMPLEXITY_PROMPT);
      expect(partial.complexityPrompts.medium).toBe("Custom medium only");
      expect(partial.complexityPrompts.high).toBe(
        DEFAULT_HIGH_COMPLEXITY_PROMPT,
      );
    });
  });

  describe("optional fields", () => {
    it("should handle optional model field", () => {
      const withModel = resolveConfig({ model: "gpt-4" });
      expect(withModel.model).toBe("gpt-4");

      const withoutModel = resolveConfig({});
      expect(withoutModel.model).toBeUndefined();
    });

    it("should handle optional modelFallback field", () => {
      const withFallback = resolveConfig({ modelFallback: "gpt-3.5" });
      expect(withFallback.modelFallback).toBe("gpt-3.5");

      const withoutFallback = resolveConfig({});
      expect(withoutFallback.modelFallback).toBeUndefined();
    });
  });
});

describe("clampInt", () => {
  it("should return fallback for undefined", () => {
    expect(clampInt(undefined, 10, 0, 100)).toBe(10);
  });

  it("should return fallback for NaN", () => {
    expect(clampInt(NaN, 10, 0, 100)).toBe(10);
  });

  it("should clamp to minimum", () => {
    expect(clampInt(-10, 50, 0, 100)).toBe(0);
  });

  it("should clamp to maximum", () => {
    expect(clampInt(150, 50, 0, 100)).toBe(100);
  });

  it("should floor decimal values", () => {
    expect(clampInt(50.7, 10, 0, 100)).toBe(50);
    expect(clampInt(50.2, 10, 0, 100)).toBe(50);
  });

  it("should return value when within bounds", () => {
    expect(clampInt(50, 10, 0, 100)).toBe(50);
  });
});
