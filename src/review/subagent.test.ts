import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, type OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  buildReviewPrompt,
  getReviewModelRef,
  hasRoutingSurfaceChange,
  parseReviewFindings,
  parseReviewFindingsDetailed,
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
    input: "Run the tests and fix any failures",
    matchedSkills: ["test-driven-development"],
    matchedExperiences: ["exp-tdd"],
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
  availableSkills: [
    {
      name: "test-driven-development",
      description: "Drive changes with failing tests first.",
      location: "/skills/test-driven-development/SKILL.md",
    },
  ],
  activeExperiences: [
    {
      id: "exp-tdd",
      path: "/experiences/exp-tdd",
      summary: "Use red-green-refactor loop to fix test failures.",
      keywords: ["test", "tdd", "failure"],
      skills: ["test-driven-development"],
      body: "Run pnpm test before modifying code.",
    },
  ],
};

describe("buildReviewPrompt", () => {
  it("gives experience health checks full guidance for catalog curation", () => {
    const prompt = buildReviewPrompt(snapshot, ["experience-health-check"]);

    expect(prompt).toContain("experience-health-check: Review focus:");
    expect(prompt).toContain("Curate high-value skill experiences");
    expect(prompt).toContain("experiences/<id>/");
  });

  it("gives routing uncertainty guidance to capture missing reusable workflows", () => {
    const prompt = buildReviewPrompt(snapshot, ["routing-uncertainty"]);

    expect(prompt).toContain("routing-uncertainty: Review focus:");
    expect(prompt).toContain("Capture the missing reusable workflow");
  });

  it("constrains capability fit to tool failure recovery and verified evidence", () => {
    const prompt = buildReviewPrompt(snapshot, ["capability-fit"]);

    expect(prompt).toContain("capability-fit: Review focus:");
    expect(prompt).toContain("demonstrated recovery and verification");
  });

  it.each([
    "experience-health-check",
    "routing-uncertainty",
    "capability-fit",
  ] as const)(
    "requires coverage checks and bounds skill discovery for %s",
    (trigger) => {
      const prompt = buildReviewPrompt(snapshot, [trigger], undefined, [
        "writer",
      ]);
      expect(prompt).toContain(
        "Eligible observed skills for experiences: writer.",
      );
      expect(prompt).toContain("Before creating an experience");
      expect(prompt).toContain("Refine the existing ID");
      expect(prompt).toContain(
        "You may merge two or more existing experiences",
      );
      expect(prompt).toContain("every deleted ID in targetExperienceIds");
      expect(prompt).toContain("You may delete experiences");
      expect(prompt).toContain("age alone do not justify deletion");
      expect(prompt).toContain(
        "Use exec only for necessary experience maintenance",
      );
      expect(prompt).toContain(
        "never use .., $HOME, or absolute paths outside the temporary workspace",
      );
      expect(prompt).toContain("Prompt scope is not shell containment");
      expect(prompt).toContain(
        "use skill_search with a focused query, limit: 5",
      );
      expect(prompt).toContain(
        "not complete workflows or evidence of execution",
      );
      expect(prompt).toContain(
        "Search never expands the eligible observed skill list",
      );
    },
  );

  it("requires unassociated entries when no eligible observed skills exist", () => {
    const prompt = buildReviewPrompt(snapshot, ["capability-fit"]);
    expect(prompt).toContain(
      "none; omit skills.md on entries you create or modify",
    );
    expect(prompt).not.toContain("all visible skills");
  });
});

describe("parseReviewFindings", () => {
  it("keeps valid skill-experience findings", () => {
    expect(
      parseReviewFindings(
        JSON.stringify({
          findings: [
            {
              trigger: "experience-health-check",
              hasFinding: true,
              targetKind: "skill-experience",
              operation: "refine",
              targetExperienceIds: ["exp-tdd"],
              dedupeKey: "exp-tdd-refine",
              summary: "Refine keywords for TDD workflow",
              evidence: ["Missing vitest keyword"],
              correctionGoal: "Improve keyword retrieval for Vitest runs",
              suggestedChange: "Add vitest to keywords.md",
            },
          ],
        }),
        ["experience-health-check"],
      ),
    ).toEqual([
      expect.objectContaining({
        trigger: "experience-health-check",
        targetKind: "skill-experience",
        operation: "refine",
        targetExperienceIds: ["exp-tdd"],
      }),
    ]);
  });
});

