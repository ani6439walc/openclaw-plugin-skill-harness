import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { checkReviewTriggers, evaluateKeywordTrigger } from "./triggers.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";
import type { SessionState } from "../session/index.js";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    input: "Please do this",
    intent: {
      result: {
        intent: "CODE_REVIEW",
        reason: "test",
        confidence: 0.9,
        complexity: "medium",
      },
    },
    ...overrides,
  };
}

describe("checkReviewTriggers", () => {
  const triggers = resolveConfig({}).review.triggers;
  const customKeywords: ReviewTriggerKeywords = {
    successfulPattern: ["verified"],
    behaviorFix: ["redo"],
    entityContext: ["means"],
  };

  it("returns all matching current-turn triggers", () => {
    expect(
      checkReviewTriggers(
        state({
          input: "不對，應該是另一個做法，以後看到先看 TOOLS.md",
          result: "完成，驗證通過。",
          intent: {
            result: {
              intent: "other",
              reason: "unclear",
              confidence: 0.2,
              complexity: "high",
            },
          },
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
            error: index < 2 ? "failed" : undefined,
          })),
        }),
        10,
        triggers,
      ),
    ).toEqual([
      "skill-candidate",
      "process-gap",
      "successful-pattern",
      "satisfaction-check",
      "missing-intent",
      "weak-intent",
      "behavior-fix",
      "entity-context",
    ]);
  });

  it("only runs satisfaction checks on the configured turn interval", () => {
    expect(checkReviewTriggers(state(), 9, triggers)).not.toContain(
      "satisfaction-check",
    );
    expect(checkReviewTriggers(state(), 10, triggers)).toContain(
      "satisfaction-check",
    );
    expect(checkReviewTriggers(state(), 20, triggers)).toContain(
      "satisfaction-check",
    );
  });

  it("honors custom thresholds and disabled triggers", () => {
    const custom = resolveConfig({
      review: {
        triggers: {
          skillCandidate: { enabled: false },
          processGap: { toolFailures: 1 },
          successfulPattern: { toolCalls: 2 },
          satisfactionCheck: { everyTurns: 3 },
          weakIntent: { confidenceBelow: 0.95 },
          behaviorFix: {},
        },
      },
    }).review.triggers;

    expect(
      checkReviewTriggers(
        state({
          input: "redo this",
          toolCalls: [{ name: "exec", params: {}, error: "failed" }],
        }),
        3,
        custom,
        customKeywords,
      ),
    ).toEqual([
      "process-gap",
      "satisfaction-check",
      "weak-intent",
      "behavior-fix",
    ]);
  });

  it("detects successful reusable patterns from completed tool-heavy turns", () => {
    expect(
      checkReviewTriggers(
        state({
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "Implemented the feature and verified tests passed.",
        }),
        1,
        triggers,
      ),
    ).toContain("successful-pattern");
  });

  it("detects successful reusable patterns from skill-assisted completed turns", () => {
    expect(
      checkReviewTriggers(
        state({
          skillsUsed: [{ name: "test-driven-development", path: "skills/tdd" }],
          result: "完成，驗證通過。",
        }),
        1,
        triggers,
      ),
    ).toContain("successful-pattern");
  });

  it("uses runtime review trigger keywords instead of plugin config keywords", () => {
    const runtimeKeywords: ReviewTriggerKeywords = {
      successfulPattern: ["ship it"],
      behaviorFix: ["try again"],
      entityContext: ["means"],
    };

    expect(
      checkReviewTriggers(
        state({
          input: "try again with the other helper",
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "ship it",
        }),
        1,
        triggers,
        runtimeKeywords,
      ),
    ).toEqual(["skill-candidate", "successful-pattern", "behavior-fix"]);
  });

  it("does not treat quoted dream diary memory fragments as behavior corrections", () => {
    expect(
      checkReviewTriggers(
        state({
          input:
            "Write a dream diary entry from these memory fragments:\n- RG476H 不是軟體問題，應該是排線鬆了\n- Ani 誤會主人要部署，其實只是查 log",
        }),
        1,
        triggers,
      ),
    ).not.toContain("behavior-fix");
  });

  it("does not treat ingest payload text as behavior corrections", () => {
    expect(
      checkReviewTriggers(
        state({
          input:
            "Summarize this ingest prompt:\n- incorrect project status should be fixed in the source material",
        }),
        1,
        triggers,
      ),
    ).not.toContain("behavior-fix");
  });

  it("still detects direct latest-user behavior corrections", () => {
    expect(
      checkReviewTriggers(
        state({ input: "不是叫你查 README，是叫你看 AGENTS.md" }),
        1,
        triggers,
      ),
    ).toContain("behavior-fix");
  });

  it("does not detect successful patterns for failed turns or completion text without reusable work", () => {
    expect(
      checkReviewTriggers(
        state({
          error: "failed",
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "verified",
        }),
        1,
        triggers,
      ),
    ).not.toContain("successful-pattern");

    expect(
      checkReviewTriggers(state({ result: "done" }), 1, triggers),
    ).not.toContain("successful-pattern");
  });

  it("detects entity-context only from learning keywords plus narrow source signals", () => {
    expect(
      checkReviewTriggers(
        state({ input: "Yumi 指的是 Hermes/RG476H，之後先看 TOOLS.md" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({ input: "幫我看一下 TOOLS.md 裡有沒有 Yumi 的紀錄" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({ input: "看下 MEMORY.md 裡有沒有 RG476H 的紀錄" }),
        1,
        triggers,
      ),
    ).toContain("entity-context");
  });

  it("uses read/search tool params as entity-context source signals", () => {
    expect(
      checkReviewTriggers(
        state({
          input: "Yumi 指的是 Hermes/RG476H",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({
          input: "看看這個 alias 之前是不是有記",
          toolCalls: [
            {
              name: "read_file",
              params: { path: "/profile/memory/MEMORY.md" },
            },
          ],
        }),
        1,
        triggers,
      ),
    ).toContain("entity-context");
  });

  it("does not detect entity-context from source or learning keywords alone", () => {
    expect(
      checkReviewTriggers(
        state({
          input: "幫我看 TOOLS.md",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({ input: "Yumi 指的是 Hermes/RG476H" }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({
          input: "RG476H 怎麼設定 Wi-Fi",
          toolCalls: [{ name: "read_file", params: { path: "TOOLS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkReviewTriggers(state({ input: "Yumi 好可愛" }), 1, triggers),
    ).not.toContain("entity-context");
  });

  it("does not treat unrelated docs as entity-context source signals", () => {
    expect(
      checkReviewTriggers(
        state({ input: "以後看到 Yumi 先看 AGENTS.md" }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");

    expect(
      checkReviewTriggers(
        state({
          input: "Yumi 指的是 Hermes/RG476H",
          toolCalls: [{ name: "read", params: { path: "AGENTS.md" } }],
        }),
        1,
        triggers,
      ),
    ).not.toContain("entity-context");
  });
});

describe("evaluateKeywordTrigger", () => {
  const triggers = resolveConfig({}).review.triggers;
  const customKeywords: ReviewTriggerKeywords = {
    successfulPattern: ["verified"],
    behaviorFix: ["redo"],
    entityContext: ["means"],
  };

  describe("successful-pattern", () => {
    it("returns eligible when threshold met and keywords match", () => {
      const result = evaluateKeywordTrigger(
        "successful-pattern",
        state({
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "verified",
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(true);
      expect(result.matchedKeywords).toEqual(["verified"]);
      expect(result.blockedReason).toBeUndefined();
    });

    it("returns eligible when skillsUsed is present", () => {
      const result = evaluateKeywordTrigger(
        "successful-pattern",
        state({
          skillsUsed: [{ name: "test-driven-development", path: "skills/tdd" }],
          result: "verified",
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(true);
      expect(result.matchedKeywords).toEqual(["verified"]);
    });

    it("returns blocked with threshold when no toolCalls or skills", () => {
      const result = evaluateKeywordTrigger(
        "successful-pattern",
        state({ result: "verified" }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBe("threshold");
    });

    it("returns blocked with agent-error when state.error", () => {
      const result = evaluateKeywordTrigger(
        "successful-pattern",
        state({
          error: "failed",
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "verified",
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBe("agent-error");
    });

    it("returns not eligible when no keywords match", () => {
      const result = evaluateKeywordTrigger(
        "successful-pattern",
        state({
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
          })),
          result: "done",
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBeUndefined();
    });
  });

  describe("behavior-fix", () => {
    it("returns eligible when keywords match and not quoted content", () => {
      const result = evaluateKeywordTrigger(
        "behavior-fix",
        state({ input: "redo this" }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(true);
      expect(result.matchedKeywords).toEqual(["redo"]);
      expect(result.blockedReason).toBeUndefined();
    });

    it("returns blocked with quoted-content for dream diary", () => {
      const result = evaluateKeywordTrigger(
        "behavior-fix",
        state({
          input:
            "Write a dream diary entry from these memory fragments:\n- redo this",
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBe("quoted-content");
    });

    it("returns not eligible when no keywords match", () => {
      const result = evaluateKeywordTrigger(
        "behavior-fix",
        state({ input: "do this" }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBeUndefined();
    });
  });

  describe("entity-context", () => {
    it("returns eligible when keywords and source signal present", () => {
      const result = evaluateKeywordTrigger(
        "entity-context",
        state({ input: "Yumi means Hermes, check TOOLS.md" }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(true);
      expect(result.matchedKeywords).toEqual(["means"]);
      expect(result.blockedReason).toBeUndefined();
    });

    it("returns eligible with read tool params as source signal", () => {
      const result = evaluateKeywordTrigger(
        "entity-context",
        state({
          input: "Yumi means Hermes",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(true);
      expect(result.matchedKeywords).toEqual(["means"]);
    });

    it("returns blocked with missing-context-source when no signal", () => {
      const result = evaluateKeywordTrigger(
        "entity-context",
        state({ input: "Yumi means Hermes" }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBe("missing-context-source");
    });

    it("returns not eligible when no keywords match", () => {
      const result = evaluateKeywordTrigger(
        "entity-context",
        state({
          input: "check TOOLS.md",
          toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        }),
        triggers,
        customKeywords,
      );
      expect(result.structurallyEligible).toBe(false);
      expect(result.matchedKeywords).toEqual([]);
      expect(result.blockedReason).toBeUndefined();
    });
  });
});
