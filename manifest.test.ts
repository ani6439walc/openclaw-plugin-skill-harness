import fs from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
);

describe("intention-hint manifest", () => {
  it("declares OpenClaw-owned tool and command surfaces", () => {
    expect(manifest.contracts).toEqual({
      tools: ["intention_hint_evolution"],
    });
    expect(manifest.commandAliases).toContainEqual({
      name: "intention-hint",
      kind: "runtime-slash",
    });
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
    expect(timeoutMs.maximum).toBe(120000);
  });

  it("exposes disabled-by-default Evolution settings", () => {
    const evolution = manifest.configSchema.properties.evolution;
    expect(JSON.stringify(evolution)).not.toMatch(/self[- ]?evolution/i);
    expect(evolution.description).toContain("Evolution reviews");
    expect(evolution.properties.enabled.default).toBe(false);
    expect(evolution.properties.timeoutMs).toMatchObject({
      minimum: 250,
      maximum: 600000,
      default: 30000,
    });
    expect(
      evolution.properties.triggers.properties.skillCandidate.properties
        .toolCalls.default,
    ).toBe(5);
    expect(
      evolution.properties.triggers.properties.weakIntent.properties
        .confidenceBelow.default,
    ).toBe(0.5);
  });
});
