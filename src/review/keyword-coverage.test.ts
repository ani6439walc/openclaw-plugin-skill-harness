import { describe, expect, it } from "vitest";
import type { SessionData } from "../session/tracker.js";
import {
  discoverKeywordCoverageCandidates,
  replayKeywordPhrase,
  type CoverageCandidateDocument,
  type CoverageDiscoveryInput,
  type CoverageReplayInput,
} from "./keyword-coverage.js";
import { resolveConfig } from "../config.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";

function createSession(
  sessionId: string,
  overrides: Partial<SessionData> = {},
): SessionData {
  return {
    sessionId,
    agentId: "main",
    current: {
      input: "test input",
      result: "test result",
      timestamps: { start: new Date().toISOString() },
    },
    ...overrides,
  };
}

describe("discoverKeywordCoverageCandidates", () => {
  const config = resolveConfig({}).review.triggers;
  // Existing keywords that should NOT appear in coverage-gap candidates
  const keywords: ReviewTriggerKeywords = {
    successfulPattern: ["verified", "完成"],
    behaviorFix: ["不對", "redo"],
    entityContext: ["指的是", "means"],
  };

  it("returns empty candidates when no sessions provided", () => {
    const input: CoverageDiscoveryInput = {
      sessions: [],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions).toEqual({
      "successful-pattern": [],
      "behavior-fix": [],
      "entity-context": [],
    });
    expect(result.removals).toEqual({
      "successful-pattern": [],
      "behavior-fix": [],
      "entity-context": [],
    });
  });

  it("selects successful-pattern candidates with tool calls (coverage gap: no keyword match)", () => {
    const session = createSession("session-1", {
      current: {
        input: "implement feature",
        result: "done, success", // Does NOT match existing keywords
        toolCalls: Array.from({ length: 5 }, (_, i) => ({ name: `tool-${i}`, params: {} })),
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"]).toHaveLength(1);
    expect(result.additions["successful-pattern"][0].ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.additions["successful-pattern"][0].input).toBe("implement feature");
    expect(result.additions["successful-pattern"][0].result).toBe("done, success");
    expect(result.additions["successful-pattern"][0].toolSummary).toHaveLength(5);
  });

  it("selects successful-pattern candidates with skillsUsed (coverage gap)", () => {
    const session = createSession("session-2", {
      current: {
        input: "write tests",
        result: "all passed", // Does NOT match existing keywords
        skillsUsed: [{ name: "test-driven-development", path: "skills/tdd" }],
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"]).toHaveLength(1);
  });

  it("excludes successful-pattern when state has error", () => {
    const session = createSession("session-3", {
      current: {
        input: "fix bug",
        result: "done",
        error: "test failed",
        toolCalls: [{ name: "read", params: {} }],
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"]).toHaveLength(0);
  });

  it("excludes successful-pattern when no tool calls or skills", () => {
    const session = createSession("session-4", {
      current: {
        input: "simple question",
        result: "done",
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"]).toHaveLength(0);
  });

  it("excludes successful-pattern when existing keywords match (not a coverage gap)", () => {
    const session = createSession("session-gap", {
      current: {
        input: "implement feature",
        result: "完成，verified", // MATCHES existing keywords
        toolCalls: Array.from({ length: 5 }, (_, i) => ({ name: `tool-${i}`, params: {} })),
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"]).toHaveLength(0);
  });

  it("selects behavior-fix candidates without quoted content markers (coverage gap)", () => {
    const session = createSession("session-5", {
      current: {
        input: "adjust approach, try different method", // Does NOT match existing keywords
        result: "fixed",
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["behavior-fix"]).toHaveLength(1);
    expect(result.additions["behavior-fix"][0].input).toBe("adjust approach, try different method");
  });

  it("excludes behavior-fix when input contains quoted content markers", () => {
    const session = createSession("session-6", {
      current: {
        input: "Write a dream diary entry from these memory fragments: adjust approach",
        result: "done",
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["behavior-fix"]).toHaveLength(0);
  });

  it("selects entity-context candidates with source signal (coverage gap)", () => {
    const session = createSession("session-7", {
      current: {
        input: "Yumi refers to Hermes, check TOOLS.md", // Does NOT match existing keywords
        result: "found it",
        toolCalls: [{ name: "read", params: { path: "TOOLS.md" } }],
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["entity-context"]).toHaveLength(1);
  });

  it("excludes entity-context without source signal", () => {
    const session = createSession("session-8", {
      current: {
        input: "Yumi refers to Hermes",
        result: "ok",
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["entity-context"]).toHaveLength(0);
  });

  it("limits each target to 8 candidates maximum", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      createSession(`session-${i}`, {
        current: {
          input: `input ${i}`,
          result: "done", // Does NOT match existing keywords
          toolCalls: [{ name: "read", params: {} }],
          timestamps: { start: new Date().toISOString() },
        },
      }),
    );

    const input: CoverageDiscoveryInput = {
      sessions,
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    expect(result.additions["successful-pattern"].length).toBeLessThanOrEqual(8);
  });

  it("rotates cursor across sessions deterministically", () => {
    // Each session has different content to ensure distinct refs
    const sessions = Array.from({ length: 5 }, (_, i) =>
      createSession(`session-${i}`, {
        current: {
          input: `input ${i}`,
          result: `done ${i}`, // Does NOT match existing keywords
          toolCalls: Array.from({ length: 5 }, (_, j) => ({ name: `tool-${j}`, params: {} })),
          timestamps: { start: new Date().toISOString() },
        },
      }),
    );

    const input1: CoverageDiscoveryInput = {
      sessions,
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result1 = discoverKeywordCoverageCandidates(input1);
    const firstRef = result1.additions["successful-pattern"][0]?.ref;

    const input2: CoverageDiscoveryInput = {
      sessions,
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 3, "behavior-fix": 0, "entity-context": 0 },
    };

    const result2 = discoverKeywordCoverageCandidates(input2);
    const secondRef = result2.additions["successful-pattern"][0]?.ref;

    expect(firstRef).toBeDefined();
    expect(secondRef).toBeDefined();
    expect(firstRef).not.toBe(secondRef);
  });

  it("prioritizes distinct sessions before repeating", () => {
    const session1 = createSession("session-a", {
      current: {
        input: "first",
        result: "done", // Does NOT match existing keywords
        toolCalls: [{ name: "read", params: {} }],
        timestamps: { start: new Date().toISOString() },
      },
    });

    const session2 = createSession("session-b", {
      current: {
        input: "second",
        result: "success", // Does NOT match existing keywords
        toolCalls: [{ name: "read", params: {} }],
        timestamps: { start: new Date().toISOString() },
      },
    });

    const input: CoverageDiscoveryInput = {
      sessions: [session1, session2],
      config,
      triggerKeywords: keywords,
      cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    };

    const result = discoverKeywordCoverageCandidates(input);

    const refs = result.additions["successful-pattern"].map((c: CoverageCandidateDocument) => c.ref);
    const uniqueRefs = new Set(refs);
    expect(uniqueRefs.size).toBe(refs.length);
  });
});

describe("replayKeywordPhrase", () => {
  const config = resolveConfig({}).review.triggers;
  const keywords: ReviewTriggerKeywords = {
    successfulPattern: ["verified"],
    behaviorFix: ["不對"],
    entityContext: ["指的是"],
  };

  it("returns matches when phrase appears in input", () => {
    const input: CoverageReplayInput = {
      phrase: "不對",
      target: "behavior-fix",
      documents: [
        {
          ref: "abc123",
          target: "behavior-fix",
          input: "不對，應該是另一個做法",
          toolSummary: [],
        },
      ],
      config,
      triggerKeywords: keywords,
    };

    const result = replayKeywordPhrase(input);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].ref).toBe("abc123");
  });

  it("returns matches when phrase appears in result", () => {
    const input: CoverageReplayInput = {
      phrase: "verified",
      target: "successful-pattern",
      documents: [
        {
          ref: "def456",
          target: "successful-pattern",
          input: "implement feature",
          result: "完成，verified",
          toolSummary: [],
        },
      ],
      config,
      triggerKeywords: keywords,
    };

    const result = replayKeywordPhrase(input);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].ref).toBe("def456");
  });

  it("returns no matches when phrase does not appear", () => {
    const input: CoverageReplayInput = {
      phrase: "missing",
      target: "behavior-fix",
      documents: [
        {
          ref: "ghi789",
          target: "behavior-fix",
          input: "some other text",
          toolSummary: [],
        },
      ],
      config,
      triggerKeywords: keywords,
    };

    const result = replayKeywordPhrase(input);

    expect(result.matches).toHaveLength(0);
  });

  it("uses case-insensitive matching", () => {
    const input: CoverageReplayInput = {
      phrase: "VERIFIED",
      target: "successful-pattern",
      documents: [
        {
          ref: "jkl012",
          target: "successful-pattern",
          input: "test",
          result: "verified",
          toolSummary: [],
        },
      ],
      config,
      triggerKeywords: keywords,
    };

    const result = replayKeywordPhrase(input);

    expect(result.matches).toHaveLength(1);
  });

  it("returns empty matches for empty documents", () => {
    const input: CoverageReplayInput = {
      phrase: "test",
      target: "behavior-fix",
      documents: [],
      config,
      triggerKeywords: keywords,
    };

    const result = replayKeywordPhrase(input);

    expect(result.matches).toHaveLength(0);
  });
});