it("detects experience changes as routing surface change", () => {
  expect(
    hasRoutingSurfaceChange({
      changedExperienceIds: ["exp-tdd"],
    }),
  ).toBe(true);

  expect(
    hasRoutingSurfaceChange({
      changedExperienceIds: [],
    }),
  ).toBe(false);
});

describe("runReviewSubagent", () => {
  async function runNoFindingReview(deleteSession: ReturnType<typeof vi.fn>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-experiences-"));
    tempRoots.push(root);

    const expDir = path.join(root, "exp-1");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(
      path.join(expDir, "summary.md"),
      "Sample experience summary.",
    );
    fs.writeFileSync(path.join(expDir, "keywords.md"), "sample, test");
    fs.writeFileSync(path.join(expDir, "body.md"), "Sample experience body.");
    fs.writeFileSync(path.join(expDir, "skills.md"), "test-driven-development");

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
        experienceDirectory: root,
        allowedExperienceSkills: ["test-driven-development"],
        modelRef: { provider: "test", model: "review" },
        snapshot,
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

  it("applies a reviewer-owned experience update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-apply-"));
    tempRoots.push(root);

    const expDir = path.join(root, "exp-1");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, "summary.md"), "Initial summary.");
    fs.writeFileSync(path.join(expDir, "keywords.md"), "initial");
    fs.writeFileSync(path.join(expDir, "body.md"), "Initial body.");
    fs.writeFileSync(path.join(expDir, "skills.md"), "test-driven-development");

    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          const targetDir = path.join(workspaceDir, "experiences", "exp-1");
          fs.writeFileSync(
            path.join(targetDir, "summary.md"),
            "Updated summary for TDD workflow.",
          );
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "experience-health-check",
                      hasFinding: true,
                      targetKind: "skill-experience",
                      operation: "refine",
                      targetExperienceIds: ["exp-1"],
                      dedupeKey: "exp-1-refine",
                      summary: "Improve summary description",
                      evidence: ["Initial summary lacked context"],
                      correctionGoal: "Make summary descriptive",
                      suggestedChange: "Update summary.md",
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
      experienceDirectory: root,
      allowedExperienceSkills: ["test-driven-development"],
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["experience-health-check"],
    });

    expect(result.outcome).toBe("applied");
    expect(result.changedExperienceIds).toEqual(["exp-1"]);
    expect(result.findings[0]).toMatchObject({
      targetKind: "skill-experience",
      operation: "refine",
      targetExperienceIds: ["exp-1"],
    });
    expect(
      fs.readFileSync(path.join(root, "exp-1", "summary.md"), "utf8"),
    ).toBe("Updated summary for TDD workflow.");
  });

  it("rejects experience update if validation fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-invalid-"));
    tempRoots.push(root);

    const expDir = path.join(root, "exp-1");
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, "summary.md"), "Initial summary.");
    fs.writeFileSync(path.join(expDir, "keywords.md"), "initial");
    fs.writeFileSync(path.join(expDir, "body.md"), "Initial body.");

    const runEmbeddedAgent = vi
      .fn()
      .mockImplementation(
        async ({ workspaceDir }: { workspaceDir: string }) => {
          // Break validation by removing required body.md
          const targetDir = path.join(workspaceDir, "experiences", "exp-1");
          fs.rmSync(path.join(targetDir, "body.md"));
          return {
            payloads: [
              {
                text: JSON.stringify({
                  findings: [
                    {
                      trigger: "experience-health-check",
                      hasFinding: true,
                      targetKind: "skill-experience",
                      operation: "refine",
                      targetExperienceIds: ["exp-1"],
                      dedupeKey: "exp-1-broken",
                      summary: "Invalid removal",
                      evidence: ["Removed body"],
                      correctionGoal: "Break validation",
                      suggestedChange: "Remove body.md",
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
      experienceDirectory: root,
      allowedExperienceSkills: ["test-driven-development"],
      modelRef: { provider: "test", model: "review" },
      snapshot,
      triggers: ["experience-health-check"],
    });

    expect(result.outcome).toBe("validation-failed");
    expect(result.validationErrors?.length).toBeGreaterThan(0);
    // Original file remains intact
    expect(fs.existsSync(path.join(root, "exp-1", "body.md"))).toBe(true);
  });
});

describe("review writeback boundaries", () => {
  async function review(
    edit: (workspace: string, runtime: string) => void,
    targets: string[] = ["exp-one"],
    operation: "create" | "refine" | "merge" | "delete" = "refine",
    mergeFields: {
      sourceExperienceIds?: string[];
      retainedExperienceId?: string;
    } = {},
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-boundary-"));
    tempRoots.push(root);
    for (const [id, skill] of [
      ["exp-one", "writer"],
      ["exp-other", "reader"],
    ]) {
      const directory = path.join(root, id!);
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, "summary.md"),
        "A reusable workflow.",
      );
      fs.writeFileSync(path.join(directory, "keywords.md"), "workflow");
      fs.writeFileSync(path.join(directory, "body.md"), "Original procedure.");
      fs.writeFileSync(path.join(directory, "skills.md"), skill!);
    }
    const config = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        entries: { main: { tools: { fs: { workspaceOnly: false } } } },
      },
    };
    const runEmbeddedAgent = vi.fn(
      async ({ workspaceDir }: { workspaceDir: string }) => {
        edit(path.join(workspaceDir, "experiences"), root);
        return {
          payloads: [
            {
              text: JSON.stringify({
                findings: targets.length
                  ? [
                      {
                        trigger: "capability-fit",
                        hasFinding: true,
                        targetKind: "skill-experience",
                        operation,
                        ...mergeFields,
                        targetExperienceIds: targets,
                        dedupeKey: "fix",
                        summary: "Refine workflow",
                        evidence: ["Observed correction"],
                        correctionGoal: "Keep accurate steps",
                        suggestedChange: "Revise experience",
                      },
                    ]
                  : [{ trigger: "capability-fit", hasFinding: false }],
              }),
            },
          ],
        };
      },
    );
    const result = await runReviewSubagent({
      api: {
        config,
        runtime: { agent: { runEmbeddedAgent } },
      } as unknown as OpenClawPluginApi,
      config: resolveConfig({}),
      agentId: "main",
      experienceDirectory: root,
      allowedExperienceSkills: ["writer"],
      modelRef: { provider: "test", model: "test" },
      snapshot,
      triggers: ["capability-fit"],
    });
    return { result, root, config, runEmbeddedAgent };
  }

  it("sets both effective filesystem policies without mutating host config", async () => {
    const { runEmbeddedAgent, config } = await review(() => {}, []);
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          tools: { fs: { workspaceOnly: true } },
          agents: {
            entries: { main: { tools: { fs: { workspaceOnly: true } } } },
          },
        }),
        toolsAllow: [
          "ls",
          "read",
          "write",
          "edit",
          "exec",
          "skill_experience",
          "skill_search",
        ],
      }),
    );
    expect(config.tools.fs.workspaceOnly).toBe(false);
    expect(config.agents.entries.main.tools.fs.workspaceOnly).toBe(false);
  });

  it("validates changed entries without rejecting unrelated skill associations", async () => {
    const { result, root } = await review((workspace) => {
      fs.writeFileSync(
        path.join(workspace, "exp-one", "keywords.md"),
        "workflow\nverified",
      );
    });
    expect(result.outcome).toBe("applied");
    expect(
      fs.readFileSync(path.join(root, "exp-other", "skills.md"), "utf8"),
    ).toBe("reader");
  });

  it("preserves concurrent runtime changes and applies none of the review", async () => {
    const { result, root } = await review((workspace, runtime) => {
      fs.writeFileSync(
        path.join(workspace, "exp-one", "keywords.md"),
        "updated",
      );
      fs.writeFileSync(
        path.join(runtime, "exp-one", "body.md"),
        "User correction.",
      );
    });
    expect(result.outcome).toBe("validation-failed");
    expect(fs.readFileSync(path.join(root, "exp-one", "body.md"), "utf8")).toBe(
      "User correction.",
    );
    expect(
      fs.readFileSync(path.join(root, "exp-one", "keywords.md"), "utf8"),
    ).toBe("workflow");
  });

  it("removes an optional file deleted by the reviewer", async () => {
    const { result, root } = await review((workspace) => {
      fs.rmSync(path.join(workspace, "exp-one", "skills.md"));
    });
    expect(result.outcome).toBe("applied");
    expect(fs.existsSync(path.join(root, "exp-one", "skills.md"))).toBe(false);
  });

  it.each([false, true])(
    "rejects undeclared modification or deletion (delete=%s)",
    async (remove) => {
      const { result, root } = await review((workspace) => {
        if (remove)
          fs.rmSync(path.join(workspace, "exp-one"), { recursive: true });
        else
          fs.writeFileSync(
            path.join(workspace, "exp-one", "body.md"),
            "Undeclared update",
          );
      }, []);
      expect(result.outcome).toBe("validation-failed");
      expect(
        fs.readFileSync(path.join(root, "exp-one", "body.md"), "utf8"),
      ).toBe("Original procedure.");
    },
  );

  it("rejects findings that claim an edit without a corresponding change", async () => {
    const { result } = await review(() => {});
    expect(result.outcome).toBe("validation-failed");
  });

  it("applies a declared full deletion", async () => {
    const { result, root } = await review(
      (workspace, runtime) => {
        fs.writeFileSync(path.join(runtime, "exp-one", ".residue"), "stale");
        fs.rmSync(path.join(workspace, "exp-one"), { recursive: true });
      },
      ["exp-one"],
      "delete",
    );
    expect(result.outcome).toBe("applied");
    expect(fs.existsSync(path.join(root, "exp-one"))).toBe(false);
    expect(result.findings[0]?.operation).toBe("delete");
  });

  it.each(["create", "refine", "delete"] as const)(
    "rejects a mismatched %s declaration before writeback",
    async (operation) => {
      const { result, root } = await review(
        (workspace) => {
          if (operation === "refine") {
            fs.rmSync(path.join(workspace, "exp-one"), { recursive: true });
          } else {
            fs.writeFileSync(
              path.join(workspace, "exp-one", "body.md"),
              "Changed guidance.",
            );
          }
        },
        ["exp-one"],
        operation,
      );
      expect(result.outcome).toBe("validation-failed");
      expect(
        fs.readFileSync(path.join(root, "exp-one", "body.md"), "utf8"),
      ).toBe("Original procedure.");
    },
  );

  it("rejects deletion that leaves the directory behind", async () => {
    const { result, root } = await review(
      (workspace) => {
        const directory = path.join(workspace, "exp-one");
        for (const file of fs.readdirSync(directory))
          fs.rmSync(path.join(directory, file));
      },
      ["exp-one"],
      "delete",
    );
    expect(result.outcome).toBe("validation-failed");
    expect(fs.existsSync(path.join(root, "exp-one", "body.md"))).toBe(true);
  });

  it("applies a declared creation", async () => {
    const { result, root } = await review(
      (workspace) => {
        fs.cpSync(
          path.join(workspace, "exp-one"),
          path.join(workspace, "exp-new"),
          { recursive: true },
        );
      },
      ["exp-new"],
      "create",
    );
    expect(result.outcome).toBe("applied");
    expect(fs.existsSync(path.join(root, "exp-new", "body.md"))).toBe(true);
  });

  it("removes merge-source residue while retaining an unchanged survivor", async () => {
    const { result, root } = await review(
      (workspace, runtime) => {
        fs.writeFileSync(path.join(runtime, "exp-other", ".residue"), "stale");
        fs.rmSync(path.join(workspace, "exp-other"), { recursive: true });
      },
      ["exp-other"],
      "merge",
      { sourceExperienceIds: ["exp-other"], retainedExperienceId: "exp-one" },
    );
    expect(result.outcome).toBe("applied");
    expect(result.findings[0]).toMatchObject({
      operation: "merge",
      sourceExperienceIds: ["exp-other"],
      retainedExperienceId: "exp-one",
    });
    expect(fs.existsSync(path.join(root, "exp-other"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "exp-one", "body.md"), "utf8")).toBe(
      "Original procedure.",
    );
  });

  it("rejects merge when the unchanged survivor is deleted concurrently", async () => {
    const { result, root } = await review(
      (workspace, runtime) => {
        fs.rmSync(path.join(workspace, "exp-other"), { recursive: true });
        fs.rmSync(path.join(runtime, "exp-one"), { recursive: true });
      },
      ["exp-other"],
      "merge",
      { sourceExperienceIds: ["exp-other"], retainedExperienceId: "exp-one" },
    );
    expect(result.outcome).toBe("validation-failed");
    expect(fs.existsSync(path.join(root, "exp-other"))).toBe(true);
    expect(result.validationErrors).toContain(
      "exp-one: runtime experience changed during review",
    );
  });

  it.each(["source-retained", "survivor-deleted", "new-survivor"] as const)(
    "rejects invalid merge topology: %s",
    async (scenario) => {
      const retainedExperienceId =
        scenario === "new-survivor" ? "exp-new" : "exp-one";
      const targets =
        scenario === "source-retained"
          ? ["exp-other"]
          : [
              "exp-one",
              "exp-other",
              ...(scenario === "new-survivor" ? ["exp-new"] : []),
            ];
      const { result, root } = await review(
        (workspace) => {
          if (scenario === "source-retained") {
            fs.writeFileSync(
              path.join(workspace, "exp-other", "body.md"),
              "Changed source.",
            );
          } else {
            if (scenario === "new-survivor")
              fs.cpSync(
                path.join(workspace, "exp-one"),
                path.join(workspace, "exp-new"),
                { recursive: true },
              );
            fs.rmSync(path.join(workspace, "exp-one"), { recursive: true });
            fs.rmSync(path.join(workspace, "exp-other"), { recursive: true });
          }
        },
        targets,
        "merge",
        { sourceExperienceIds: ["exp-other"], retainedExperienceId },
      );
      expect(result.outcome).toBe("validation-failed");
      expect(fs.existsSync(path.join(root, "exp-one"))).toBe(true);
      expect(fs.existsSync(path.join(root, "exp-other"))).toBe(true);
      expect(fs.existsSync(path.join(root, "exp-new"))).toBe(false);
    },
  );

  it.each([false, true])(
    "requires both the retained and deleted IDs for a merge (declared deletion: %s)",
    async (declareDeletion) => {
      const { result, root } = await review(
        (workspace) => {
          fs.writeFileSync(
            path.join(workspace, "exp-one", "body.md"),
            "Merged procedure with preserved verification steps.",
          );
          fs.rmSync(path.join(workspace, "exp-other"), { recursive: true });
        },
        declareDeletion ? ["exp-one", "exp-other"] : ["exp-one"],
        "merge",
        { sourceExperienceIds: ["exp-other"], retainedExperienceId: "exp-one" },
      );
      expect(result.outcome).toBe(
        declareDeletion ? "applied" : "validation-failed",
      );
      expect(fs.existsSync(path.join(root, "exp-other"))).toBe(
        !declareDeletion,
      );
      expect(
        fs.readFileSync(path.join(root, "exp-one", "body.md"), "utf8"),
      ).toBe(
        declareDeletion
          ? "Merged procedure with preserved verification steps."
          : "Original procedure.",
      );
      if (declareDeletion) {
        expect(result.findings[0]).toMatchObject({
          operation: "merge",
          sourceExperienceIds: ["exp-other"],
          retainedExperienceId: "exp-one",
        });
        expect(result.findings[0]?.targetExperienceIds).toEqual([
          "exp-one",
          "exp-other",
        ]);
      }
    },
  );

  it("keeps every declared target for a multi-experience finding", async () => {
    const { result } = await review(
      (workspace) => {
        for (const id of ["exp-one", "exp-other"]) {
          fs.rmSync(path.join(workspace, id), { recursive: true });
        }
      },
      ["exp-one", "exp-other"],
      "delete",
    );
    expect(result.outcome).toBe("applied");
    expect(result.findings[0]?.targetExperienceIds).toEqual([
      "exp-one",
      "exp-other",
    ]);
  });

  it("instructs one skill and keyword per line to match the parser", () => {
    expect(buildReviewPrompt(snapshot, ["capability-fit"])).toContain(
      "Up to 12 concise keywords (exactly one per line)",
    );
    expect(buildReviewPrompt(snapshot, ["capability-fit"])).toContain(
      "Associated skill names (exactly one per line; no comma-separated lists)",
    );
  });
});

