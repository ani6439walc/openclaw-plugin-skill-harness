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
      properties.instruction.properties.model,
      properties.instruction.properties.modelFallback,
      properties.review.properties.model,
      properties.review.properties.modelFallback,
    ];

    for (const model of optionalModels) {
      expect(model.type).toBe("string");
      expect(model).not.toHaveProperty("default");
    }
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
    expect(
      review.properties.triggers.properties.skillCandidate.properties.toolCalls
        .default,
    ).toBe(5);
    expect(
      review.properties.triggers.properties.weakIntent.properties
        .confidenceBelow.default,
    ).toBe(0.5);
  });

  it("exposes enabled-by-default instruction writer settings without triggers", () => {
    const instruction = manifest.configSchema.properties.instruction;

    expect(instruction.description).toContain("instruction writer");
    expect(instruction.properties.enabled.default).toBe(true);
    expect(instruction.properties.model.description).toContain(
      "Explicit dedicated model",
    );
    expect(instruction.properties.modelFallback.description).toContain(
      "Last-resort instruction writer model",
    );
    expect(instruction.properties.modelFallback.description).toContain(
      "not a runtime retry model",
    );
    expect(instruction.properties.thinking).toMatchObject({
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
    expect(instruction.properties.timeoutMs).toMatchObject({
      minimum: 250,
      maximum: 120000,
      default: 20000,
    });
    expect(instruction.properties).not.toHaveProperty("triggers");
  });
});
