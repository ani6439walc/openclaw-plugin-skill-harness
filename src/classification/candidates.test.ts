import { describe, expect, it } from "vitest";
import type { IntentCatalogEntry } from "../types.js";
import {
  getQmdCandidateLimits,
  projectQmdIntentCandidates,
} from "./candidates.js";

function intent(id: string, domain: string): IntentCatalogEntry {
  const definition: IntentCatalogEntry["definition"] = {
    triggers: [`trigger ${id}`],
    examples: [`example ${id}`],
    domain,
    keywords: [],
    guidance: `prompt ${id}`,
  };
  return { id, definition };
}

const catalog = [
  intent("chat", "chat"),
  intent("approve", "conversation"),
  intent("typescript", "development"),
  intent("version-control", "development"),
  intent("deploy", "operations"),
];

describe("projectQmdIntentCandidates", () => {
  it("uses QMD rank and the last two valid histories in canonical catalog order", () => {
    const result = projectQmdIntentCandidates({
      intents: catalog,
      minCandidateScore: 0.35,
      qmdHits: [
        {
          intentId: "version-control",
          score: 0.7,
          collection: "intent-triggers-and-examples",
        },
      ],
      histories: [
        { input: "one", intent: "deploy", domain: "operations" },
        { input: "two", intent: "typescript", domain: "development" },
      ],
    });

    expect(result.projected).toBe(true);
    expect(result.effectiveIntents.map((entry) => entry.id)).toEqual([
      "typescript",
      "version-control",
      "deploy",
    ]);
    expect(result.selectionReasons).toEqual(["qmd-hit", "recent-history"]);
  });

  it("falls back to the complete catalog when QMD is unavailable or below the configured minimum score", () => {
    expect(
      projectQmdIntentCandidates({
        intents: catalog,
        histories: [],
        minCandidateScore: 0.35,
      }),
    ).toMatchObject({
      fallbackReason: "qmd-unavailable",
      effectiveIntents: catalog,
    });
    expect(
      projectQmdIntentCandidates({
        intents: catalog,
        qmdHits: [
          {
            intentId: "version-control",
            score: 0.34,
            collection: "intent-triggers-and-examples",
          },
        ],
        histories: [],
        minCandidateScore: 0.35,
      }),
    ).toMatchObject({
      fallbackReason: "qmd-no-trusted-recall",
      effectiveIntents: catalog,
    });
  });

  it("uses the supplied minimum score inclusively", () => {
    const result = projectQmdIntentCandidates({
      intents: catalog,
      qmdHits: [
        {
          intentId: "version-control",
          score: 0.5,
          collection: "intent-triggers-and-examples",
        },
      ],
      histories: [],
      minCandidateScore: 0.5,
    });

    expect(result.effectiveIntents.map((entry) => entry.id)).toEqual([
      "version-control",
    ]);
  });

  it("derives dynamic QMD limits without a fixed catalog-size cutoff", () => {
    expect(getQmdCandidateLimits(1)).toEqual({
      smallK: 1,
      largeK: 1,
      rawLimit: 2,
    });
    expect(getQmdCandidateLimits(64)).toEqual({
      smallK: 8,
      largeK: 16,
      rawLimit: 32,
    });
  });
});
