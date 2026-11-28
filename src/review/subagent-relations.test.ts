import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { logger, type OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { registerRelationSource } from "../skills/relation-sources.js";
import {
  appendImportedRelations,
  readRelationGraph,
  relationGraphPath,
} from "../skills/relation-graph.js";
import { prepareRelationReviewContext } from "./relations.js";
import {
  createReviewToolRegistry,
  getReviewToolBinding,
} from "./tool-bindings.js";
import {
  buildReviewPrompt,
  parseReviewFindingsDetailed,
  runReviewSubagent,
} from "./subagent.js";
import type { ReviewSnapshot, SkillRelationReviewFinding } from "./types.js";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "review-relation-run-"));
});
afterEach(() => {
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
  }))!;
  await context.admitSkill("b");
  const [a, b] = context.skills;
  const finding: Omit<SkillRelationReviewFinding, "trigger"> = {
    targetKind: "skill-relation",
    operation: "create",
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
          relationReview: {
            existing: "not-applicable",
            discovery: "changes-proposed",
          },
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
    modelRef: { provider: "test", model: "review" },
    snapshot,
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
    );
  expect(parse({})?.findings).toEqual([
    { ...finding, trigger: "relation-health-check" },
  ]);
  expect(
    parse({ relationEvidence: [finding.relationEvidence[0]] })?.findings,
  ).toEqual([]);
});
it("requires an independent relation assessment and checks it against proposed operations", async () => {
  const { context, finding } = await fixture();
  const parse = (
    relationReview?: unknown,
    findings: unknown[] = [{ hasFinding: false }],
  ) =>
    parseReviewFindingsDetailed(
      JSON.stringify({
        findings,
        ...(relationReview ? { relationReview } : {}),
      }),
      context,
    );
  expect(parse()?.invalidRelationReview).toBe(true);
  expect(
    parse({ existing: "not-applicable", discovery: "no-change" })
      ?.invalidRelationReview,
  ).toBeUndefined();
  expect(
    parse({ existing: "not-applicable", discovery: "changes-proposed" })
      ?.invalidRelationReview,
  ).toBe(true);
  expect(
    parse({ existing: "not-applicable", discovery: "changes-proposed" }, [
      { ...finding, hasFinding: true },
    ])?.relationReview,
  ).toEqual({ existing: "not-applicable", discovery: "changes-proposed" });
  expect(
    parse({ existing: "no-change", discovery: "no-change" })
      ?.invalidRelationReview,
  ).toBe(true);
});
it("builds a relation-only prompt with both assessment decisions", async () => {
  const { context } = await fixture();
  const prompt = buildReviewPrompt(snapshot, context);
  expect(prompt).toContain('operation="create"|"update"|"delete"');
  expect(prompt).toContain("relationEvidence");
  expect(prompt).not.toMatch(/experience/i);
  const updateExample = prompt
    .split("\n")
    .find(
      (line) =>
        line.startsWith('{"findings":') &&
        line.includes('"operation":"update"'),
    )!;
  expect(parseReviewFindingsDetailed(updateExample)?.findings[0]).toMatchObject(
    { targetKind: "skill-relation", operation: "update" },
  );
  const example = prompt.split("No-change example: ")[1];
  expect(parseReviewFindingsDetailed(example!, context)).toMatchObject({
    findings: [],
    missingDecision: false,
    relationReview: { existing: "not-applicable", discovery: "no-change" },
  });
});

it("guides the reviewer to prefer specific relation types over generic related and refine broad related edges", async () => {
  const { context } = await fixture();
  const prompt = buildReviewPrompt(snapshot, context);
  const typesLine = prompt
    .split("\n")
    .find((line) => line.startsWith("Types:"))!;
  expect(typesLine).toBeDefined();
  const orderedTypes = [
    "depends_on",
    "composes_with",
    "specializes",
    "conflicts_with",
    "similar_to",
    "related",
  ] as const;
  const positions = orderedTypes.map((type) => typesLine.indexOf(type));
  for (let i = 0; i < positions.length; i += 1) {
    expect(positions[i]).toBeGreaterThan(-1);
    if (i > 0) expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
  }
  expect(prompt).toContain("Prefer the most specific relation type");
  expect(prompt).toContain(
    "prioritize high-value structural and workflow links (depends_on, composes_with, specializes, conflicts_with) before alternative-capability similar_to edges",
  );
  expect(prompt).toContain("Treat related as a last resort");
  expect(prompt).toContain("upgrading the edge to a more specific type");
  expect(prompt).toContain(
    "no concrete documented workflow, structural, or alternative-capability link",
  );
  expect(prompt).toContain(
    "consolidate any useful context into one edge (update if needed) and delete the redundant reverse edge",
  );
  expect(prompt).toContain(
    "delete the reversed edge and create the correctly directed edge (reporting changes-proposed for both existing and discovery)",
  );
  expect(prompt).toContain(
    "Helpful composition is composes_with, not depends_on",
  );
});

