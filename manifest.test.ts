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
    ]);
    expect(manifest).not.toHaveProperty("commandAliases");
  });

  it("keeps Prettier out of runtime dependencies", () => {
    expect(packageJson.dependencies).not.toHaveProperty("prettier");
    expect(packageJson.devDependencies).toHaveProperty("prettier");
  });

  it("matches the runtime contextWindow schema", () => {
    const properties = manifest.configSchema.properties.routing.properties;
    expect(manifest.configSchema.properties).not.toHaveProperty(
      "contextWindow",
    );
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
              maximum: 2000,
              default: 1000,
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
              maximum: 2000,
              default: 1000,
            },
          },
        },
      },
      default: {},
    });
  });

  it("keeps timeoutMs aligned with the runtime schema", () => {
    const timeoutMs =
      manifest.configSchema.properties.routing.properties.timeoutMs;
    expect(timeoutMs).toMatchObject({
      minimum: 1_000,
      maximum: 60_000,
      default: 5_000,
    });
  });

  it("does not expose routing model fields and does not apply null defaults to review models", () => {
    const properties = manifest.configSchema.properties;
    const routingProps = properties.routing.properties;
    expect(routingProps).not.toHaveProperty("model");
    expect(routingProps).not.toHaveProperty("modelFallback");
    expect(routingProps).not.toHaveProperty("thinking");
    for (const model of [
      properties.review.properties.model,
      properties.review.properties.modelFallback,
    ]) {
      expect(model.type).toBe("string");
      expect(model).not.toHaveProperty("default");
    }
  });

  it("does not expose removed curation settings", () => {
    expect(manifest.configSchema.properties).not.toHaveProperty("curation");
  });

  it("exposes only the skill-bearing turn cadence for optional Review", () => {
    const review = manifest.configSchema.properties.review;
    const triggers = review.properties.triggers.properties;
    expect(manifest.configSchema.properties).not.toHaveProperty("evolution");
    expect(review.description).toContain("post-turn");
    expect(review.properties.enabled.default).toBe(false);
    expect(review.properties.model.description).toContain(
      "inherits the top-level model",
    );
    expect(review.properties.modelFallback.description).toContain(
      "Last-resort Review model",
    );
    expect(review.properties.modelFallback.description).toContain(
      "not a runtime retry model",
    );
    expect(review.properties.timeoutSeconds).toMatchObject({
      minimum: 60,
      maximum: 1800,
      default: 300,
    });
    expect(review.properties).not.toHaveProperty("keywordCoverage");
    expect(review.properties.triggers.additionalProperties).toBe(false);
    expect(Object.keys(triggers)).toEqual(["relationHealthCheck"]);
    expect(triggers.relationHealthCheck.additionalProperties).toBe(false);
    expect(Object.keys(triggers.relationHealthCheck.properties)).toEqual([
      "everyTurns",
    ]);
    expect(triggers.relationHealthCheck.properties.everyTurns).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 1000,
      default: 10,
    });
  });

  it("does not expose removed instruction writer or lowEffortRoutingMode settings", () => {
    expect(manifest.configSchema.properties).not.toHaveProperty("instruction");
    expect(manifest.configSchema.properties).not.toHaveProperty(
      "lowEffortRoutingMode",
    );
  });

  it("rejects retired routing sections in the public contract", () => {
    const routing = manifest.configSchema.properties.routing;
    expect(routing.additionalProperties).toBe(false);
    expect(routing.properties).not.toHaveProperty("experiences");
    expect(routing.properties).not.toHaveProperty("intents");
  });

  it("declares collectionWeights supporting positive floating-point numbers", () => {
    const weights =
      manifest.configSchema.properties.skills.properties.search.properties
        .collectionWeights.properties;
    expect(weights.meta).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
      default: 3,
      description: expect.any(String),
    });
    expect(weights.body).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
      default: 2,
      description: expect.any(String),
    });
    expect(weights.references).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
      default: 1,
      description: expect.any(String),
    });
  });

  it("exposes independent optional model endpoints and rejects retired root jev", () => {
    expect(manifest.configSchema.required).toEqual(["qmd"]);
    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(manifest.configSchema.properties).not.toHaveProperty("jev");
    for (const endpoint of [
      manifest.configSchema.properties.decisionModel,
      manifest.configSchema.properties.qmd.properties.jev,
    ]) {
      expect(endpoint.type).toBe("object");
      expect(endpoint.required).toEqual(["model"]);
      expect(endpoint.additionalProperties).toBe(false);
      expect(endpoint.properties.model).toMatchObject({
        type: "string",
        minLength: 1,
        pattern: "\\S",
      });
      expect(Object.keys(endpoint.properties)).toEqual([
        "baseUrl",
        "model",
        "apiKey",
      ]);
    }
  });
});
