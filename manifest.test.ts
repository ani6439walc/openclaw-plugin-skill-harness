import fs from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
);
const packageJson = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

describe("skill-harness manifest", () => {
  it("declares skill tools without legacy command surfaces", () => {
    expect(manifest.contracts?.tools).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
      "skill_manage",
      "skill_experience",
    ]);
    expect(manifest).not.toHaveProperty("commandAliases");
  });

  it("keeps Prettier out of runtime dependencies", () => {
    expect(packageJson.dependencies).not.toHaveProperty("prettier");
    expect(packageJson.devDependencies).toHaveProperty("prettier");
  });

  it("matches the runtime contextWindow schema", () => {
    const properties = manifest.configSchema.properties;

    expect(properties).not.toHaveProperty("recentUserTurns");
    expect(properties).not.toHaveProperty("recentAssistantTurns");
    expect(properties).not.toHaveProperty("recentUserChars");
    expect(properties).not.toHaveProperty("recentAssistantChars");
    expect(properties.contextWindow).toEqual({
      type: "object",
      description: "Turn and character limits for recent conversation context.",
      additionalProperties: false,
      properties: {
        user: {
          type: "object",
          additionalProperties: false,
          properties: {
            turns: { type: "integer", minimum: 0, maximum: 20, default: 5 },
            chars: {
              type: "integer",
              minimum: 40,
              maximum: 1000,
              default: 220,
            },
          },
        },
        assistant: {
          type: "object",
          additionalProperties: false,
          properties: {
            turns: { type: "integer", minimum: 0, maximum: 10, default: 5 },
            chars: {
              type: "integer",
              minimum: 40,
              maximum: 1000,
              default: 180,
            },
          },
        },
      },
      default: {},
    });
  });

  it("keeps timeoutMs aligned with the runtime schema", () => {
    const timeoutMs = manifest.configSchema.properties.timeoutMs;
    expect(timeoutMs.minimum).toBe(250);
    expect(timeoutMs.maximum).toBe(60000);
  });

  it("does not apply null defaults to optional model strings", () => {
    const properties = manifest.configSchema.properties;
    const optionalModels = [
      properties.model,
      properties.modelFallback,
      properties.curation.properties.model,
      properties.curation.properties.modelFallback,
      properties.review.properties.model,
      properties.review.properties.modelFallback,
    ];

    for (const model of optionalModels) {
      expect(model.type).toBe("string");
      expect(model).not.toHaveProperty("default");
    }
  });

  it("exposes enabled-by-default independent curator settings", () => {
    const curation = manifest.configSchema.properties.curation;

    expect(curation.description).toContain("background curator");
    expect(curation.additionalProperties).toBe(false);
    expect(curation.properties.enabled.default).toBe(true);
    expect(curation.properties.model.description).toContain(
      "inherits the top-level model",
    );
    expect(curation.properties.modelFallback.description).toContain(
      "not a runtime retry model",
    );
    expect(curation.properties.thinking).toMatchObject({
      default: "medium",
      enum: [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "adaptive",
        "max",
      ],
    });
    expect(curation.properties.timeoutMs).toMatchObject({
      minimum: 250,
      maximum: 600_000,
      default: 30_000,
    });
    expect(curation.default).toEqual({});
  });

  it("exposes disabled-by-default Review settings", () => {
    const review = manifest.configSchema.properties.review;
    expect(manifest.configSchema.properties).not.toHaveProperty("evolution");
    expect(review.description).toContain("Intent Review runs");
    expect(review.properties.enabled.default).toBe(false);
    expect(review.properties.model.description).toContain(
      "inherits the top-level model",
    );
    expect(review.properties.modelFallback.description).toContain(
      "Last-resort Intent Review model",
    );
    expect(review.properties.modelFallback.description).toContain(
      "not a runtime retry model",
    );
    expect(review.properties.timeoutMs).toMatchObject({
      minimum: 60000,
      maximum: 1800000,
      default: 180000,
    });
    expect(review.properties.keywordCoverage).toEqual({
      type: "object",
      description:
        "Automatic cross-session keyword coverage review cadence for accepted routed turns.",
      additionalProperties: false,
      properties: {
        everyAcceptedTurns: {
          type: "integer",
          minimum: 10,
          maximum: 1000,
          default: 50,
        },
      },
      default: {},
    });
    expect(
      review.properties.triggers.properties.skillCandidate.properties.toolCalls
        .default,
    ).toBe(5);
    expect(
      review.properties.triggers.properties.weakIntent.properties
        .confidenceBelow.default,
    ).toBe(0.5);
  });

  it("does not expose removed instruction writer settings", () => {
    expect(manifest.configSchema.properties).not.toHaveProperty("instruction");
  });

  it("accepts deprecated keyword seeds for strict-schema upgrades", () => {
    const triggers =
      manifest.configSchema.properties.review.properties.triggers.properties;

    for (const trigger of [
      triggers.successfulPattern,
      triggers.behaviorFix,
      triggers.entityContext,
    ]) {
      expect(trigger.properties.keywords).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
      expect(trigger.properties.keywords.description).toContain("Deprecated");
    }
  });
});
