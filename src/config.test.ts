import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { resolveConfig, clampInt } from "./config.js";
import {
  DEFAULT_QUERY_MODE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
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
      expect(result.review).toMatchObject({
        enabled: false,
        model: undefined,
        modelFallback: undefined,
        thinking: "medium",
        timeoutSeconds: 300,
        triggers: {
          skillCandidate: { enabled: true, toolCalls: 5 },
          skillPlacement: { enabled: true },
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
        keywordCoverage: { everyAcceptedTurns: 50 },
      });
      expect(result).not.toHaveProperty("instruction");
    });

    it("should handle empty object loading", () => {
      const result = resolveConfig({});
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
        expect(result.queryMode).toBe(DEFAULT_QUERY_MODE);
        expect(result.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      }
    });
  });

  describe("QMD routing", () => {
    it("resolves default routing thresholds when routing is omitted", () => {
      expect(resolveConfig({}).routing).toEqual({
        sameTopic: { minConfidence: 0.8 },
        qmd: {
          minTopicConfidence: 0.8,
          directRouteMinScore: 0.85,
          smallCandidateMinScore: 0.65,
          minCandidateScore: 0.35,
        },
      });
    });

    it("accepts independent same-topic and QMD routing thresholds", () => {
      expect(
        resolveConfig({
          routing: {
            sameTopic: { minConfidence: 0.9 },
            qmd: {
              minTopicConfidence: 0.7,
              directRouteMinScore: 0.9,
              smallCandidateMinScore: 0.6,
              minCandidateScore: 0.2,
            },
          },
        }).routing,
      ).toEqual({
        sameTopic: { minConfidence: 0.9 },
        qmd: {
          minTopicConfidence: 0.7,
          directRouteMinScore: 0.9,
          smallCandidateMinScore: 0.6,
          minCandidateScore: 0.2,
        },
      });
    });

    it("rejects out-of-range and non-monotonic routing thresholds", () => {
      expect(() =>
        resolveConfig({ routing: { sameTopic: { minConfidence: 1.1 } } }),
      ).toThrow();
      expect(() => resolveConfig({ routing: null })).toThrow();
      expect(() =>
        resolveConfig({
          routing: {
            qmd: {
              directRouteMinScore: 0.6,
              smallCandidateMinScore: 0.7,
            },
          },
        }),
      ).toThrow();
    });

    it("documents mandatory QMD configuration before Quick Start enables the plugin", () => {
      const manifest = JSON.parse(
        readFileSync(
          new URL("../openclaw.plugin.json", import.meta.url),
          "utf8",
        ),
      ) as {
        configSchema: {
          required?: string[];
          properties: {
            qmd: {
              required?: string[];
              properties: Record<string, { required?: string[] }>;
            };
            routing?: {
              properties: {
                sameTopic: {
                  properties: {
                    minConfidence: { default?: number };
                  };
                };
                qmd: {
                  properties: Record<string, { default?: number }>;
                };
              };
            };
          };
        };
      };
      const readme = readFileSync(
        new URL("../README.md", import.meta.url),
        "utf8",
      );
      const quickStartEnd = readme.indexOf("\n## What it solves");
      const quickStart = readme.slice(0, quickStartEnd);

      expect(manifest.configSchema.required).toContain("qmd");
      expect(manifest.configSchema.properties.qmd.required).toEqual([
        "embedding",
        "expansion",
      ]);
      expect(
        manifest.configSchema.properties.qmd.properties,
      ).not.toHaveProperty("rerank");
      expect(
        manifest.configSchema.properties.routing?.properties.sameTopic
          .properties.minConfidence.default,
      ).toBe(0.8);
      expect(
        manifest.configSchema.properties.routing?.properties.qmd.properties
          .directRouteMinScore.default,
      ).toBe(0.85);
      for (const endpoint of ["embedding", "expansion"]) {
        expect(
          manifest.configSchema.properties.qmd.properties[endpoint]?.required,
        ).toEqual(["baseUrl", "model"]);
      }
      expect(quickStart).toContain("qmd: {");
      expect(quickStart.indexOf("qmd: {")).toBeLessThan(
        quickStart.indexOf("openclaw plugins doctor"),
      );
      expect(readme).toContain(
        "### Upgrade from the removed instruction writer to mandatory QMD routing",
      );
    });

    it("uses the scanner timeout by default and accepts inline remote credentials", () => {
      const result = resolveConfig({
        timeoutMs: 8_000,
        qmd: {
          embedding: {
            baseUrl: "https://embedding.example.test/v1",
            model: "embedding-model",
            apiKey: "embedding-key",
            dimension: 768,
          },
          expansion: {
            baseUrl: "https://llm.example.test/v1",
            model: "expand-model",
            apiKey: "expand-key",
          },
        },
      });

      expect(result.qmd).toEqual({
        timeoutMs: 8_000,
        indexRefreshIntervalSeconds: 300,
        embedding: {
          baseUrl: "https://embedding.example.test/v1",
          model: "embedding-model",
          apiKey: "embedding-key",
          dimension: 768,
        },
        expansion: {
          baseUrl: "https://llm.example.test/v1",
          model: "expand-model",
          apiKey: "expand-key",
        },
        skillSearch: {
          collectionWeights: { meta: 1, body: 1, references: 1 },
        },
      });
    });

    it("resolves default skillSearch weights and index refresh interval", () => {
      const manifest = JSON.parse(
        readFileSync(
          new URL("../openclaw.plugin.json", import.meta.url),
          "utf8",
        ),
      ) as {
        configSchema: {
          properties: {
            qmd: {
              properties: {
                indexRefreshIntervalSeconds: { default?: number };
                skillSearch?: {
                  properties: {
                    collectionWeights?: {
                      properties: {
                        meta: { default?: number };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
      expect(resolveConfig({}).qmd.skillSearch).toEqual({
        collectionWeights: { meta: 1, body: 1, references: 1 },
      });
      expect(resolveConfig({}).qmd.indexRefreshIntervalSeconds).toBe(300);
      expect(
        manifest.configSchema.properties.qmd.properties
          .indexRefreshIntervalSeconds.default,
      ).toBe(300);
      expect(
        manifest.configSchema.properties.qmd.properties.skillSearch?.properties
          .collectionWeights?.properties.meta.default,
      ).toBe(1);
    });

    it("accepts custom skillSearch collection weights", () => {
      expect(
        resolveConfig({
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
            },
            skillSearch: {
              collectionWeights: { meta: 2, body: 1.5, references: 0.5 },
            },
          },
        }).qmd.skillSearch,
      ).toEqual({
        collectionWeights: { meta: 2, body: 1.5, references: 0.5 },
      });
    });

    it("rejects non-positive skillSearch collection weights", () => {
      expect(() =>
        resolveConfig({
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
            },
            skillSearch: {
              collectionWeights: { meta: 0 },
            },
          },
        }),
      ).toThrow();
      expect(() =>
        resolveConfig({
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
            },
            skillSearch: {
              collectionWeights: { references: -1 },
            },
          },
        }),
      ).toThrow();
    });
  });

  describe("review", () => {
    it("parses and clamps review and trigger settings", () => {
      const result = resolveConfig({
        review: {
          enabled: true,
          model: "google/gemini-3-flash",
          modelFallback: "openai/gpt-5-mini",
          thinking: "high",
          timeoutSeconds: 600,
          triggers: {
            skillCandidate: { enabled: false, toolCalls: 0 },
            skillPlacement: { enabled: false },
            processGap: { toolFailures: 500 },
            successfulPattern: {
              toolCalls: 0,
            },
            satisfactionCheck: { everyTurns: 3 },
            missingIntent: { enabled: false },
            weakIntent: { confidenceBelow: 2 },
            behaviorFix: { enabled: false },
            entityContext: { enabled: false },
          },
        },
      });

      expect(result.review).toMatchObject({
        enabled: true,
        model: "google/gemini-3-flash",
        modelFallback: "openai/gpt-5-mini",
        thinking: "high",
        timeoutSeconds: 600,
        triggers: {
          skillCandidate: { enabled: false, toolCalls: 1 },
          skillPlacement: { enabled: false },
          processGap: { enabled: true, toolFailures: 100 },
          successfulPattern: {
            enabled: true,
            toolCalls: 1,
          },
          satisfactionCheck: { enabled: true, everyTurns: 3 },
          missingIntent: { enabled: false },
          weakIntent: { enabled: true, confidenceBelow: 1 },
          behaviorFix: { enabled: false },
          entityContext: { enabled: false },
        },
      });
    });

    it("ignores removed legacy review trigger keyword seeds", () => {
      const result = resolveConfig({
        review: {
          triggers: {
            successfulPattern: { keywords: ["ship it"] },
            behaviorFix: { keywords: ["wrong"] },
            entityContext: { keywords: ["看一下"] },
          },
        },
      });

      expect(result.review.triggers.successfulPattern).not.toHaveProperty(
        "keywords",
      );
      expect(result.review.triggers.behaviorFix).not.toHaveProperty("keywords");
      expect(result.review.triggers.entityContext).not.toHaveProperty(
        "keywords",
      );
    });

    it("clamps keyword coverage cadence without adding a coverage enable flag", () => {
      expect(
        resolveConfig({
          review: { keywordCoverage: { everyAcceptedTurns: 0 } },
        }).review.keywordCoverage.everyAcceptedTurns,
      ).toBe(10);
      expect(
        resolveConfig({
          review: { keywordCoverage: { everyAcceptedTurns: 5_000 } },
        }).review.keywordCoverage.everyAcceptedTurns,
      ).toBe(1_000);
      expect(resolveConfig({ review: {} }).review.keywordCoverage).toEqual({
        everyAcceptedTurns: 50,
      });
    });

    it("falls back for invalid classifier and review thinking levels", () => {
      const result = resolveConfig({
        thinking: "invalid",
        review: { thinking: "invalid" },
      });

      expect(result.thinking).toBe("medium");
      expect(result.review.thinking).toBe("medium");
    });

    it("ignores legacy evolution config after the review rename", () => {
      const result = resolveConfig({
        evolution: { enabled: true, model: "legacy/model" },
      });

      expect(result.review.enabled).toBe(false);
      expect(result.review.model).toBeUndefined();
      expect(result).not.toHaveProperty("evolution");
    });

    it("defaults low-effort routing mode to deterministic fastpath only", () => {
      const result = resolveConfig({});

      expect(result.lowEffortRoutingMode).toBe("fastpath-only");
    });

    it("accepts low-effort routing mode values and falls back on invalid values", () => {
      expect(
        resolveConfig({ lowEffortRoutingMode: "full" }).lowEffortRoutingMode,
      ).toBe("full");
      expect(
        resolveConfig({ lowEffortRoutingMode: "off" }).lowEffortRoutingMode,
      ).toBe("off");
      expect(
        resolveConfig({ lowEffortRoutingMode: "fastpath-only" })
          .lowEffortRoutingMode,
      ).toBe("fastpath-only");
      expect(
        resolveConfig({ lowEffortRoutingMode: "invalid" }).lowEffortRoutingMode,
      ).toBe("fastpath-only");
    });

    it("ignores the retired lowThinkingMode setting", () => {
      expect(resolveConfig({ lowThinkingMode: "full" })).toMatchObject({
        lowEffortRoutingMode: "fastpath-only",
      });
    });
  });

  describe("removed instruction writer configuration", () => {
    it("ignores instruction settings instead of hydrating a public writer config", () => {
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

      expect(result).not.toHaveProperty("instruction");
    });
  });

  describe("curation", () => {
    it("defaults to an enabled independent curator configuration", () => {
      expect(resolveConfig({}).curation).toEqual({
        enabled: true,
        model: undefined,
        modelFallback: undefined,
        thinking: "medium",
        timeoutSeconds: 30,
      });
      expect(
        resolveConfig({ review: { enabled: false } }).curation.enabled,
      ).toBe(true);
    });

    it("parses curator model settings and clamps its timeout", () => {
      expect(
        resolveConfig({
          curation: {
            enabled: false,
            model: "google/curator",
            modelFallback: "openai/fallback",
            thinking: "high",
            timeoutSeconds: 0,
          },
        }).curation,
      ).toEqual({
        enabled: false,
        model: "google/curator",
        modelFallback: "openai/fallback",
        thinking: "high",
        timeoutSeconds: 10,
      });
      expect(
        resolveConfig({ curation: { timeoutSeconds: 700 } }).curation
          .timeoutSeconds,
      ).toBe(600);
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

  describe("retired configuration", () => {
    it("ignores intentDeny", () => {
      expect(
        resolveConfig({ intentDeny: { main: ["chat"] } }),
      ).not.toHaveProperty("intentDeny");
    });

    it("ignores nested timeoutMs settings", () => {
      const result = resolveConfig({
        curation: { timeoutMs: 1 },
        review: { timeoutMs: 1 },
      });

      expect(result.curation.timeoutSeconds).toBe(30);
      expect(result.review.timeoutSeconds).toBe(300);
    });
  });

  describe("clampInt behavior", () => {
    it("should clamp timeoutMs within bounds (1000-60000)", () => {
      const lowResult = resolveConfig({ timeoutMs: 100 });
      expect(lowResult.timeoutMs).toBe(1_000);

      const highResult = resolveConfig({ timeoutMs: 200000 });
      expect(highResult.timeoutMs).toBe(60_000);

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

  describe("removed settings", () => {
    it("should ignore the removed complexityPrompts setting", () => {
      const result = resolveConfig({
        complexityPrompts: {
          low: "Custom low prompt",
          medium: "Custom medium prompt",
          high: "Custom high prompt",
        },
      });

      expect(result).not.toHaveProperty("complexityPrompts");
    });
  });

  describe("contextWindow partial overrides", () => {
    it("should support missing nested config and partial overrides", () => {
      const emptyNested = resolveConfig({ contextWindow: {} });
      expect(emptyNested.contextWindow.user.turns).toBe(
        DEFAULT_RECENT_USER_TURNS,
      );
      expect(emptyNested.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );

      const partial = resolveConfig({
        contextWindow: { user: { turns: 7 } },
      } as never);
      expect(partial.contextWindow.user.turns).toBe(7);
      expect(partial.contextWindow.user.chars).toBe(DEFAULT_RECENT_USER_CHARS);
      expect(partial.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
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