describe("review output contract diagnostics", () => {
  it("accepts the positive JSON example from the prompt", () => {
    const prompt = buildReviewPrompt(snapshot, ["capability-fit"]);
    const example = prompt
      .split("\n")
      .find(
        (line) =>
          line.startsWith('{"findings":') && line.includes('"hasFinding":true'),
      );
    expect(example).toBeDefined();
    const parsed = parseReviewFindingsDetailed(example!, ["capability-fit"]);
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.missingRequestedTriggers).toEqual([]);
  });

  it("accepts and preserves all operation examples from the prompt", () => {
    const examples = buildReviewPrompt(snapshot, ["capability-fit"])
      .split("\n")
      .filter(
        (line) =>
          line.startsWith('{"findings":') && line.includes('"hasFinding":true'),
      );
    const findings = examples.flatMap(
      (example) =>
        parseReviewFindingsDetailed(example, ["capability-fit"])?.findings ??
        [],
    );
    expect(findings.map((finding) => finding.operation)).toEqual([
      "refine",
      "merge",
      "delete",
    ]);
    expect(findings[1]).toMatchObject({
      sourceExperienceIds: ["duplicate-workflow"],
      retainedExperienceId: "retained-workflow",
    });
  });

  it.each([
    "missing-operation",
    "unknown-operation",
    "missing-merge-fields",
    "duplicate-sources",
    "source-is-survivor",
    "duplicate-targets",
    "merge-fields-on-delete",
  ])("rejects malformed operation metadata: %s", (scenario) => {
    const example = buildReviewPrompt(snapshot, ["capability-fit"])
      .split("\n")
      .find(
        (line) =>
          line.startsWith('{"findings":') &&
          line.includes('"operation":"merge"'),
      )!;
    const response = JSON.parse(example);
    const finding = response.findings[0];
    if (scenario === "missing-operation") delete finding.operation;
    if (scenario === "unknown-operation") finding.operation = "split";
    if (scenario === "missing-merge-fields") delete finding.sourceExperienceIds;
    if (scenario === "duplicate-sources")
      finding.sourceExperienceIds.push(finding.sourceExperienceIds[0]);
    if (scenario === "source-is-survivor")
      finding.sourceExperienceIds = [finding.retainedExperienceId];
    if (scenario === "duplicate-targets")
      finding.targetExperienceIds.push(finding.targetExperienceIds[0]);
    if (scenario === "merge-fields-on-delete") finding.operation = "delete";
    const parsed = parseReviewFindingsDetailed(JSON.stringify(response), [
      "capability-fit",
    ]);
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.missingRequestedTriggers).toEqual(["capability-fit"]);
  });

  it("logs nested schema paths and codes without rejected content", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const prompt = buildReviewPrompt(snapshot, ["capability-fit"]);
    const example = prompt
      .split("\n")
      .find(
        (line) =>
          line.startsWith('{"findings":') && line.includes('"hasFinding":true'),
      )!;
    const response = JSON.parse(example);
    response.findings[0].evidence = "PRIVATE-EVIDENCE-MUST-NOT-BE-LOGGED";
    const parsed = parseReviewFindingsDetailed(JSON.stringify(response), [
      "capability-fit",
    ]);
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.missingRequestedTriggers).toEqual(["capability-fit"]);
    expect(warn).toHaveBeenCalledWith(
      "dropping invalid review finding",
      expect.objectContaining({
        issuePaths: expect.arrayContaining(["evidence"]),
        issueCodes: expect.arrayContaining(["invalid_type"]),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE-EVIDENCE");
  });
});
