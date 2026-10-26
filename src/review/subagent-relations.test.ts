import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { registerRelationSource } from "../skills/relation-sources.js";
import {
  readRelationGraph,
  relationGraphPath,
} from "../skills/relation-graph.js";
import { prepareRelationReviewContext } from "./relations.js";
import {
  buildReviewPrompt,
  parseReviewFindingsDetailed,
  runReviewSubagent,
} from "./subagent.js";
import type { ReviewSnapshot, SkillRelationReviewFinding } from "./types.js";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "review-relation-run-"));
});
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const snapshot: ReviewSnapshot = {
  sessionId: "s",
  agentId: "main",
  eventId: "turn-1",
  turnNumber: 1,
  current: {
    matchedSkills: ["a"],
    timestamps: { start: "2026-10-26T00:00:00Z" },
  },
  recent: [],
};
async function fixture() {
  const source = path.join(root, "source");
  const skills = ["a", "b"].map((name) => {
    const location = path.join(source, name, "SKILL.md");
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(
      location,
      `---\nname: ${name}\n---\n${name} composes documented data.\n`,
    );
    return { name, location, description: "Compose data" };
  });
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
  const context = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["a"],
    getVisibleSkills: async () => skills,
    search: async () => [{ name: "b" }],
  }))!;
  const [a, b] = context.skills;
  const finding: SkillRelationReviewFinding = {
    targetKind: "skill-relation",
    operation: "create",
    trigger: "capability-fit",
    fromSkillId: a.identity.id,
    toSkillId: b.identity.id,
    relationType: "composes_with",
    reason: "Their documented interfaces compose.",
    dedupeKey: "compose-data",
    summary: "Record documented composition",
    evidence: ["Read both full skills"],
    correctionGoal: "Record composition",
    suggestedChange: "Create relationship",
    relationEvidence: [a, b].map((skill) => ({
      skillId: skill.identity.id,
      filePath: "SKILL.md",
      startLine: 4,
      endLine: 4,
      quote: `${skill.name} composes documented data.`,
    })),
  };
  const response = (extra: unknown[] = []) => ({
    payloads: [
      {
        text: JSON.stringify({
          findings: [{ ...finding, hasFinding: true }, ...extra],
        }),
      },
    ],
  });
  return { context, finding, response };
}
async function run(
  context: NonNullable<
    Awaited<ReturnType<typeof prepareRelationReviewContext>>
  >,
  execute: (workspace: string, prompt: string) => Promise<unknown>,
  signal?: AbortSignal,
  withDataRoot = true,
) {
  const runEmbeddedAgent = vi.fn(
    async (params: { workspaceDir: string; prompt: string }) =>
      execute(params.workspaceDir, params.prompt),
  );
  const api = {
    config: {},
    runtime: { agent: { runEmbeddedAgent } },
  } as unknown as OpenClawPluginApi;
  return runReviewSubagent({
    api,
    config: resolveConfig({}),
    agentId: "main",
    dataRoot: withDataRoot ? root : undefined,
    modelRef: { provider: "test", model: "review" },
    snapshot,
    triggers: ["capability-fit"],
    relationContext: context,
    abortSignal: signal,
  });
}
it("parses relation findings and rejects invalid structured evidence", async () => {
  const { finding } = await fixture();
  const parse = (value: unknown) =>
    parseReviewFindingsDetailed(
      JSON.stringify({
        findings: [{ ...finding, hasFinding: true, ...(value as object) }],
      }),
      ["capability-fit"],
    );
  expect(parse({})?.findings).toEqual([finding]);
  expect(
    parse({ relationEvidence: [finding.relationEvidence[0]] })?.findings,
  ).toEqual([]);
});
it("gives relation updates a valid format without experience-only requirements", async () => {
  const { context } = await fixture();
  const prompt = buildReviewPrompt(
    snapshot,
    ["capability-fit"],
    undefined,
    [],
    context,
  );
  expect(prompt).not.toContain(
    'A positive finding must set targetKind="skill-experience"',
  );
  expect(prompt).not.toContain('- targetKind must be "skill-experience".');
  expect(prompt).toContain("Experience findings only:");
  const example = prompt
    .split("\n")
    .find(
      (line) =>
        line.startsWith('{"findings":') &&
        line.includes('"targetKind":"skill-relation"') &&
        line.includes('"operation":"update"'),
    );
  expect(example).toBeDefined();
  expect(
    parseReviewFindingsDetailed(example!, ["capability-fit"])?.findings[0],
  ).toMatchObject({ targetKind: "skill-relation", operation: "update" });
});

