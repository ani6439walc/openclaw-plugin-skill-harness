import { describe, expect, it } from "vitest";
import type { HistoricalIntentRecord, IntentCatalogEntry } from "../types.js";
import type { TopicSwitchResult } from "./prompts.js";
import { projectIntentCandidates } from "./candidates.js";

function intent(
  id: string,
  domain: string,
  candidate?: IntentCatalogEntry["definition"]["candidate"],
): IntentCatalogEntry {
  return {
    id,
    definition: {
      triggers: [`trigger ${id}`],
      examples: [`example ${id}`],
      domain,
      ...(candidate ? { candidate } : {}),
      fastpath: { keywords: [] },
      prompt: `prompt ${id}`,
    },
  };
}

function topicContext(
  overrides: Partial<TopicSwitchResult> = {},
): TopicSwitchResult {
  return {
    basis: "latest request starts a development task",
    keywords: ["typescript"],
    topic: "Implementing a TypeScript change",
    domain: "development",
    changed: true,
    reason: "shift",
    confidence: 0.9,
    complexity: "medium",
    ...overrides,
  };
}

const catalog = [
  intent("chat", "chat"),
  intent("approve", "conversation", { scope: "cross-flow" }),
  intent("typescript", "development", { keywords: ["TypeScript", "型別"] }),
  intent("version-control", "development", { keywords: ["git"] }),
  intent("deploy", "operations", { keywords: ["deploy"] }),
];

