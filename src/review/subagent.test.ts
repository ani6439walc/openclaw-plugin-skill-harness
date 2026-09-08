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

  it("gives health checks the full catalog for boundary maintenance", () => {
    const prompt = buildReviewPrompt(snapshot, ["intent-health-check"]);

    expect(prompt).toContain("intent-health-check: Review focus:");
    expect(prompt).toContain("analyze complexity, overlap, and stale coverage");
    expect(prompt).toContain("create, refine, split, merge, or delete");
    expect(prompt).toContain("<intent_catalog>");
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

  it("keeps valid standalone delete findings", () => {
    expect(
      parseReviewFindings(
        JSON.stringify({
          findings: [
            {
              trigger: "intent-health-check",
              hasFinding: true,
              targetKind: "intent-markdown",
              operation: "delete",
              targetIntentIds: ["obsolete"],
              dedupeKey: "obsolete-intent",
              summary: "Remove an obsolete intent.",
              evidence: ["The catalog has a durable duplicate boundary."],
              correctionGoal: "Remove the redundant runtime intent.",
              suggestedChange: "Delete obsolete.md.",
            },
          ],
        }),
        ["intent-health-check"],
      ),
    ).toEqual([
      expect.objectContaining({
        trigger: "intent-health-check",
        operation: "delete",
        targetIntentIds: ["obsolete"],
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

    return {
      result: await runReviewSubagent({
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
      }),
      runEmbeddedAgent: api.runtime.agent.runEmbeddedAgent,
      deleteSession,
    };
  }

  it("uses a detached session without scheduling persistent cleanup", async () => {
    const { result, runEmbeddedAgent, deleteSession } =
      await runNoFindingReview(vi.fn());

    expect(result.outcome).toBe("nofinding");
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPersistence: "detached" }),
    );
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("applies a standalone reviewer-owned intent deletion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-delete-"));
    tempRoots.push(root);
    fs.writeFileSync(
      path.join(root, "obsolete.md"),
      "---\ntriggers:\n  - obsolete\nexamples:\n  - obsolete\ndomain: other\nkeywords:\n  - obsolete\n---\nRetire this obsolete route.\n",
    );
    fs.writeFileSync(
      path.join(root, "other.md"),
      "---\ntriggers:\n  - other\nexamples:\n  - help\ndomain: other\nkeywords:\n  - help\n---\nAsk for context.\n",
    );
    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          fs.rmSync(path.join(workspaceDir, "obsolete.md"));
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: ["obsolete"],
                      dedupeKey: "obsolete-intent",
                      summary: "Remove an obsolete intent.",
                      evidence: [
                        "The catalog has a durable duplicate boundary.",
                      ],
                      correctionGoal: "Remove the redundant runtime intent.",
                      suggestedChange: "Delete obsolete.md.",
                    },
                  ],
                }),
              },
            ],
          };
        },
      );
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        subagent: { deleteSession: vi.fn() },
      },
    } as unknown as OpenClawPluginApi;

    const result = await runReviewSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["intent-health-check"],
    });

    expect(result.outcome).toBe("applied");
    expect(result.changedIntentIds).toEqual(["obsolete"]);
    expect(result.findings[0]).toMatchObject({
      operation: "delete",
      targetIntentIds: ["obsolete"],
    });
    expect(fs.existsSync(path.join(root, "obsolete.md"))).toBe(false);
  });

  it("rejects deletion of the last runtime intent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-delete-last-"));
    tempRoots.push(root);
    fs.writeFileSync(
      path.join(root, "obsolete.md"),
      "---\ntriggers:\n  - obsolete\nexamples:\n  - obsolete\ndomain: other\nkeywords:\n  - obsolete\n---\nRetire this obsolete route.\n",
    );
    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          fs.rmSync(path.join(workspaceDir, "obsolete.md"));
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: ["obsolete"],
                      dedupeKey: "obsolete-intent",
                      summary: "Remove an obsolete intent.",
                      evidence: ["The catalog contains no surviving route."],
                      correctionGoal: "Remove the redundant runtime intent.",
                      suggestedChange: "Delete obsolete.md.",
                    },
                  ],
                }),
              },
            ],
          };
        },
      );
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        subagent: { deleteSession: vi.fn() },
      },
    } as unknown as OpenClawPluginApi;

    const result = await runReviewSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["intent-health-check"],
    });

    expect(result.outcome).toBe("validation-failed");
    expect(result.validationErrors).toContain("no intent Markdown files found");
    expect(fs.existsSync(path.join(root, "obsolete.md"))).toBe(true);
  });

  it("revalidates the complete live catalog before deleting an intent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-delete-live-"));
    tempRoots.push(root);
    fs.writeFileSync(
      path.join(root, "obsolete.md"),
      "---\ntriggers:\n  - obsolete\nexamples:\n  - obsolete\ndomain: other\nkeywords:\n  - obsolete\n---\nRetire this obsolete route.\n",
    );
    fs.writeFileSync(
      path.join(root, "other.md"),
      "---\ntriggers:\n  - other\nexamples:\n  - help\ndomain: other\nkeywords:\n  - help\n---\nAsk for context.\n",
    );
    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          fs.rmSync(path.join(workspaceDir, "obsolete.md"));
          fs.writeFileSync(path.join(root, "other.md"), "invalid\n");
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: ["obsolete"],
                      dedupeKey: "obsolete-intent",
                      summary: "Remove an obsolete intent.",
                      evidence: [
                        "The catalog has a durable duplicate boundary.",
                      ],
                      correctionGoal: "Remove the redundant runtime intent.",
                      suggestedChange: "Delete obsolete.md.",
                    },
                  ],
                }),
              },
            ],
          };
        },
      );
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        subagent: { deleteSession: vi.fn() },
      },
    } as unknown as OpenClawPluginApi;

    const result = await runReviewSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["intent-health-check"],
    });

    expect(result.outcome).toBe("validation-failed");
    expect(
      result.validationErrors?.some((error) => error.includes("other.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "obsolete.md"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "other.md"), "utf8")).toBe(
      "invalid\n",
    );
  });

  it("allows multiple standalone deletes when the surviving catalog remains valid", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-delete-many-"));
    tempRoots.push(root);
    for (const [id, trigger, example, guidance] of [
      ["obsolete-a", "obsolete-a", "obsolete-a", "Retire this route."],
      ["obsolete-b", "obsolete-b", "obsolete-b", "Retire this route too."],
      ["other", "other", "help", "Ask for context."],
    ]) {
      fs.writeFileSync(
        path.join(root, `${id}.md`),
        `---\ntriggers:\n  - ${trigger}\nexamples:\n  - ${example}\ndomain: other\nkeywords:\n  - ${example}\n---\n${guidance}\n`,
      );
    }
    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          fs.rmSync(path.join(workspaceDir, "obsolete-a.md"));
          fs.rmSync(path.join(workspaceDir, "obsolete-b.md"));
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: ["obsolete-a"],
                      dedupeKey: "obsolete-a-intent",
                      summary: "Remove the first obsolete intent.",
                      evidence: ["The route is permanently redundant."],
                      correctionGoal: "Remove the redundant runtime intent.",
                      suggestedChange: "Delete obsolete-a.md.",
                    },
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: ["obsolete-b"],
                      dedupeKey: "obsolete-b-intent",
                      summary: "Remove the second obsolete intent.",
                      evidence: ["The route is permanently redundant."],
                      correctionGoal: "Remove the redundant runtime intent.",
                      suggestedChange: "Delete obsolete-b.md.",
                    },
                  ],
                }),
              },
            ],
          };
        },
      );
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        subagent: { deleteSession: vi.fn() },
      },
    } as unknown as OpenClawPluginApi;

    const result = await runReviewSubagent({
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["intent-health-check"],
    });

    expect(result.outcome).toBe("applied");
    expect(result.changedIntentIds).toEqual(["obsolete-a", "obsolete-b"]);
    expect(fs.existsSync(path.join(root, "other.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "obsolete-a.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "obsolete-b.md"))).toBe(false);
  });

  it("rejects a concurrent pair of deletes that would empty the catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-delete-race-"));
    tempRoots.push(root);
    for (const id of ["a", "b"]) {
      fs.writeFileSync(
        path.join(root, `${id}.md`),
        `---\ntriggers:\n  - ${id}\nexamples:\n  - ${id}\ndomain: other\nkeywords:\n  - ${id}\n---\nKeep ${id}.\n`,
      );
    }
    let arrived = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let invocation = 0;
    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          const target = invocation++ === 0 ? "a" : "b";
          fs.rmSync(path.join(workspaceDir, `${target}.md`));
          arrived += 1;
          if (arrived === 2) releaseBarrier?.();
          await barrier;
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "intent-health-check",
                      hasFinding: true,
                      targetKind: "intent-markdown",
                      operation: "delete",
                      targetIntentIds: [target],
                      dedupeKey: `${target}-intent`,
                      summary: `Remove ${target}.`,
                      evidence: ["The route is permanently redundant."],
                      correctionGoal: `Remove ${target}.md.`,
                      suggestedChange: `Delete ${target}.md.`,
                    },
                  ],
                }),
              },
            ],
          };
        },
      );
    const api = {
      config: {},
      runtime: {
        agent: { runEmbeddedAgent },
        subagent: { deleteSession: vi.fn() },
      },
    } as unknown as OpenClawPluginApi;
    const reviewParams = {
      api,
      config: resolveConfig({}),
      agentId: "main",
      intentDirectory: root,
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["intent-health-check"] as const,
    };

    const results = await Promise.all([
      runReviewSubagent(reviewParams),
      runReviewSubagent(reviewParams),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      "applied",
      "validation-failed",
    ]);
    expect(
      fs.readdirSync(root).filter((file) => file.endsWith(".md")),
    ).toHaveLength(1);
  });
});