it("stages full content and applies relation-only changes without experience changes", async () => {
  const { context, response } = await fixture();
  const result = await run(context, async (workspace, prompt) => {
    expect(
      fs.readFileSync(
        path.join(workspace, context.skills[0].workspacePath),
        "utf8",
      ),
    ).toBe(context.skills[0].content);
    expect(prompt).toContain("Skill relation maintenance");
    expect(prompt).toContain("not evidence of execution");
    return response();
  });
  expect(result).toMatchObject({
    outcome: "applied",
    relationOutcome: "applied",
    changedRelationCount: 1,
    relationBatchId: expect.any(String),
  });
  expect(result.changedExperienceIds).toBeUndefined();
  expect((await readRelationGraph(root))?.relations).toHaveLength(1);
});
it("rejects the whole relation batch when one requested relation is malformed", async () => {
  const { context, finding, response } = await fixture();
  const result = await run(context, async () =>
    response([{ ...finding, hasFinding: true, relationEvidence: [] }]),
  );
  expect(result.outcome).toBe("schema-rejected");
  expect(fs.existsSync(relationGraphPath(root))).toBe(false);
});
it("retains a committed graph receipt when experience conflict occurs afterward", async () => {
  const { context, response } = await fixture();
  const exp = path.join(root, "experiences", "exp-1");
  fs.mkdirSync(exp, { recursive: true });
  for (const [file, content] of Object.entries({
    "summary.md": "Original summary.",
    "keywords.md": "data",
    "body.md": "Original procedure.",
  }))
    fs.writeFileSync(path.join(exp, file), content);
  const result = await run(context, async (workspace) => {
    fs.writeFileSync(
      path.join(workspace, "experiences", "exp-1", "summary.md"),
      "Updated summary.",
    );
    fs.writeFileSync(path.join(exp, "summary.md"), "Concurrent update.");
    return response([
      {
        trigger: "capability-fit",
        hasFinding: true,
        targetKind: "skill-experience",
        operation: "refine",
        targetExperienceIds: ["exp-1"],
        dedupeKey: "refine-exp",
        summary: "Refine summary",
        evidence: ["Read procedure"],
        correctionGoal: "Clarify",
        suggestedChange: "Refine summary",
      },
    ]);
  });
  expect(result).toMatchObject({
    outcome: "partially-applied",
    relationOutcome: "applied",
    changedRelationCount: 1,
    experienceOutcome: "validation-failed",
  });
  expect(result.findings.map((finding) => finding.targetKind)).toEqual([
    "skill-relation",
  ]);
  expect(fs.readFileSync(path.join(exp, "summary.md"), "utf8")).toBe(
    "Concurrent update.",
  );
  expect((await readRelationGraph(root))?.relations).toHaveLength(1);
});
it("keeps the graph receipt after cancellation immediately after publication", async () => {
  const { context, response } = await fixture();
  const controller = new AbortController();
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === relationGraphPath(root)) controller.abort();
  });
  const result = await run(context, async () => response(), controller.signal);
  expect(result).toMatchObject({
    changedRelationCount: 1,
    relationOutcome: "applied",
    relationBatchId: expect.any(String),
  });
  expect(result.findings).toHaveLength(1);
});

it("reports actual partial experience writes without losing the committed graph", async () => {
  const { context, response } = await fixture();
  const exp = path.join(root, "experiences", "exp-1");
  fs.mkdirSync(exp, { recursive: true });
  for (const [file, content] of Object.entries({
    "summary.md": "Original summary.",
    "keywords.md": "data",
    "body.md": "Original procedure.",
  }))
    fs.writeFileSync(path.join(exp, file), content);
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const write = actualFs.writeFileSync.bind(actualFs);
  let armed = false;
  vi.mocked(fs.writeFileSync).mockImplementation((file, content, options) => {
    if (armed && file === path.join(exp, "summary.md"))
      throw new Error("simulated disk failure");
    return write(file, content, options);
  });
  const result = await run(context, async (workspace) => {
    fs.writeFileSync(
      path.join(workspace, "experiences", "exp-1", "body.md"),
      "Updated procedure.",
    );
    fs.writeFileSync(
      path.join(workspace, "experiences", "exp-1", "summary.md"),
      "Updated summary.",
    );
    armed = true;
    return response([
      {
        trigger: "capability-fit",
        hasFinding: true,
        targetKind: "skill-experience",
        operation: "refine",
        targetExperienceIds: ["exp-1"],
        dedupeKey: "refine-exp",
        summary: "Refine summary",
        evidence: ["Read procedure"],
        correctionGoal: "Clarify",
        suggestedChange: "Refine summary",
      },
    ]);
  });
  expect(result).toMatchObject({
    outcome: "partially-applied",
    relationOutcome: "applied",
    changedRelationCount: 1,
    experienceOutcome: "partial",
    changedExperienceIds: ["exp-1"],
    partialExperienceIds: ["exp-1"],
  });
  expect(result.findings.map((finding) => finding.targetKind)).toEqual([
    "skill-relation",
  ]);
  expect(fs.readFileSync(path.join(exp, "body.md"), "utf8")).toBe(
    "Updated procedure.",
  );
  expect(fs.readFileSync(path.join(exp, "summary.md"), "utf8")).toBe(
    "Original summary.",
  );
});

it("rejects a missing experience destination before committing any relation", async () => {
  const { context, response } = await fixture();
  const result = await run(
    context,
    async (workspace) => {
      const exp = path.join(workspace, "experiences", "exp-1");
      fs.mkdirSync(exp, { recursive: true });
      for (const [file, content] of Object.entries({
        "summary.md": "A reusable pipeline procedure.",
        "keywords.md": "pipeline",
        "body.md": "Read and verify the documented pipeline.",
      }))
        fs.writeFileSync(path.join(exp, file), content);
      return response([
        {
          trigger: "capability-fit",
          hasFinding: true,
          targetKind: "skill-experience",
          operation: "create",
          targetExperienceIds: ["exp-1"],
          dedupeKey: "create-exp",
          summary: "Create procedure",
          evidence: ["Read procedure"],
          correctionGoal: "Capture procedure",
          suggestedChange: "Create experience",
        },
      ]);
    },
    undefined,
    false,
  );
  expect(result).toMatchObject({
    outcome: "validation-failed",
    experienceOutcome: "validation-failed",
  });
  expect(fs.existsSync(relationGraphPath(root))).toBe(false);
});