describe("projectIntentCandidates", () => {
  it("projects the predicted domain and cross-flow intents on high overall confidence", () => {
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "Please update the TypeScript types",
      topicContext: topicContext(),
    });

    expect(result.projected).toBe(true);
    expect(result.decision).toBe("projected");
    expect(result.originalIntentCount).toBe(5);
    expect(result.candidateIntentCount).toBe(3);
    expect(result.effectiveIntents.map((entry) => entry.id)).toEqual([
      "approve",
      "typescript",
      "version-control",
    ]);
    expect(result.candidateIntents.map((entry) => entry.id)).toEqual([
      "approve",
      "typescript",
      "version-control",
    ]);
    expect(result.supportReasons).toContain("high-overall-confidence");
    expect(result.selectionReasons).toEqual([
      "cross-flow",
      "predicted-domain",
      "candidate-keyword",
      "intent-id",
    ]);
    expect(result.candidateSelections).toEqual([
      {
        intentId: "approve",
        selectionReasons: ["cross-flow"],
        matchedKeywords: [],
      },
      {
        intentId: "typescript",
        selectionReasons: [
          "predicted-domain",
          "candidate-keyword",
          "intent-id",
        ],
        matchedKeywords: ["TypeScript"],
      },
      {
        intentId: "version-control",
        selectionReasons: ["predicted-domain"],
        matchedKeywords: [],
      },
    ]);
    expect(result.matchedKeywords).toEqual(["TypeScript"]);
  });

  it("falls back to the full catalog without topic context", () => {
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "deploy this",
    });

    expect(result.projected).toBe(false);
    expect(result.decision).toBe("full-fallback");
    expect(result.originalIntentCount).toBe(5);
    expect(result.candidateIntentCount).toBe(5);
    expect(result.fallbackReason).toBe("missing-topic-context");
    expect(result.effectiveIntents).toEqual(catalog);
  });

  it("falls back for an unknown predicted domain even with exact evidence", () => {
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "deploy this",
      topicContext: topicContext({ domain: "unknown", confidence: 0.95 }),
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("unknown-domain");
  });

  it("falls back on low overall confidence without history or exact evidence", () => {
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "please help",
      topicContext: topicContext({ confidence: 0.79, keywords: ["help"] }),
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("insufficient-evidence");
    expect(result.effectiveIntents).toEqual(catalog);
  });

  it("uses an authorized latest historical intent for low-confidence same-topic projection", () => {
    const latestHistoricalIntent: HistoricalIntentRecord = {
      input: "previous",
      intent: "deploy",
      domain: "operations",
    };
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "continue",
      topicContext: topicContext({
        reason: "same-topic",
        changed: false,
        confidence: 0.6,
        keywords: ["continue"],
      }),
      latestHistoricalIntent,
    });

    expect(result.projected).toBe(true);
    expect(result.effectiveIntents.map((entry) => entry.id)).toEqual([
      "approve",
      "typescript",
      "version-control",
      "deploy",
    ]);
    expect(result.supportReasons).toContain("authorized-history");
    expect(result.selectionReasons).toContain("authorized-history");
  });

  it("falls back when low-confidence same-topic history is stale or denied", () => {
    const result = projectIntentCandidates({
      intents: catalog.filter((entry) => entry.id !== "deploy"),
      latest: "continue",
      topicContext: topicContext({
        reason: "same-topic",
        changed: false,
        confidence: 0.6,
        keywords: ["continue"],
      }),
      latestHistoricalIntent: {
        input: "previous",
        intent: "deploy",
        domain: "operations",
      },
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("historical-intent-unavailable");
    expect(result.effectiveIntents.map((entry) => entry.id)).not.toContain(
      "deploy",
    );
  });

  it("uses exact candidate keyword evidence from the latest message at low confidence", () => {
    const result = projectIntentCandidates({
      intents: catalog,
      latest: "請幫我修正這個型別",
      topicContext: topicContext({ confidence: 0.5, keywords: ["修正"] }),
    });

    expect(result.projected).toBe(true);
    expect(result.supportReasons).toContain("exact-evidence");
    expect(result.matchedKeywords).toEqual(["型別"]);
  });

  it("uses normalized exact topic keywords without substring matching", () => {
    const exact = projectIntentCandidates({
      intents: catalog,
      latest: "please help",
      topicContext: topicContext({ confidence: 0.5, keywords: ["  GIT  "] }),
    });
    const substring = projectIntentCandidates({
      intents: catalog,
      latest: "please help",
      topicContext: topicContext({ confidence: 0.5, keywords: ["github"] }),
    });

    expect(exact.projected).toBe(true);
    expect(exact.matchedKeywords).toEqual(["git"]);
    expect(substring.projected).toBe(false);
  });

  it("deduplicates normalized-equivalent candidate keywords while preserving first author text", () => {
    const duplicateKeywords = [
      intent("git", "version-control", {
        keywords: ["Git", "ＧＩＴ", " git "],
      }),
      intent("docs", "docs"),
      intent("other", "other"),
    ];
    const result = projectIntentCandidates({
      intents: duplicateKeywords,
      latest: "Use git",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: [],
      }),
    });

    expect(result.matchedKeywords).toEqual(["Git"]);
  });

  it("collapses whitespace without consulting locale-sensitive lowercasing", () => {
    const localeLower = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(() => {
        throw new Error("locale-sensitive lowercasing must not be used");
      });
    try {
      const result = projectIntentCandidates({
        intents: [
          intent("release", "release", {
            keywords: ["Release   Approval"],
          }),
          intent("docs", "docs"),
          intent("other", "other"),
        ],
        latest: "request release approval now",
        topicContext: topicContext({
          domain: "docs",
          confidence: 0.5,
          keywords: [],
        }),
      });

      expect(result.projected).toBe(true);
      expect(result.matchedKeywords).toEqual(["Release   Approval"]);
    } finally {
      localeLower.mockRestore();
    }
  });

  it("matches normalized intent IDs against latest messages and topic keywords", () => {
    const fromMessage = projectIntentCandidates({
      intents: catalog,
      latest: "Inspect the version-control intent",
      topicContext: topicContext({ confidence: 0.5, keywords: ["inspect"] }),
    });
    const fromTopicKeyword = projectIntentCandidates({
      intents: catalog,
      latest: "inspect it",
      topicContext: topicContext({
        confidence: 0.5,
        keywords: ["VERSION-CONTROL"],
      }),
    });
    const separatorAlias = projectIntentCandidates({
      intents: catalog,
      latest: "inspect it",
      topicContext: topicContext({
        confidence: 0.5,
        keywords: ["version_control"],
      }),
    });

    expect(fromMessage.projected).toBe(true);
    expect(fromMessage.selectionReasons).toContain("intent-id");
    expect(fromTopicKeyword.projected).toBe(true);
    expect(fromTopicKeyword.selectionReasons).toContain("intent-id");
    expect(separatorAlias.projected).toBe(false);
  });

  it("matches Latin phrases on boundaries instead of substrings", () => {
    const boundaryCatalog = [
      intent("git", "version-control", { keywords: ["git"] }),
      intent("docs", "docs"),
      intent("other", "other"),
    ];
    const substring = projectIntentCandidates({
      intents: boundaryCatalog,
      latest: "Use GitHub",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: [],
      }),
    });
    const exact = projectIntentCandidates({
      intents: boundaryCatalog,
      latest: "Use git, please",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: [],
      }),
    });

    expect(substring.projected).toBe(false);
    expect(exact.projected).toBe(true);
    expect(exact.candidateIntents.map((entry) => entry.id)).toContain("git");
  });

  it("does not match Latin keyword or intent-ID continuations", () => {
    const result = projectIntentCandidates({
      intents: [
        intent("deploy", "operations", { keywords: ["deploy"] }),
        intent("version-control", "development"),
        intent("docs", "docs"),
        intent("other", "other"),
      ],
      latest: "deployment with version-controller",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: [],
      }),
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("insufficient-evidence");
  });

  it("treats Unicode combining marks as word continuations", () => {
    const result = projectIntentCandidates({
      intents: [
        intent("latin", "language", { keywords: ["ab"] }),
        intent("docs", "docs"),
        intent("other", "other"),
      ],
      latest: "Use ab\u0301 here",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: [],
      }),
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("insufficient-evidence");
  });

  it("matches symbol-heavy phrases without accepting symbol continuations", () => {
    const cPlusPlus = intent("cpp", "language", { keywords: ["C++"] });
    const docs = intent("docs", "docs");
    const other = intent("other", "other");
    const collision = projectIntentCandidates({
      intents: [cPlusPlus, docs, other],
      latest: "Use C++++",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.7,
        keywords: [],
      }),
    });
    const exact = projectIntentCandidates({
      intents: [cPlusPlus, docs, other],
      latest: "Use C++.",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.7,
        keywords: [],
      }),
    });

    expect(collision.projected).toBe(false);
    expect(collision.fallbackReason).toBe("insufficient-evidence");
    expect(exact.projected).toBe(true);
    expect(exact.candidateIntents.map((entry) => entry.id)).toContain("cpp");
  });

  it("requires a one-code-point phrase to match the whole latest message or topic keyword", () => {
    const oneCharacterCatalog = [
      intent("chat", "chat"),
      intent("approve", "conversation", { scope: "cross-flow" }),
      intent("yes", "development", { keywords: ["對"] }),
      intent("code", "development"),
    ];
    const embedded = projectIntentCandidates({
      intents: oneCharacterCatalog,
      latest: "這個結果是對的",
      topicContext: topicContext({ confidence: 0.5, keywords: ["結果"] }),
    });
    const exactTopicKeyword = projectIntentCandidates({
      intents: oneCharacterCatalog,
      latest: "這個結果是正確的",
      topicContext: topicContext({ confidence: 0.5, keywords: ["對"] }),
    });

    expect(embedded.projected).toBe(false);
    expect(exactTopicKeyword.projected).toBe(true);
  });

  it("includes every colliding exact match and preserves canonical catalog order", () => {
    const collisions = [
      intent("alpha", "alpha", { keywords: ["shared"] }),
      intent("cross", "conversation", { scope: "cross-flow" }),
      intent("beta", "development", { keywords: ["shared"] }),
      intent("docs", "docs"),
      intent("other", "other"),
    ];
    const result = projectIntentCandidates({
      intents: collisions,
      latest: "use shared routing",
      topicContext: topicContext({
        domain: "docs",
        confidence: 0.5,
        keywords: ["shared"],
      }),
    });

    expect(result.projected).toBe(true);
    expect(result.effectiveIntents.map((entry) => entry.id)).toEqual([
      "alpha",
      "cross",
      "beta",
      "docs",
    ]);
  });

  it("falls back when projection would not omit any intents", () => {
    const sameDomain = [
      intent("approve", "development", { scope: "cross-flow" }),
      intent("typescript", "development"),
    ];
    const result = projectIntentCandidates({
      intents: sameDomain,
      latest: "typescript",
      topicContext: topicContext(),
    });

    expect(result.projected).toBe(false);
    expect(result.fallbackReason).toBe("no-reduction");
    expect(result.effectiveIntents).toEqual(sameDomain);
    expect(result.supportReasons).toContain("high-overall-confidence");
  });
});
