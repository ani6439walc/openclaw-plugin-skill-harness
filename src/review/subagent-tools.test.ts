import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { registerSkillTools } from "../skills/tools.js";
import { registerRelationSource } from "../skills/relation-sources.js";
import { readRelationGraph } from "../skills/relation-graph.js";
import { prepareRelationReviewContext } from "./relations.js";
import { runReviewSubagent } from "./subagent.js";
import { createReviewToolRegistry } from "./tool-bindings.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
interface Tool {
  name: string;
  execute(id: string, args: unknown): Promise<{ content: { text: string }[] }>;
}
interface EmbeddedParams {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  toolBindings: Readonly<Record<string, unknown>>;
  workspaceDir: string;
}

async function fixture(
  mode:
    | "create"
    | "no-search"
    | "search-unavailable"
    | "staging-failed"
    | "embedded-error"
    | "abort",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-autonomous-"));
  roots.push(root);
  const source = path.join(root, "source");
  const skills = ["a", "b"].map((name) => {
    const location = path.join(source, name, "SKILL.md");
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(
      location,
      `---\nname: ${name}\ndescription: Compose data\n---\n${name} composes data.\n`,
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
  expect(context.skills).toHaveLength(1);
  const registry = createReviewToolRegistry();
  const abort = new AbortController();
  const factories: ((context: EmbeddedParams) => Tool)[] = [];
  let retainedView!: Tool;
  const index = {
    getStatus: () => "ready",
    search: vi.fn(async () =>
      mode === "search-unavailable" ? undefined : [{ name: "b", score: 0.9 }],
    ),
  } as unknown as SkillQmdIndex;
  const runEmbeddedAgent = vi.fn(async (params: EmbeddedParams) => {
    const tools = new Map(
      factories.map((factory) => {
        const tool = factory({
          ...params,
          toolBindings: structuredClone(params.toolBindings),
        });
        return [tool.name, tool] as const;
      }),
    );
    retainedView = tools.get("skill_view")!;
    if (mode === "embedded-error") throw new Error("embedded-test-error");
    if (mode === "abort") {
      abort.abort();
      return { payloads: [] };
    }
    if (mode !== "no-search")
      await tools
        .get("skill_search")!
        .execute("search", { query: "compose data", limit: 5 });
    if (mode === "no-search" || mode === "search-unavailable")
      return {
        payloads: [
          {
            text: JSON.stringify({
              findings: [{ trigger: "capability-fit", hasFinding: false }],
              relationReview: {
                existing: "not-applicable",
                discovery: "no-change",
              },
            }),
          },
        ],
      };
    if (mode === "staging-failed") {
      fs.rmSync(path.join(params.workspaceDir, "relation-evidence"), {
        recursive: true,
      });
      fs.symlinkSync(
        source,
        path.join(params.workspaceDir, "relation-evidence"),
      );
      await expect(
        retainedView.execute("view", { name: "b" }),
      ).rejects.toThrow();
    } else {
      const first = JSON.parse(
        (await retainedView.execute("view", { name: "b" })).content[0].text,
      );
      expect(first).toMatchObject({
        success: true,
        content: fs.readFileSync(skills[1].location, "utf8"),
        review_inspection: true,
        relation_review: { eligible: true },
      });
      expect(
        fs.readFileSync(
          path.join(params.workspaceDir, first.relation_review.file_path),
          "utf8",
        ),
      ).toBe(first.content);
      expect(
        JSON.parse(
          (await retainedView.execute("again", { name: "b" })).content[0].text,
        ),
      ).toEqual(first);
    }
    expect(context.skills).toHaveLength(2);
    const [a, b] = context.skills;
    return {
      payloads: [
        {
          text: JSON.stringify({
            relationReview: {
              existing: "not-applicable",
              discovery: "changes-proposed",
            },
            findings: [
              {
                trigger: "capability-fit",
                hasFinding: true,
                targetKind: "skill-relation",
                operation: "create",
                fromSkillId: a.identity.id,
                toSkillId: b.identity.id,
                relationType: "composes_with",
                reason: "Documented composition.",
                dedupeKey: "compose",
                summary: "Compose skills",
                evidence: ["Both endpoints describe composition"],
                correctionGoal: "Record documented composition",
                suggestedChange: "Create relationship",
                relationEvidence: [a, b].map((skill) => ({
                  skillId: skill.identity.id,
                  filePath: "SKILL.md",
                  startLine: 5,
                  endLine: 5,
                  quote: `${skill.name} composes data.`,
                })),
              },
            ],
          }),
        },
      ],
    };
  });
  const api = {
    config: {},
    registerTool: (factory: (context: EmbeddedParams) => Tool) =>
      factories.push(factory),
    runtime: {
      state: { resolveStateDir: () => root },
      agent: { resolveAgentWorkspaceDir: () => root, runEmbeddedAgent },
    },
  } as unknown as OpenClawPluginApi;
  registerSkillTools(api, {
    reviewToolRegistry: registry,
    qmdSkillIndex: index,
    getSharedRoots: () => [source],
    bundledSkillsDir: "",
    homeDir: path.join(root, "home"),
  });
  const result = await runReviewSubagent({
    reviewToolRegistry: registry,
    api,
    config: resolveConfig({}),
    agentId: "main",
    dataRoot: root,
    modelRef: { provider: "test", model: "review" },
    snapshot: {
      sessionId: "original",
      eventId: "original:turn",
      turnNumber: 1,
      current: { matchedSkills: ["a"] },
      recent: [],
    },
    triggers: ["capability-fit"],
    relationContext: context,
    abortSignal: abort.signal,
  });
  await expect(retainedView.execute("late", { name: "b" })).rejects.toThrow(
    "review-tool-closed",
  );
  return { result, context, graph: await readRelationGraph(root) };
}

it("publishes a relation discovered autonomously through the real registered skill tools", async () => {
  const { result, graph } = await fixture("create");
  expect(result).toMatchObject({
    outcome: "applied",
    changedRelationCount: 1,
    relationSearchCount: 1,
    relationReview: {
      existing: "not-applicable",
      discovery: "changes-proposed",
    },
  });
  expect(graph?.relations).toHaveLength(1);
});

it("rejects discovery no-change without an attempted search", async () => {
  const { result, graph } = await fixture("no-search");
  expect(result).toMatchObject({
    outcome: "schema-rejected",
    relationSearchCount: 0,
    schemaRejectionReasonCounts: { "invalid-shape": 1 },
  });
  expect(graph?.relations ?? []).toHaveLength(0);
});

it("allows no-change when an autonomous search is unavailable", async () => {
  const { result } = await fixture("search-unavailable");
  expect(result).toMatchObject({
    outcome: "nofinding",
    relationSearchCount: 1,
    relationReview: { existing: "not-applicable", discovery: "no-change" },
  });
});

it("rejects graph proposals after an admitted endpoint could not be staged safely", async () => {
  const { result, graph } = await fixture("staging-failed");
  expect(result).toMatchObject({
    outcome: "validation-failed",
    relationOutcome: "validation-failed",
    validationErrors: ["invalid-relation-evidence"],
  });
  expect(graph?.relations ?? []).toHaveLength(0);
});

it.each(["embedded-error", "abort"] as const)(
  "revokes the cloned run descriptor after %s",
  async (mode) => {
    const { result, graph } = await fixture(mode);
    expect(result).toMatchObject({
      outcome: "subagent-error",
      relationSearchCount: 0,
    });
    expect(graph?.relations ?? []).toHaveLength(0);
  },
);
