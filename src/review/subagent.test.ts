import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  buildReviewPrompt,
  hasRoutingSurfaceChange,
  parseReviewFindings,
  runReviewSubagent,
} from "./subagent.js";
import type { ReviewSnapshot } from "./types.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const snapshot: ReviewSnapshot = {
  sessionId: "session-1",
  sessionKey: "main-session-key",
  agentId: "main",
  eventId: "session-1:2026-06-11T00:00:00.000Z",
  turnNumber: 10,
  current: {
    input: "No, use the existing helper",
    intent: {
      intent: "other",
      reason: "unclear",
      confidence: 0.2,
      complexity: "high",
    },
    routeProvenance: { trigger: "qmd-hybrid" },
    capabilityFit: {
      source: "tool-call-threshold",
      observedSkillNames: ["test-driven-development"],
      turnHasToolErrors: false,
      recoveryVerified: false,
    },
    skillsUsed: [
      {
        name: "test-driven-development",
        description: "Drive changes with failing tests first.",
        path: "/skills/test-driven-development/SKILL.md",
      },
    ],
    toolCalls: [
      {
        name: "exec",
        params: { command: "pnpm run test", workdir: "/repo" },
        durationMs: 42,
      },
    ],
    result: "Done",
    timestamps: { start: "2026-06-11T00:00:00.000Z" },
  },
  recent: [],
  matchedIntent: {
    id: "other",
    definition: {
      triggers: ["Requests that do not match a defined intent"],
      examples: ["help with this"],
      domain: "other",
      keywords: ["help"],
      guidance: "Ask for context.",
    },
  },
  availableSkills: [],
  intentCatalog: [
    {
      id: "other",
      triggers: ["Requests that do not match a defined intent"],
      examples: ["help with this"],
      domain: "other",
      keywords: ["help"],
    },
    {
      id: "debugging",
      triggers: ["Fix a failing test"],
      examples: ["Why does this test fail?"],
      domain: "development",
      keywords: ["test", "failure"],
    },
  ],
};

describe("buildReviewPrompt", () => {
  it("gives routing uncertainty the full catalog and QMD-aware repair guidance", () => {
    const prompt = buildReviewPrompt(snapshot, ["routing-uncertainty"]);

    expect(prompt).toContain("routing-uncertainty: Review focus:");
    expect(prompt).toContain(
      "qmd-hybrid means repair examples and/or keywords",
    );
    expect(prompt).toContain(
      "trigger-only edit does not improve QMD retrieval",
    );
    expect(prompt).toContain("<intent_catalog>");
  });

  it("keeps routine health checks bounded to the matched intent", () => {
    const prompt = buildReviewPrompt(snapshot, ["intent-health-check"]);

    expect(prompt).toContain("intent-health-check: Review focus:");
    expect(prompt).toContain("do not create, split, or merge intents");
    expect(prompt).not.toContain("<intent_catalog>");
  });

  it("constrains capability fit to its explicit evidence source", () => {
    const prompt = buildReviewPrompt(snapshot, ["capability-fit"]);

    expect(prompt).toContain("capability-fit: Review focus:");
    expect(prompt).toContain(
      "Tool-call experiences require an error-free turn",
    );
    expect(prompt).toContain(
      "tool-failure experiences require demonstrated recovery and verification",
    );
    expect(prompt).not.toContain("trigger keyword");
  });
});

describe("parseReviewFindings", () => {
  it("keeps valid intent findings", () => {
    expect(
      parseReviewFindings(
        JSON.stringify({
          findings: [
            {
              trigger: "routing-uncertainty",
              hasFinding: true,
              targetKind: "intent-markdown",
              operation: "refine",
              targetIntentIds: ["other"],
              dedupeKey: "other-keywords",
              summary: "Add matching keyword",
              evidence: ["The route used qmd-keyword."],
              correctionGoal: "Improve keyword retrieval.",
              suggestedChange: "Add the stable phrase to keywords.",
            },
          ],
        }),
        ["routing-uncertainty"],
      ),
    ).toEqual([
      expect.objectContaining({
        trigger: "routing-uncertainty",
        targetKind: "intent-markdown",
      }),
    ]);
  });
});

it("detects only examples and keywords as QMD routing surfaces", () => {
  const before = new Map([
    [
      "other.md",
      "---\ntriggers: [other]\nexamples: [help]\ndomain: other\nkeywords: [help]\nskills: [analysis]\n---\nAsk for context.\n",
    ],
  ]);
  const withExamples = new Map([
    [
      "other.md",
      "---\ntriggers: [other]\nexamples: [help, explain this]\ndomain: other\nkeywords: [help]\nskills: [analysis]\n---\nAsk for context.\n",
    ],
  ]);
  const withKeywords = new Map([
    [
      "other.md",
      "---\ntriggers: [other]\nexamples: [help]\ndomain: other\nkeywords: [help, explain]\nskills: [analysis]\n---\nAsk for context.\n",
    ],
  ]);
  const classifierOnly = new Map([
    [
      "other.md",
      "---\ntriggers: [other, clarify]\nexamples: [help]\ndomain: other\nkeywords: [help]\nskills: [analysis, debugging]\n---\nExplain the current context.\n",
    ],
  ]);

  expect(
    hasRoutingSurfaceChange({
      before,
      after: withExamples,
      changedIds: ["other"],
    }),
  ).toBe(true);
  expect(
    hasRoutingSurfaceChange({
      before,
      after: withKeywords,
      changedIds: ["other"],
    }),
  ).toBe(true);
  expect(
    hasRoutingSurfaceChange({
      before,
      after: classifierOnly,
      changedIds: ["other"],
    }),
  ).toBe(false);
});

describe("runReviewSubagent", () => {
  async function runNoFindingReview(deleteSession: ReturnType<typeof vi.fn>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-intents-"));
    tempRoots.push(root);
    fs.writeFileSync(
      path.join(root, "other.md"),
      "---\ntriggers:\n  - other\nexamples:\n  - help\ndomain: other\nkeywords:\n  - help\n---\nAsk for context.\n",
    );
    const api = {
      config: {},
      runtime: {
        agent: {
          runEmbeddedAgent: vi.fn().mockResolvedValue({
            payloads: [
              {
                text: JSON.stringify({
                  findings: [{ trigger: "capability-fit", hasFinding: false }],
                }),
              },
            ],
          }),
        },
        subagent: { deleteSession },
      },
    } as unknown as OpenClawPluginApi;

    return runReviewSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot: {
        ...snapshot,
        current: {
          ...snapshot.current,
          capabilityFit: {
            ...snapshot.current.capabilityFit!,
            turnHasToolErrors: true,
          },
        },
      },
      triggers: ["capability-fit"],
    });
  }

  it("cleans up its session after a no-finding review", async () => {
    const deleteSession = vi.fn();

    const result = await runNoFindingReview(deleteSession);

    expect(result.outcome).toBe("nofinding");
    expect(deleteSession).toHaveBeenCalledWith({
      sessionKey: "agent:main:skill-harness-review:2959d5f1da6a",
      deleteTranscript: true,
    });
  });

  it("keeps the review outcome when cleanup fails", async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new Error("cleanup failed"));

    const result = await runNoFindingReview(deleteSession);

    expect(result.outcome).toBe("nofinding");
  });
});
