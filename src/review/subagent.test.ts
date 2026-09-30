import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import {
  buildReviewPrompt,
  getReviewModelRef,
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
