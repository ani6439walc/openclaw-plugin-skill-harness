import { describe, expect, it, vi } from "vitest";
import {
  buildKeywordCoverageDiscoveryPrompt,
  runKeywordCoverageReview,
} from "./keyword-coverage-subagent.js";
import type { KeywordCoverageReviewParams } from "./keyword-coverage-subagent.js";
import type { CoverageCandidateDocument } from "./keyword-coverage.js";
import type { ReviewTriggerKeywords } from "./trigger-keywords.js";

describe("runKeywordCoverageReview", () => {
  const triggerKeywords: ReviewTriggerKeywords = {
    successfulPattern: ["完成", "verified"],
    behaviorFix: ["不對", "redo"],
    entityContext: ["指的是", "means"],
  };

  const baseDocuments: CoverageCandidateDocument[] = [
    {
      ref: "abc123",
      target: "successful-pattern",
      input: "implement feature",
      result: "完成，verified",
      toolSummary: [{ name: "read", success: true }],
    },
    {
      ref: "def456",
      target: "behavior-fix",
      input: "不對，應該是另一個做法",
      toolSummary: [],
    },
  ];

  const baseParams: Omit<KeywordCoverageReviewParams, "modelResponse"> = {
    dataRoot: "/tmp/test-data",
    agentId: "main",
    sessionId: "test-session",
    triggerKeywords,
    documents: baseDocuments,
    cursor: { "successful-pattern": 0, "behavior-fix": 0, "entity-context": 0 },
    config: {
      model: "test-model",
      modelFallback: undefined,
      thinking: "medium",
      timeoutMs: 30000,
    },
  };

  describe("tool-free boundary", () => {
    it("rejects when model attempts to use tools", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
        toolCalls: [{ name: "read", params: { path: "file.ts" } }],
      });

      expect(result).toBeUndefined();
    });
  });

  describe("XML-like indentation and escaping", () => {
    it("handles XML-like content in document input/result", async () => {
      const documentsWithXml: CoverageCandidateDocument[] = [
        {
          ref: "xml123",
          target: "successful-pattern",
          input: "<conversation_context>test</conversation_context>",
          result: "完成",
          toolSummary: [],
        },
      ];

      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["xml123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        documents: documentsWithXml,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(1);
      expect(result?.decisions[0].outcome).toBe("finding");
    });

    it("escapes special characters in prompt construction", async () => {
      const documentsWithSpecialChars: CoverageCandidateDocument[] = [
        {
          ref: "special123",
          target: "successful-pattern",
          input: "test with <tag> & \"quotes\" and 'apostrophes'",
          result: "完成",
          toolSummary: [],
        },
      ];

      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["special123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        documents: documentsWithSpecialChars,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(1);
    });
  });

  describe("JSON enum validation", () => {
    it("accepts valid outcome enum values", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "behavior-fix",
            outcome: "nofinding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(2);
      expect(result?.decisions[0].outcome).toBe("finding");
      expect(result?.decisions[1].outcome).toBe("nofinding");
    });

    it("rejects invalid outcome enum", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "invalid-outcome",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });

    it("rejects invalid target enum", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "invalid-target",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });
  });

  describe("per-target max counts", () => {
    it("enforces maximum 1 addition per target", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "successful-pattern",
            addition: { phrase: "verified", supportRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      // Should only accept first addition, reject second
      expect(result?.decisions).toHaveLength(1);
      expect(result?.decisions[0].addition?.phrase).toBe("完成");
    });

    it("enforces maximum 1 removal per target", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            removal: { phrase: "完成", falsePositiveRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "successful-pattern",
            removal: { phrase: "verified", falsePositiveRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      // Should only accept first removal, reject second
      expect(result?.decisions).toHaveLength(1);
      expect(result?.decisions[0].removal?.phrase).toBe("完成");
    });

    it("allows one addition and one removal per target", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "successful-pattern",
            removal: { phrase: "verified", falsePositiveRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(2);
    });
  });

  describe("invalid refs handling", () => {
    it("rejects findings with non-existent refs", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["nonexistent"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });

    it("rejects findings with empty supportRefs array", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: [] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });

    it("rejects findings with refs from wrong target", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["def456"] }, // def456 is behavior-fix
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });
  });

  describe("duplicate and cross-target phrases", () => {
    it("rejects duplicate phrases within same target", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      // Should only accept first occurrence
      expect(result?.decisions).toHaveLength(1);
    });

    it("allows same phrase across different targets", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "完成", supportRefs: ["abc123"] },
            outcome: "finding",
          },
          {
            target: "behavior-fix",
            addition: { phrase: "完成", supportRefs: ["def456"] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(2);
    });
  });

  describe("malformed JSON handling", () => {
    it("returns undefined for invalid JSON", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: "{ invalid json",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for missing decisions field", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: JSON.stringify({ invalid: "structure" }),
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for non-array decisions", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: JSON.stringify({ decisions: "not-an-array" }),
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for decision missing required fields", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: JSON.stringify({
          decisions: [
            {
              target: "successful-pattern",
              // missing outcome
            },
          ],
        }),
      });

      expect(result).toBeUndefined();
    });
  });

  describe("subagent error behavior", () => {
    it("returns undefined when model throws error", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: undefined,
        error: new Error("model timeout"),
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined when model returns empty response", async () => {
      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse: "",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("incomplete removal hit coverage", () => {
    it("rejects removal without falsePositiveRefs", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            removal: { phrase: "完成" },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });

    it("rejects removal with empty falsePositiveRefs", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            removal: { phrase: "完成", falsePositiveRefs: [] },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });
  });

  describe("finding without addition or removal", () => {
    it("rejects finding outcome without addition or removal", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result).toBeUndefined();
    });
  });

  describe("nofinding outcome", () => {
    it("accepts nofinding without addition or removal", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            outcome: "nofinding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        modelResponse,
      });

      expect(result?.decisions).toHaveLength(1);
      expect(result?.decisions[0].outcome).toBe("nofinding");
    });

    it("rejects nofinding with a keyword mutation", async () => {
      const modelResponse = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: { phrase: "durable phrase", supportRefs: ["abc123"] },
            outcome: "nofinding",
          },
        ],
      });

      await expect(
        runKeywordCoverageReview({ ...baseParams, modelResponse }),
      ).resolves.toBeUndefined();
    });
  });

  describe("two-pass discovery and adjudication", () => {
    it("runs discovery, host replay, and adjudication with staged responses", async () => {
      const documents: CoverageCandidateDocument[] = [
        {
          ref: "abc123",
          target: "successful-pattern",
          input: "implement feature",
          result: "完成，verified with durable-success-phrase",
          toolSummary: [{ name: "read", success: true }],
        },
      ];

      const discovery = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: {
              phrase: "durable-success-phrase",
              supportRefs: ["abc123"],
            },
            outcome: "finding",
          },
        ],
      });
      const adjudication = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: {
              phrase: "durable-success-phrase",
              supportRefs: ["abc123"],
            },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        documents,
        stagedModelResponses: { discovery, adjudication },
      });

      expect(result?.decisions).toEqual([
        {
          target: "successful-pattern",
          addition: {
            phrase: "durable-success-phrase",
            supportRefs: ["abc123"],
          },
          outcome: "finding",
        },
      ]);
    });

    it("drops discovery additions that fail host literal replay", async () => {
      const documents: CoverageCandidateDocument[] = [
        {
          ref: "abc123",
          target: "successful-pattern",
          input: "implement feature",
          result: "done",
          toolSummary: [{ name: "read", success: true }],
        },
      ];

      const discovery = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: {
              phrase: "not-present-in-document",
              supportRefs: ["abc123"],
            },
            outcome: "finding",
          },
        ],
      });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        documents,
        stagedModelResponses: { discovery },
      });

      expect(result?.decisions).toEqual([
        {
          target: "successful-pattern",
          outcome: "nofinding",
        },
      ]);
    });

    it("uses tool-free embedded agent passes when api is provided", async () => {
      const documents: CoverageCandidateDocument[] = [
        {
          ref: "abc123",
          target: "successful-pattern",
          input: "implement feature",
          result: "durable-success-phrase completed",
          toolSummary: [{ name: "read", success: true }],
        },
      ];

      const discovery = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: {
              phrase: "durable-success-phrase",
              supportRefs: ["abc123"],
            },
            outcome: "finding",
          },
        ],
      });
      const adjudication = JSON.stringify({
        decisions: [
          {
            target: "successful-pattern",
            addition: {
              phrase: "durable-success-phrase",
              supportRefs: ["abc123"],
            },
            outcome: "finding",
          },
        ],
      });

      const runEmbeddedAgent = vi
        .fn()
        .mockResolvedValueOnce({ payloads: [{ text: discovery }] })
        .mockResolvedValueOnce({ payloads: [{ text: adjudication }] });

      const result = await runKeywordCoverageReview({
        ...baseParams,
        documents,
        api: {
          config: {},
          runtime: { agent: { runEmbeddedAgent } },
        } as never,
        modelRef: { provider: "openai", model: "test-model" },
      });

      expect(result?.decisions[0]?.addition?.phrase).toBe(
        "durable-success-phrase",
      );
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      expect(runEmbeddedAgent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          modelRun: false,
          promptMode: "none",
          toolsAllow: [],
          disableTools: true,
          sessionFile: expect.stringContaining(
            "/agents/keyword-coverage/sessions/",
          ),
          prompt: expect.stringContaining("<keyword_coverage_discovery>"),
        }),
      );
      expect(runEmbeddedAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          modelRun: false,
          promptMode: "none",
          toolsAllow: [],
          disableTools: true,
          prompt: expect.stringContaining("<keyword_coverage_adjudication>"),
        }),
      );
      expect(runEmbeddedAgent.mock.calls[0][0].prompt).not.toContain(
        "test-session",
      );
      expect(runEmbeddedAgent.mock.calls[0][0].prompt).not.toContain(
        "/tmp/test-data",
      );
    });
  });

  describe("prompt builders", () => {
    it("escapes XML-like evidence and omits session identifiers", () => {
      const documents: CoverageCandidateDocument[] = [
        {
          ref: "ref-1",
          target: "entity-context",
          input: '<session id="secret-session">Yumi 指的是 Hermes</session>',
          result: "mapped",
          toolSummary: [],
        },
      ];

      const prompt = buildKeywordCoverageDiscoveryPrompt(
        documents,
        triggerKeywords,
      );

      expect(prompt).toContain("<keyword_coverage_discovery>");
      expect(prompt).toContain("&lt;session id=&quot;secret-session&quot;");
      expect(prompt).not.toContain('id="secret-session"');
      expect(prompt).not.toContain("test-session");
      expect(prompt).not.toContain("/tmp/test-data");
    });
  });
});
