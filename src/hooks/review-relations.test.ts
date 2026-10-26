import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHookHandlers } from "./index.js";
import { resolveConfig } from "../config.js";
import { registerRelationSource } from "../skills/relation-sources.js";
import type { OpenClawPluginApi } from "../../api.js";
import type { IntentReviewScheduler } from "../review/scheduler.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hook-review-relations-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function setup(
  result: Record<string, unknown>,
  abortAfterReview = false,
) {
  const source = path.join(root, "skills");
  const skills = await Promise.all(
    ["recommended", "loaded", "extra"].map(async (name) => {
      const location = path.join(source, name, "SKILL.md");
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(
        location,
        `---\nname: ${name}\n---\nCompose data pipelines.\n`,
      );
      return { name, location, description: "Compose pipelines" };
    }),
  );
  await registerRelationSource(root, {
    id: "github:example/catalog",
    root: source,
    skills: Object.fromEntries(
      skills.map(({ name }) => [
        name,
        { name, source_path: `${name}/SKILL.md` },
      ]),
    ),
  });
  let runner: Parameters<IntentReviewScheduler["setRunner"]>[0] | undefined;
  const controller = new AbortController();
  const reviewer = vi.fn(async () => {
    if (abortAfterReview) controller.abort();
    return result;
  });
  const record = vi.fn(async () => true);
  const schedule = vi.fn();
  const reviewSkillResolver = vi.fn(async () => skills);
  createHookHandlers({
    api: { config: {} } as OpenClawPluginApi,
    config: () => resolveConfig({}),
    refreshLiveConfigFromRuntime: () => {},
    dataRoot: root,
    reviewScheduler: {
      setRunner: (value) => {
        runner = value;
      },
      schedule: vi.fn(),
      setOnDiscard: vi.fn(),
    } as never,
    skillInventoryResolver: vi.fn(async () =>
      skills.map((skill) => ({
        ...skill,
        source: "workspace",
        fingerprint: "f",
        winnerFingerprint: "f",
      })),
    ) as never,
    reviewSkillResolver,
    reviewer: reviewer as never,
    reviewLogWriter: { record },
    experienceCatalog: { listAll: () => [] } as never,
    qmdExperienceIndex: { schedule } as never,
    qmdSkillIndex: {
      search: vi.fn(async () => [{ name: "extra", score: 1 }]),
    } as never,
  });
  const candidate = {
    agentId: "main",
    resolvedConfig: resolveConfig({}),
    ctx: {},
    modelRef: { provider: "test", model: "test" },
    triggers: ["capability-fit"],
    snapshot: {
      sessionId: "s",
      eventId: "e",
      turnNumber: 1,
      current: {
        matchedSkills: ["recommended"],
        skillsUsed: [{ name: "loaded", path: skills[1].location }],
        timestamps: { start: "2026-10-26T00:00:00Z" },
      },
      recent: [],
    },
  };
  await runner!(candidate as never, controller.signal);
  return { reviewer, record, schedule, reviewSkillResolver };
}
it("includes recommended and loaded seeds while retaining loaded-only experience eligibility", async () => {
  const { reviewer, schedule, record } = await setup({
    findings: [],
    outcome: "applied",
    changedRelationCount: 1,
    relationBatchId: "batch-1",
    relationOutcome: "applied",
  });
  expect(reviewer.mock.calls[0][0]).toMatchObject({
    allowedExperienceSkills: ["loaded"],
    relationContext: {
      seedIds: [
        "github:example/catalog:recommended",
        "github:example/catalog:loaded",
      ],
    },
  });
  expect(record).toHaveBeenCalledWith(
    "e",
    expect.anything(),
    [],
    expect.objectContaining({
      changedRelationCount: 1,
      relationBatchId: "batch-1",
      relationOutcome: "applied",
    }),
  );
  expect(schedule).not.toHaveBeenCalled();
});
it("records committed receipts and refreshes actual experience deltas after abort", async () => {
  const { record, schedule } = await setup(
    {
      findings: [],
      outcome: "partially-applied",
      changedRelationCount: 1,
      relationBatchId: "batch-2",
      relationOutcome: "applied",
      changedExperienceIds: ["exp-1"],
      partialExperienceIds: ["exp-1"],
      experienceOutcome: "partial",
    },
    true,
  );
  expect(record).toHaveBeenCalledWith(
    "e",
    expect.anything(),
    [],
    expect.objectContaining({
      relationBatchId: "batch-2",
      experienceOutcome: "partial",
      partialExperienceIds: ["exp-1"],
    }),
  );
  expect(schedule).toHaveBeenCalledOnce();
});
it("keeps canceled uncommitted results out of persistence", async () => {
  const { record, schedule } = await setup(
    { findings: [], outcome: "subagent-error" },
    true,
  );
  expect(record).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
});
