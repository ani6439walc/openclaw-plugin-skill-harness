import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { resolveConfig, clampInt } from "./config.js";
import type { OpenClawConfig } from "../api.js";
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
    it("declares the working-set manifest contract with no configured default", () => {
      const manifest = JSON.parse(
        readFileSync(
          new URL("../openclaw.plugin.json", import.meta.url),
          "utf8",
        ),
      ) as {
        configSchema: {
          properties: Record<string, unknown>;
        };
      };

      expect(manifest.configSchema.properties.workingSetSkills).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          defaults: { type: "array", items: { type: "string" } },
          agents: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
          includeWorkspaceSkills: {
            type: "boolean",
            default: true,
          },
          autoLoadWorkspaceSkills: {
            type: "boolean",
            default: true,
          },
          includeWorkshopSkills: {
            type: "boolean",
            default: true,
          },
          autoLoadWorkshopSkills: {
            type: "boolean",
            default: true,
          },
        },
      });
      expect(resolveConfig({}).skills.search.collectionWeights).toEqual({
        meta: 1,
        body: 1,
        references: 1,
      });
    });

    it("should use default values for empty config", () => {
      const result = resolveConfig({});
      expect(result.scope.agents).toEqual(["main"]);
      expect(result.scope.chatTypes).toEqual(["direct"]);
      expect(result.scope.allowedChatIds).toEqual([]);
      expect(result.scope.deniedChatIds).toEqual([]);

      expect(result.routing.thresholds).toEqual({
        directRouteMinScore: 0.85,
        minCandidateScore: 0.35,
      });

      expect(result.routing.classifier.queryMode).toBe(DEFAULT_QUERY_MODE);
      expect(result.routing.classifier.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.routing.classifier.thinking).toBe("medium");
      expect(result.routing.classifier.model).toBeUndefined();
      expect(result.routing.classifier.modelFallback).toBeUndefined();
      expect(result.routing.classifier.contextWindow.user.turns).toBe(
        DEFAULT_RECENT_USER_TURNS,
      );
      expect(result.routing.classifier.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(result.routing.classifier.contextWindow.user.chars).toBe(
        DEFAULT_RECENT_USER_CHARS,
      );
      expect(result.routing.classifier.contextWindow.assistant.chars).toBe(
        DEFAULT_RECENT_ASSISTANT_CHARS,
      );

      expect(result.skills.search.collectionWeights).toEqual({
        meta: 1,
        body: 1,
        references: 1,
      });

      expect(result.qmd.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.qmd.indexRefreshIntervalSeconds).toBe(300);
      expect(result.qmd.embedding).toEqual({
        baseUrl: "",
        model: "",
        dimension: 1536,
      });
      expect(result.qmd.expansion).toEqual({
        baseUrl: "",
        model: "",
      });

      expect(result.review).toMatchObject({
        enabled: false,
        model: undefined,
        modelFallback: undefined,
        thinking: "medium",
        timeoutSeconds: 300,
        triggers: {
          intentHealthCheck: { enabled: true, everyTurns: 10 },
          routingUncertainty: { enabled: true, confidenceBelow: 0.5 },
          capabilityFit: { enabled: true, toolCalls: 5, toolFailures: 2 },
        },
      });

      expect(result).not.toHaveProperty("agents");
      expect(result).not.toHaveProperty("allowedChatTypes");
      expect(result).not.toHaveProperty("model");
      expect(result).not.toHaveProperty("instruction");
    });

    it("should handle empty object loading", () => {
      const result = resolveConfig({});
      expect(result.scope.allowedChatIds).toEqual([]);
      expect(result.scope.deniedChatIds).toEqual([]);
      expect(result.routing.classifier.model).toBeUndefined();
      expect(result.routing.classifier.modelFallback).toBeUndefined();
    });

    it("should use default values for non-object config", () => {
      for (const raw of [undefined, null, "invalid", []]) {
        const result = resolveConfig(raw);
        expect(result.scope.agents).toEqual(["main"]);
        expect(result.scope.chatTypes).toEqual(["direct"]);
        expect(result.routing.classifier.queryMode).toBe(DEFAULT_QUERY_MODE);
        expect(result.routing.classifier.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      }
    });
  });

  describe("workingSetSkills", () => {
    it("canonicalizes agent and skill names and resolves agent-specific names before defaults", () => {
      const result = resolveConfig({
        workingSetSkills: {
          defaults: [" Shared ", "general", "Ｓｈａｒｅｄ"],
          agents: {
            " Writer ": [" Draft ", "shared", "DRAFT"],
          },
        },
      });

      expect(result.workingSetSkills).toEqual({
        defaults: ["shared", "general"],
        agents: { writer: ["draft", "shared", "general"] },
        includeWorkspaceSkills: true,
        includeWorkshopSkills: true,
      });
    });

    it("resolves includeWorkspaceSkills with default true and respects boolean setting or alias", () => {
      expect(resolveConfig({}).workingSetSkills.includeWorkspaceSkills).toBe(
        true,
      );
      expect(
        resolveConfig({
          workingSetSkills: { includeWorkspaceSkills: false },
        }).workingSetSkills.includeWorkspaceSkills,
      ).toBe(false);
      expect(
        resolveConfig({
          workingSetSkills: { autoLoadWorkspaceSkills: false },
        }).workingSetSkills.includeWorkspaceSkills,
      ).toBe(false);
    });

    it("resolves includeWorkshopSkills with default true and respects boolean setting or alias", () => {
      expect(resolveConfig({}).workingSetSkills.includeWorkshopSkills).toBe(
        true,
      );
      expect(
        resolveConfig({
          workingSetSkills: { includeWorkshopSkills: false },
        }).workingSetSkills.includeWorkshopSkills,
      ).toBe(false);
      expect(
        resolveConfig({
          workingSetSkills: { autoLoadWorkshopSkills: false },
        }).workingSetSkills.includeWorkshopSkills,
      ).toBe(false);
    });

    it("rejects malformed working-set objects and colliding canonical agent IDs", () => {
      expect(() =>
        resolveConfig({ workingSetSkills: { agents: [] } }),
      ).toThrow();
      expect(() =>
        resolveConfig({ workingSetSkills: { unexpected: [] } }),
      ).toThrow();
      expect(() =>
        resolveConfig({
          workingSetSkills: {
            agents: { Writer: ["draft"], " writer ": ["review"] },
          },
        }),
      ).toThrow();
    });

    it.each([
      { defaults: ["shared", 42] },
      { agents: { writer: ["draft", false] } },
    ])("rejects malformed working-set list members", (workingSetSkills) => {
      expect(() => resolveConfig({ workingSetSkills })).toThrow();
    });
  });

  describe("routing & thresholds", () => {
    it("resolves default routing thresholds when routing is omitted", () => {
      expect(resolveConfig({}).routing.thresholds).toEqual({
        directRouteMinScore: 0.85,
        minCandidateScore: 0.35,
      });
    });

    it("accepts independent routing thresholds", () => {
      expect(
        resolveConfig({
          routing: {
            thresholds: {
              directRouteMinScore: 0.9,
              minCandidateScore: 0.2,
            },
          },
        }).routing.thresholds,
      ).toEqual({
        directRouteMinScore: 0.9,
        minCandidateScore: 0.2,
      });
    });

    it("rejects out-of-range and non-monotonic routing thresholds", () => {
      expect(() => resolveConfig({ routing: null })).toThrow();
      expect(() =>
        resolveConfig({
          routing: {
            thresholds: {
              directRouteMinScore: 0.3,
              minCandidateScore: 0.7,
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
                thresholds: {
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
        manifest.configSchema.properties.routing?.properties.thresholds
          .properties.directRouteMinScore.default,
      ).toBe(0.85);
      for (const endpoint of ["embedding", "expansion"]) {
        expect(
          manifest.configSchema.properties.qmd.properties[endpoint]?.required,
        ).toEqual(["model"]);
      }
      expect(quickStart).toContain("qmd: {");
      expect(quickStart.indexOf("qmd: {")).toBeLessThan(
        quickStart.indexOf("openclaw plugins doctor"),
      );
    });

    it("uses the scanner timeout by default and accepts inline remote credentials", () => {
      const result = resolveConfig({
        routing: {
          classifier: {
            timeoutMs: 8_000,
          },
        },
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
      });
    });

    it("resolves baseUrl and apiKey dynamically from OpenClaw provider config when omitted", () => {
      const mockOpenClawConfig = {
        models: {
          providers: {
            bifrost: {
              baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
              apiKey: "bifrost-key-123",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveConfig(
        {
          qmd: {
            embedding: {
              model: "bifrost/text-embedding-3-small",
            },
            expansion: {
              model: "bifrost/gpt-4o-mini",
            },
          },
        },
        { openClawConfig: mockOpenClawConfig },
      );

      expect(result.qmd.embedding).toEqual({
        baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
        model: "text-embedding-3-small",
        apiKey: "bifrost-key-123",
        dimension: 1536,
      });
      expect(result.qmd.expansion).toEqual({
        baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
        model: "gpt-4o-mini",
        apiKey: "bifrost-key-123",
      });
    });

    it("preserves explicit dimension override for embedding", () => {
      const result = resolveConfig({
        qmd: {
          embedding: {
            baseUrl: "https://example.com/v1",
            model: "custom-embed",
            dimension: 768,
          },
          expansion: {
            baseUrl: "https://example.com/v1",
            model: "custom-expand",
          },
        },
      });

      expect(result.qmd.embedding.dimension).toBe(768);
    });

    it("resolves default skills.search weights and index refresh interval", () => {
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
                embedding?: {
                  properties: {
                    dimension?: { default?: number };
                  };
                };
              };
            };
            skills?: {
              properties: {
                search?: {
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
      expect(resolveConfig({}).skills.search).toEqual({
        collectionWeights: { meta: 1, body: 1, references: 1 },
      });
      expect(resolveConfig({}).qmd.indexRefreshIntervalSeconds).toBe(300);
      expect(resolveConfig({}).qmd.embedding.dimension).toBe(1536);
      expect(
        manifest.configSchema.properties.qmd.properties.embedding?.properties
          .dimension?.default,
      ).toBe(1536);
      expect(
        manifest.configSchema.properties.qmd.properties
          .indexRefreshIntervalSeconds.default,
      ).toBe(300);
      expect(
        manifest.configSchema.properties.skills?.properties.search?.properties
          .collectionWeights?.properties.meta.default,
      ).toBe(1);
    });

    it("accepts custom skills.search collection weights", () => {
      expect(
        resolveConfig({
          skills: {
            search: {
              collectionWeights: { meta: 2, body: 1.5, references: 0.5 },
            },
          },
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
            },
          },
        }).skills.search,
      ).toEqual({
        collectionWeights: { meta: 2, body: 1.5, references: 0.5 },
      });
    });

    it("rejects non-positive skills.search collection weights", () => {
      expect(() =>
        resolveConfig({
          skills: {
            search: {
              collectionWeights: { meta: 0 },
            },
          },
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
            },
          },
        }),
      ).toThrow();
      expect(() =>
        resolveConfig({
          skills: {
            search: {
              collectionWeights: { references: -1 },
            },
          },
          qmd: {
            embedding: {
              baseUrl: "https://embedding.example.test/v1",
              model: "e",
            },
            expansion: {
              baseUrl: "https://llm.example.test/v1",
              model: "x",
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
            intentHealthCheck: { everyTurns: 0 },
            routingUncertainty: { enabled: false, confidenceBelow: 2 },
            capabilityFit: { enabled: false, toolCalls: 0, toolFailures: 500 },
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
          intentHealthCheck: { enabled: true, everyTurns: 1 },
          routingUncertainty: { enabled: false, confidenceBelow: 1 },
          capabilityFit: { enabled: false, toolCalls: 1, toolFailures: 100 },
        },
      });
    });

    it("drops retired review configuration keys", () => {
      const result = resolveConfig({
        review: {
          keywordCoverage: { everyAcceptedTurns: 50 },
          triggers: {
            successfulPattern: { keywords: ["ship it"] },
            skillPlacement: { enabled: false },
          },
        },
      });

      expect(result.review).not.toHaveProperty("keywordCoverage");
      expect(result.review.triggers).toEqual({
        intentHealthCheck: { enabled: true, everyTurns: 10 },
        routingUncertainty: { enabled: true, confidenceBelow: 0.5 },
        capabilityFit: { enabled: true, toolCalls: 5, toolFailures: 2 },
      });
    });

    it("falls back for invalid classifier and review thinking levels", () => {
      const result = resolveConfig({
        routing: { classifier: { thinking: "invalid" } },
        review: { thinking: "invalid" },
      });

      expect(result.routing.classifier.thinking).toBe("medium");
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

    it("ignores retired lowEffortRoutingMode setting", () => {
      const result = resolveConfig({ lowEffortRoutingMode: "off" });

      expect(result).not.toHaveProperty("lowEffortRoutingMode");
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
    it("ignores removed curation settings", () => {
      expect(resolveConfig({ curation: { enabled: true } })).not.toHaveProperty(
        "curation",
      );
    });
  });

  describe("enum validation", () => {
    it("should accept valid queryMode values", () => {
      const messageResult = resolveConfig({
        routing: { classifier: { queryMode: "message" } },
      });
      expect(messageResult.routing.classifier.queryMode).toBe("message");

      const recentResult = resolveConfig({
        routing: { classifier: { queryMode: "recent" } },
      });
      expect(recentResult.routing.classifier.queryMode).toBe("recent");

      const fullResult = resolveConfig({
        routing: { classifier: { queryMode: "full" } },
      });
      expect(fullResult.routing.classifier.queryMode).toBe("full");
    });

    it("should fall back to default for invalid queryMode", () => {
      const result = resolveConfig({
        routing: { classifier: { queryMode: "invalid" } },
      });
      expect(result.routing.classifier.queryMode).toBe(DEFAULT_QUERY_MODE);
    });

    it("should use default when queryMode is undefined", () => {
      const result = resolveConfig({});
      expect(result.routing.classifier.queryMode).toBe(DEFAULT_QUERY_MODE);
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
        review: { timeoutMs: 1 },
      });

      expect(result.review.timeoutSeconds).toBe(300);
    });
  });

  describe("clampInt behavior", () => {
    it("should clamp classifier timeoutMs within bounds (1000-60000)", () => {
      const lowResult = resolveConfig({
        routing: { classifier: { timeoutMs: 100 } },
      });
      expect(lowResult.routing.classifier.timeoutMs).toBe(1_000);

      const highResult = resolveConfig({
        routing: { classifier: { timeoutMs: 200000 } },
      });
      expect(highResult.routing.classifier.timeoutMs).toBe(60_000);

      const validResult = resolveConfig({
        routing: { classifier: { timeoutMs: 5000 } },
      });
      expect(validResult.routing.classifier.timeoutMs).toBe(5000);
    });

    it("should clamp contextWindow.user.turns within bounds (0-20)", () => {
      const lowResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { turns: -5 }, assistant: {} } as never,
          },
        },
      });
      expect(lowResult.routing.classifier.contextWindow.user.turns).toBe(0);

      const highResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { turns: 50 }, assistant: {} } as never,
          },
        },
      });
      expect(highResult.routing.classifier.contextWindow.user.turns).toBe(20);

      const validResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { turns: 10 }, assistant: {} } as never,
          },
        },
      });
      expect(validResult.routing.classifier.contextWindow.user.turns).toBe(10);
    });

    it("should clamp contextWindow.assistant.turns within bounds (0-10)", () => {
      const lowResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { turns: -1 } } as never,
          },
        },
      });
      expect(lowResult.routing.classifier.contextWindow.assistant.turns).toBe(
        0,
      );

      const highResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { turns: 20 } } as never,
          },
        },
      });
      expect(highResult.routing.classifier.contextWindow.assistant.turns).toBe(
        10,
      );

      const validResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { turns: 5 } } as never,
          },
        },
      });
      expect(validResult.routing.classifier.contextWindow.assistant.turns).toBe(
        5,
      );
    });

    it("should clamp contextWindow.user.chars within bounds (40-1000)", () => {
      const lowResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { chars: 10 }, assistant: {} } as never,
          },
        },
      });
      expect(lowResult.routing.classifier.contextWindow.user.chars).toBe(40);

      const highResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { chars: 5000 }, assistant: {} } as never,
          },
        },
      });
      expect(highResult.routing.classifier.contextWindow.user.chars).toBe(1000);

      const validResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { chars: 500 }, assistant: {} } as never,
          },
        },
      });
      expect(validResult.routing.classifier.contextWindow.user.chars).toBe(500);
    });

    it("should clamp contextWindow.assistant.chars within bounds (40-1000)", () => {
      const lowResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { chars: 20 } } as never,
          },
        },
      });
      expect(lowResult.routing.classifier.contextWindow.assistant.chars).toBe(
        40,
      );

      const highResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { chars: 2000 } } as never,
          },
        },
      });
      expect(highResult.routing.classifier.contextWindow.assistant.chars).toBe(
        1000,
      );

      const validResult = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: {}, assistant: { chars: 300 } } as never,
          },
        },
      });
      expect(validResult.routing.classifier.contextWindow.assistant.chars).toBe(
        300,
      );
    });

    it("should use default for NaN values", () => {
      const result = resolveConfig({
        routing: { classifier: { timeoutMs: NaN } },
      });
      expect(result.routing.classifier.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("should use default for undefined numeric values", () => {
      const result = resolveConfig({
        routing: { classifier: { timeoutMs: undefined } },
      });
      expect(result.routing.classifier.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("should use default for invalid primitive numeric values", () => {
      const result = resolveConfig({
        routing: {
          classifier: {
            timeoutMs: "5000",
            contextWindow: {
              user: { turns: "3", chars: false },
              assistant: { turns: {}, chars: [] },
            },
          },
        },
      });
      expect(result.routing.classifier.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.routing.classifier.contextWindow.user.turns).toBe(
        DEFAULT_RECENT_USER_TURNS,
      );
      expect(result.routing.classifier.contextWindow.user.chars).toBe(
        DEFAULT_RECENT_USER_CHARS,
      );
      expect(result.routing.classifier.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
      expect(result.routing.classifier.contextWindow.assistant.chars).toBe(
        DEFAULT_RECENT_ASSISTANT_CHARS,
      );
    });
  });

  describe("scope string array fields", () => {
    it("should parse agents as string array", () => {
      const result = resolveConfig({ scope: { agents: ["agent1", "agent2"] } });
      expect(result.scope.agents).toEqual(["agent1", "agent2"]);
    });

    it("should trim and filter empty strings in agents", () => {
      const result = resolveConfig({
        scope: { agents: ["  agent1  ", "", "  ", "agent2"] },
      });
      expect(result.scope.agents).toEqual(["agent1", "agent2"]);
    });

    it("should convert single string to array", () => {
      const result = resolveConfig({ scope: { agents: "singleAgent" } });
      expect(result.scope.agents).toEqual(["singleAgent"]);
    });

    it("should use default for empty agents array", () => {
      const result = resolveConfig({ scope: { agents: [] } });
      expect(result.scope.agents).toEqual(["main"]);
    });

    it("should parse allowedChatIds as string array", () => {
      const result = resolveConfig({
        scope: { allowedChatIds: ["id1", "id2"] },
      });
      expect(result.scope.allowedChatIds).toEqual(["id1", "id2"]);
    });

    it("should parse deniedChatIds as string array", () => {
      const result = resolveConfig({
        scope: { deniedChatIds: ["id1", "id2"] },
      });
      expect(result.scope.deniedChatIds).toEqual(["id1", "id2"]);
    });

    it("should parse chatTypes as string array", () => {
      const result = resolveConfig({
        scope: { chatTypes: ["direct", "group"] },
      });
      expect(result.scope.chatTypes).toEqual(["direct", "group"]);
    });

    it("should fall back for invalid primitive string and array fields", () => {
      const result = resolveConfig({
        scope: {
          agents: 123,
          chatTypes: false,
          allowedChatIds: {},
          deniedChatIds: 0,
        },
        routing: {
          classifier: {
            model: {},
            modelFallback: [],
          },
        },
      });
      expect(result.scope.agents).toEqual(["main"]);
      expect(result.scope.chatTypes).toEqual(["direct"]);
      expect(result.scope.allowedChatIds).toEqual([]);
      expect(result.scope.deniedChatIds).toEqual([]);
      expect(result.routing.classifier.model).toBeUndefined();
      expect(result.routing.classifier.modelFallback).toBeUndefined();
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
      const emptyNested = resolveConfig({
        routing: { classifier: { contextWindow: {} } },
      });
      expect(emptyNested.routing.classifier.contextWindow.user.turns).toBe(
        DEFAULT_RECENT_USER_TURNS,
      );
      expect(emptyNested.routing.classifier.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );

      const partial = resolveConfig({
        routing: {
          classifier: {
            contextWindow: { user: { turns: 7 } },
          },
        },
      } as never);
      expect(partial.routing.classifier.contextWindow.user.turns).toBe(7);
      expect(partial.routing.classifier.contextWindow.user.chars).toBe(
        DEFAULT_RECENT_USER_CHARS,
      );
      expect(partial.routing.classifier.contextWindow.assistant.turns).toBe(
        DEFAULT_RECENT_ASSISTANT_TURNS,
      );
    });
  });

  describe("optional fields", () => {
    it("should handle optional model field", () => {
      const withModel = resolveConfig({
        routing: { classifier: { model: "gpt-4" } },
      });
      expect(withModel.routing.classifier.model).toBe("gpt-4");

      const withoutModel = resolveConfig({});
      expect(withoutModel.routing.classifier.model).toBeUndefined();
    });

    it("should handle optional modelFallback field", () => {
      const withFallback = resolveConfig({
        routing: { classifier: { modelFallback: "gpt-3.5" } },
      });
      expect(withFallback.routing.classifier.modelFallback).toBe("gpt-3.5");

      const withoutFallback = resolveConfig({});
      expect(withoutFallback.routing.classifier.modelFallback).toBeUndefined();
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
