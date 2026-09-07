import fs from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
);
const packageJson = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);
const readme = fs.readFileSync(
  new URL("./README.md", import.meta.url),
  "utf-8",
);

describe("skill-harness manifest", () => {
  it("declares skill tools without legacy command surfaces", () => {
    expect(manifest.contracts?.tools).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
      "skill_experience",
    ]);
    expect(manifest).not.toHaveProperty("commandAliases");
  });

  it("keeps Prettier out of runtime dependencies", () => {
    expect(packageJson.dependencies).not.toHaveProperty("prettier");
    expect(packageJson.devDependencies).toHaveProperty("prettier");
  });

  it("matches the runtime contextWindow schema", () => {
    const properties =
      manifest.configSchema.properties.routing.properties.classifier.properties;
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
    const timeoutMs =
      manifest.configSchema.properties.routing.properties.classifier.properties
        .timeoutMs;
    expect(timeoutMs).toMatchObject({
      minimum: 1_000,
      maximum: 60_000,
      default: 5_000,
    });
  });

  it("does not apply null defaults to optional model strings", () => {
    const properties = manifest.configSchema.properties;
    const classifierProps = properties.routing.properties.classifier.properties;
    for (const model of [
      classifierProps.model,
      classifierProps.modelFallback,
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

  it("exposes disabled-by-default three-trigger Review settings", () => {
    const review = manifest.configSchema.properties.review;
    const triggers = review.properties.triggers.properties;
    expect(manifest.configSchema.properties).not.toHaveProperty("evolution");
    expect(review.description).toContain("post-turn");
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
    expect(review.properties.timeoutSeconds).toMatchObject({
      minimum: 60,
      maximum: 1800,
      default: 300,
    });
    expect(review.properties).not.toHaveProperty("keywordCoverage");
    expect(triggers.intentHealthCheck.properties.everyTurns.default).toBe(10);
    expect(triggers.routingUncertainty.properties.confidenceBelow.default).toBe(
      0.5,
    );
    expect(triggers.capabilityFit.properties.toolCalls.default).toBe(5);
    expect(triggers.capabilityFit.properties.toolFailures.default).toBe(2);
    for (const removed of [
      "skillCandidate",
      "skillPlacement",
      "processGap",
      "successfulPattern",
      "satisfactionCheck",
      "missingIntent",
      "weakIntent",
      "behaviorFix",
      "entityContext",
    ]) {
      expect(triggers).not.toHaveProperty(removed);
    }
  });

  it("does not expose removed instruction writer or lowEffortRoutingMode settings", () => {
    expect(manifest.configSchema.properties).not.toHaveProperty("instruction");
    expect(manifest.configSchema.properties).not.toHaveProperty(
      "lowEffortRoutingMode",
    );
  });

  it("documents the strict upgrade path for removed instruction settings", () => {
    expect(readme).toContain("### Upgrade from the removed instruction writer");
    expect(readme).toContain(
      "remove the entire legacy `instruction: { ... }` block",
    );
    expect(readme).toContain("no automatic migration or compatibility parser");
  });
});