it("consolidates redundant bidirectional symmetric edges in one atomic batch", async () => {
  const { context, finding } = await fixture();
  const [a, b] = context.skills;
  await appendImportedRelations(root, [
    {
      from: a.identity,
      to: b.identity,
      type: "similar_to",
      reason: "A overlaps with B.",
    },
    {
      from: b.identity,
      to: a.identity,
      type: "related",
      reason: "B also overlaps with A.",
    },
  ]);
  const prepared = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["a"],
    getVisibleSkills: context.getVisibleSkills,
  }))!;
  const registry = createReviewToolRegistry();
  const runEmbeddedAgent = vi.fn(
    async (params: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      toolBindings?: Record<string, unknown>;
    }) => {
      const binding = getReviewToolBinding(params, registry);
      await binding?.search(async () => ({ success: true, skills: [] }));
      return {
        payloads: [
          {
            text: JSON.stringify({
              findings: [
                {
                  ...finding,
                  hasFinding: true,
                  operation: "update",
                  fromSkillId: a.identity.id,
                  toSkillId: b.identity.id,
                  relationType: "similar_to",
                  reason: "Consolidated bidirectional overlap.",
                  dedupeKey: "consolidate-ab",
                  correctionGoal: "Consolidate symmetric context into A->B",
                },
                {
                  hasFinding: true,
                  targetKind: "skill-relation",
                  operation: "delete",
                  fromSkillId: b.identity.id,
                  toSkillId: a.identity.id,
                  dedupeKey: "delete-redundant-ba",
                  summary: "Delete redundant reverse edge",
                  evidence: ["Read both full skills"],
                  correctionGoal: "Remove redundant symmetric reverse edge",
                  suggestedChange: "Delete B->A",
                  relationEvidence: finding.relationEvidence,
                },
              ],
              relationReview: {
                existing: "changes-proposed",
                discovery: "no-change",
              },
            }),
          },
        ],
      };
    },
  );
  const api = {
    config: {},
    runtime: { agent: { runEmbeddedAgent } },
  } as unknown as OpenClawPluginApi;
  const result = await runReviewSubagent({
    api,
    config: resolveConfig({}),
    agentId: "main",
    modelRef: { provider: "test", model: "review" },
    snapshot,
    relationContext: prepared,
    reviewToolRegistry: registry,
  });
  expect(result).toMatchObject({
    outcome: "applied",
    relationOutcome: "applied",
    changedRelationCount: 2,
    relationSearchCount: 1,
  });
  const graph = await readRelationGraph(root);
  expect(graph?.relations).toHaveLength(1);
  expect(graph?.relations[0]).toMatchObject({
    from: a.identity.id,
    to: b.identity.id,
    rel: "similar_to",
    properties: expect.objectContaining({
      reason: "Consolidated bidirectional overlap.",
    }),
  });
});

it("reverses a misdirected asymmetric edge atomically via delete plus create", async () => {
  const { context, finding } = await fixture();
  const [a, b] = context.skills;
  await appendImportedRelations(root, [
    {
      from: b.identity,
      to: a.identity,
      type: "depends_on",
      reason: "Backwards prerequisite direction.",
    },
  ]);
  const prepared = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["a"],
    getVisibleSkills: context.getVisibleSkills,
  }))!;
  const result = await run(prepared, async () => ({
    payloads: [
      {
        text: JSON.stringify({
          findings: [
            {
              hasFinding: true,
              targetKind: "skill-relation",
              operation: "delete",
              fromSkillId: b.identity.id,
              toSkillId: a.identity.id,
              dedupeKey: "delete-reversed-ba",
              summary: "Remove reversed depends_on",
              evidence: ["Read both full skills"],
              correctionGoal: "Direction was reversed",
              suggestedChange: "Delete B->A",
              relationEvidence: finding.relationEvidence,
            },
            {
              ...finding,
              hasFinding: true,
              operation: "create",
              fromSkillId: a.identity.id,
              toSkillId: b.identity.id,
              relationType: "depends_on",
              reason: "A explicitly requires B.",
              dedupeKey: "create-directed-ab",
              correctionGoal: "Record corrected prerequisite direction A->B",
            },
          ],
          relationReview: {
            existing: "changes-proposed",
            discovery: "changes-proposed",
          },
        }),
      },
    ],
  }));
  expect(result).toMatchObject({
    outcome: "applied",
    relationOutcome: "applied",
    changedRelationCount: 2,
  });
  const graph = await readRelationGraph(root);
  expect(graph?.relations).toHaveLength(1);
  expect(graph?.relations[0]).toMatchObject({
    from: a.identity.id,
    to: b.identity.id,
    rel: "depends_on",
    properties: expect.objectContaining({ reason: "A explicitly requires B." }),
  });
});

it("stages only relation evidence and publishes a checked graph batch", async () => {
  const { context, response } = await fixture();
  const result = await run(context, async (workspace, prompt) => {
    expect(
      fs.readFileSync(
        path.join(workspace, context.skills[0].workspacePath),
        "utf8",
      ),
    ).toBe(context.skills[0].content);
    expect(fs.readdirSync(workspace)).toEqual(["relation-evidence"]);
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
it("rejects retired positive findings even alongside a valid proposal", async () => {
  const { context, response, finding } = await fixture();
  const result = await run(context, async () =>
    response([
      { ...finding, hasFinding: true, targetKind: "skill-experience" },
    ]),
  );
  expect(result.outcome).toBe("schema-rejected");
  expect(fs.existsSync(relationGraphPath(root))).toBe(false);
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

it("logs validation codes and paths without rejected evidence", async () => {
  const { finding } = await fixture();
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const parsed = parseReviewFindingsDetailed(
    JSON.stringify({
      findings: [
        { ...finding, hasFinding: true, evidence: "PRIVATE-EVIDENCE-MARKER" },
      ],
    }),
  );
  expect(parsed?.missingDecision).toBe(true);
  const message = warn.mock.calls.find(([entry]) =>
    entry.startsWith("dropping invalid review finding "),
  )?.[0];
  expect(message).toBeDefined();
  expect(JSON.parse(message!.slice(message!.indexOf("{")))).toMatchObject({
    issuePaths: expect.arrayContaining(["evidence"]),
    issueCodes: expect.arrayContaining(["invalid_type"]),
  });
  expect(message).not.toContain("PRIVATE-EVIDENCE-MARKER");
});
