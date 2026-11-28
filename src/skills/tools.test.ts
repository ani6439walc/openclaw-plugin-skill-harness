import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:fs", { spy: true });
import { registerSkillTools } from "./tools.js";
import {
  createReviewToolRegistry,
  REVIEW_TOOL_BINDING_KEY,
} from "../review/tool-bindings.js";
import {
  appendImportedRelations,
  applyRelationReviewChanges,
  readSkillIdentity,
  relationGraphPath,
} from "./relation-graph.js";
import { registerRelationSource } from "./relation-sources.js";
import type { OpenClawPluginApi } from "../../api.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";

function createApi(
  stateDir: string,
  workspaceDirs: string | Record<string, string>,
): OpenClawPluginApi & {
  registerTool: ReturnType<typeof vi.fn>;
} {
  const workspaceDirForAgent = (agentId: string) =>
    typeof workspaceDirs === "string"
      ? workspaceDirs
      : (workspaceDirs[agentId] ?? "");
  return {
    config: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: {
        resolveAgentWorkspaceDir: (_config, agentId) =>
          workspaceDirForAgent(agentId),
      },
    },
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi & {
    registerTool: ReturnType<typeof vi.fn>;
  };
}

function writeSkill(
  workspaceDir: string,
  name = "writer",
  relatedSkills: Record<string, string> = {},
  description = "Write well.",
): void {
  const skillDir = path.join(workspaceDir, "skills", name);
  const heading = name === "writer" ? "Writer" : name;
  const relatedSkillsFrontmatter = Object.entries(relatedSkills).length
    ? `metadata:\n  related-skills:\n${Object.entries(relatedSkills)
        .map(([relatedName, reason]) => `    ${relatedName}: ${reason}`)
        .join("\n")}\n`
    : "";
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${relatedSkillsFrontmatter}---\n\n# ${heading}\n`,
  );
}

async function seedRelation(
  stateDir: string,
  fromRoot: string,
  fromName: string,
  toRoot: string,
  toName: string,
  reason: string,
) {
  const from = await readSkillIdentity({
    name: fromName,
    location: path.join(fromRoot, "skills", fromName, "SKILL.md"),
  });
  const to = await readSkillIdentity({
    name: toName,
    location: path.join(toRoot, "skills", toName, "SKILL.md"),
  });
  expect(from).toBeDefined();
  expect(to).toBeDefined();
  await appendImportedRelations(
    path.join(stateDir, "plugins", "skill-harness"),
    [{ from: from!, to: to!, type: "related", reason }],
  );
}

function writeStats(
  stateDir: string,
  skills: Record<string, Record<string, unknown>>,
): void {
  const statsFile = path.join(
    stateDir,
    "plugins",
    "skill-harness",
    "stats.json",
  );
  fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  fs.writeFileSync(statsFile, JSON.stringify({ schemaVersion: 7, skills }));
}

async function runTool(tool: unknown, params: Record<string, unknown>) {
  const result = await (
    tool as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
    }
  ).execute("tool-call", params);
  const rendered = JSON.parse(result.content[0]?.text ?? "{}");
  expect(result.details).toStrictEqual(rendered);
  return rendered;
}

function toolsForAgent(
  api: ReturnType<typeof createApi>,
  agentId = "main",
  context: {
    sessionId?: string;
    sessionKey?: string;
    toolBindings?: Readonly<Record<string, unknown>>;
  } = {},
): Map<string, unknown> {
  return new Map(
    api.registerTool.mock.calls.flatMap(([registeredTool]) => {
      const factoryContext = {
        agentId,
        ...context,
      };
      const resolved =
        typeof registeredTool === "function"
          ? (registeredTool as (context: { agentId?: string }) => unknown)(
              factoryContext,
            )
          : registeredTool &&
              typeof registeredTool === "object" &&
              "create" in registeredTool &&
              typeof (registeredTool as { create?: unknown }).create ===
                "function"
            ? (
                registeredTool as {
                  create: (context: { agentId?: string }) => unknown;
                }
              ).create(factoryContext)
            : registeredTool;
      const tools = Array.isArray(resolved) ? resolved : [resolved];
      return tools.flatMap((tool) =>
        tool && typeof tool === "object" && "name" in tool
          ? [[tool.name, tool] as const]
          : [],
      );
    }),
  );
}

describe("registerSkillTools", () => {
  it("registers only the three agent-scoped skill tools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, path.join(tmp, "workspace"));

    registerSkillTools(api);
    expect(api.registerTool).toHaveBeenCalledTimes(3);
    expect(
      api.registerTool.mock.calls.map(([factory]) => factory.contextVersion),
    ).toEqual([2, 2, 2]);
    expect([...toolsForAgent(api).keys()]).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
    ]);
    expect(toolsForAgent(api, "").size).toBe(0);
  });

  it("describes focused discovery and required reading", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const api = createApi(path.join(tmp, "state"), path.join(tmp, "workspace"));
    registerSkillTools(api);
    const tools = toolsForAgent(api);
    const description = (name: string) =>
      (tools.get(name) as { description: string }).description;

    expect(description("skill_search")).toContain(
      "Use focused search when injected candidates do not match the current task",
    );
    expect(description("skill_search")).toContain(
      "use skill_view before following a skill workflow",
    );
    expect(description("skill_list")).toContain(
      "Use only when the task is broad, terminology is uncertain, or focused search is insufficient",
    );
    expect(description("skill_view")).toContain(
      "Read the complete skill before following its workflow",
    );
  });

  it("describes relation provenance without attributing Review assertions to authors", async () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-review-relations-"),
    );
    try {
      const stateDir = path.join(tmp, "state");
      const workspace = path.join(tmp, "workspace");
      const dataRoot = path.join(stateDir, "plugins", "skill-harness");
      writeSkill(workspace, "writer");
      writeSkill(workspace, "reader");
      const source = await registerRelationSource(dataRoot, {
        id: "github:example/tool-skills",
        root: path.join(workspace, "skills"),
        skills: {
          writer: { name: "writer", source_path: "writer/SKILL.md" },
          reader: { name: "reader", source_path: "reader/SKILL.md" },
        },
      });
      const registry = { version: 1 as const, sources: [source] };
      const skills = ["writer", "reader"].map((name) => ({
        name,
        location: path.join(workspace, "skills", name, "SKILL.md"),
      }));
      const [from, to] = await Promise.all(
        skills.map((skill) => readSkillIdentity(skill, registry)),
      );
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      await applyRelationReviewChanges(
        dataRoot,
        [
          {
            operation: "create",
            from: from!,
            to: to!,
            expected: null,
            type: "composes_with",
            reason: "The reviewed workflows compose.",
            rationale:
              "The complete endpoint files describe compatible workflows.",
            evidence: [from!, to!].map((identity, index) => ({
              skillId: identity.id,
              filePath: "SKILL.md",
              startLine: 6,
              endLine: 6,
              quote: index === 0 ? "# Writer" : "# reader",
              fileDigest: createHash("sha256")
                .update(fs.readFileSync(skills[index]!.location))
                .digest("hex"),
            })),
          },
        ],
        {
          batchId: "tool-review-batch",
          eventId: "tool-review-event",
          agentId: "main",
          assertCurrent: async () => {},
        },
      );
      const api = createApi(stateDir, workspace);
      registerSkillTools(api);
      const tools = toolsForAgent(api);
      expect(
        (tools.get("skill_list") as { description: string }).description,
      ).toContain("points from the returned skill");
      for (const name of ["skill_list", "skill_search"]) {
        const tool = tools.get(name) as {
          parameters: { properties: { show_related: { description: string } } };
        };
        const description = tool.parameters.properties.show_related.description;
        expect(description).toContain("relation reason");
        expect(description).toContain("source");
        expect(description).not.toContain("author reason");
        expect(description).toContain("not required dependencies");
      }
      const view = tools.get("skill_view") as { description: string };
      expect(view.description).toContain("unverified relation assertions");
      expect(view.description).not.toContain("author declarations");
      expect(view.description).toContain(
        "not required dependencies or hard conflicts",
      );
      const result = await runTool(view, { name: "writer" });
      expect(result.related_skills).toEqual([
        {
          name: "reader",
          reason: "The reviewed workflows compose.",
          direction: "current-to-related",
          relation_type: "composes_with",
          source: "review",
        },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("searches visible skills through the qmd skill index", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-qmd-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-state-"),
    );
    try {
      writeSkill(workspaceDir, "react", {}, "Build React UIs");
      writeSkill(workspaceDir, "docs", {}, "Write docs");
      const api = createApi(stateDir, workspaceDir);
      const searchHits = [
        {
          name: "react",
          score: 0.84,
          evidence: [
            {
              collection: "skill-body",
              path: "SKILL.md",
              score: 0.84,
              snippet: "Build React UIs",
            },
          ],
        },
      ];
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => searchHits),
        getStatus: vi.fn((_agentId: string) => "ready"),
        close: vi.fn(async () => {}),
      };
      const scheduleSkillSearchIndex = vi.fn();
      registerSkillTools(api, {
        qmdSkillIndex,
        scheduleSkillSearchIndex,
      });
      const tools = toolsForAgent(api, "main");
      const search = tools.get("skill_search");
      expect(search).toBeTruthy();

      const result = await runTool(search, { query: "react ui" });
      expect(result).toMatchObject({
        success: true,
        query: "react ui",
        total: 1,
        count: 1,
        limit: 20,
        skills: [
          {
            name: "react",
            description: "Build React UIs",
            source: "workspace",
            score: 0.84,
          },
        ],
      });
      expect(result.skills[0]).not.toHaveProperty("usage_stats");
      expect(result.skills[0]).toHaveProperty("evidence");
      expect(scheduleSkillSearchIndex).not.toHaveBeenCalledWith("main");
      expect(qmdSkillIndex.schedule).not.toHaveBeenCalled();
      expect(qmdSkillIndex.search).toHaveBeenCalledWith({
        agentId: "main",
        query: "react ui",
        limit: 20,
        includeEvidence: true,
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("schedules skill search index when agent index status is idle upon search", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-idle-qmd-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-idle-state-"),
    );
    try {
      writeSkill(workspaceDir, "react", {}, "Build React UIs");
      const api = createApi(stateDir, workspaceDir);
      const scheduleSkillSearchIndex = vi.fn();
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => undefined),
        getStatus: vi.fn((_agentId: string) => "idle"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(api, {
        qmdSkillIndex,
        scheduleSkillSearchIndex,
      });
      const tools = toolsForAgent(api, "subagent-1");
      const search = tools.get("skill_search");
      expect(search).toBeTruthy();

      const result = await runTool(search, { query: "react ui" });
      expect(result).toMatchObject({
        success: false,
        error: "skill search index is not ready",
      });
      expect(scheduleSkillSearchIndex).toHaveBeenCalledWith("subagent-1");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("validates search criteria, defaults evidence to true, and keeps stats opt-in", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-qmd-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-state-"),
    );
    try {
      writeSkill(workspaceDir, "react", {}, "Build React UIs");
      const api = createApi(stateDir, workspaceDir);
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => [
          {
            name: "react",
            score: 0.84,
            evidence: [
              {
                collection: "skill-meta",
                path: "meta.md",
                score: 0.84,
                snippet: "Build React UIs",
              },
            ],
          },
        ]),
        getStatus: vi.fn((_agentId: string) => "ready"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(api, { qmdSkillIndex });
      const search = toolsForAgent(api, "main").get("skill_search");

      await expect(runTool(search, { query: "   " })).resolves.toEqual({
        success: false,
        error: "query is required",
      });

      const defaultResult = await runTool(search, { query: "react" });
      expect(defaultResult).toMatchObject({
        success: true,
        query: "react",
        skills: [
          {
            score: 0.84,
          },
        ],
      });
      expect(qmdSkillIndex.search).toHaveBeenLastCalledWith({
        agentId: "main",
        query: "react",
        limit: 20,
        includeEvidence: true,
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns a structured error when the skill search index is unavailable", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-qmd-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-state-"),
    );
    try {
      writeSkill(workspaceDir, "react", {}, "Build React UIs");
      const api = createApi(stateDir, workspaceDir);
      registerSkillTools(api);
      const missing = toolsForAgent(api, "main").get("skill_search");
      await expect(runTool(missing, { query: "react" })).resolves.toEqual({
        success: false,
        error: "skill search index is not ready",
      });

      const notReady: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => undefined),
        getStatus: vi.fn((_agentId: string) => "building"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(createApi(stateDir, workspaceDir), {
        qmdSkillIndex: notReady,
      });
      // re-register on fresh api
      const api2 = createApi(stateDir, workspaceDir);
      registerSkillTools(api2, { qmdSkillIndex: notReady });
      const search = toolsForAgent(api2, "main").get("skill_search");
      await expect(runTool(search, { query: "react" })).resolves.toEqual({
        success: false,
        error: "skill search index is not ready",
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves skills for the agent that invokes the tool", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const mainWorkspace = path.join(tmp, "main-workspace");
    const analystWorkspace = path.join(tmp, "analyst-workspace");
    const api = createApi(stateDir, {
      analyst: analystWorkspace,
      main: mainWorkspace,
    });
    writeSkill(mainWorkspace, "main-only");
    writeSkill(analystWorkspace, "analyst-only");
    registerSkillTools(api);

    const mainTools = toolsForAgent(api, "main");
    const analystTools = toolsForAgent(api, "analyst");

    await expect(
      runTool(mainTools.get("skill_list"), {}),
    ).resolves.toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "main-only" }),
      ]),
    });
    await expect(
      runTool(analystTools.get("skill_list"), {}),
    ).resolves.toMatchObject({
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "analyst-only" }),
      ]),
    });
    await expect(
      runTool(analystTools.get("skill_view"), { name: "main-only" }),
    ).resolves.toMatchObject({
      success: false,
      available_skills: expect.arrayContaining(["analyst-only"]),
    });
  });

  it("lists and views available skills", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir);
    writeStats(path.join(tmp, "state"), {
      writer: {
        usageTurns: 3,
        intentMatchedTurns: 5,
        adoptedTurns: 2,
        adoptionRate: 0.4,
        lastUsedAt: "2026-07-01T00:00:00.000Z",
        last7DaysUsage: 1,
        lifecycle: "active",
        needsReview: true,
      },
    });
    registerSkillTools(api, {
      bundledSkillsDir: "",
      homeDir: path.join(tmp, "home"),
    });
    const tools = toolsForAgent(api);

    await expect(runTool(tools.get("skill_list"), {})).resolves.toMatchObject({
      success: true,
      count: 1,
      skills: [
        {
          name: "writer",
          description: "Write well.",
          source: "workspace",
        },
      ],
    });
    const listWithoutStats = await runTool(tools.get("skill_list"), {});
    expect(listWithoutStats.skills[0]).not.toHaveProperty("usage_stats");
    expect(listWithoutStats.skills[0]).not.toHaveProperty("related_skills");

    await expect(
      runTool(tools.get("skill_list"), {
        show_stats: true,
      }),
    ).resolves.toMatchObject({
      success: true,
      skills: [
        {
          name: "writer",
          usage_stats: {
            usage_turns: 3,
            intent_matched_turns: 5,
            adopted_turns: 2,
            adoption_rate: 0.4,
            last_used_at: "2026-07-01T00:00:00.000Z",
            last_7_days_usage: 1,
            lifecycle: "active",
            needs_review: true,
          },
        },
      ],
    });
    await expect(
      runTool(tools.get("skill_view"), { name: "writer" }),
    ).resolves.toMatchObject({
      success: true,
      name: "writer",
      content: expect.stringContaining("# Writer"),
      usage_stats: {
        usage_turns: 3,
        intent_matched_turns: 5,
        adopted_turns: 2,
        adoption_rate: 0.4,
      },
    });
  });

  it("lists direct related skills in both declared directions", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "nextjs", {
      react: "React fundamentals and patterns.",
      unavailable: "Must not appear because this skill is not visible.",
    });
    writeSkill(workspaceDir, "react", {
      nextjs: "Next.js App Router and deployment.",
    });
    await seedRelation(
      path.join(tmp, "state"),
      workspaceDir,
      "nextjs",
      workspaceDir,
      "react",
      "React fundamentals and patterns.",
    );
    await seedRelation(
      path.join(tmp, "state"),
      workspaceDir,
      "react",
      workspaceDir,
      "nextjs",
      "Next.js App Router and deployment.",
    );
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    const resultWithoutRelatedSkills = await runTool(tools.get("skill_list"), {
      source: "workspace",
    });
    expect(
      resultWithoutRelatedSkills.skills.every(
        (skill: Record<string, unknown>) => !("related_skills" in skill),
      ),
    ).toBe(true);

    const result = await runTool(tools.get("skill_list"), {
      source: "workspace",
      show_related: true,
    });
    const skillsByName = new Map(
      result.skills.map((skill: { name: string }) => [skill.name, skill]),
    );
    expect(JSON.stringify(result.skills)).not.toContain(
      '"verification_status"',
    );

    expect(skillsByName.get("nextjs")).toMatchObject({
      related_skills: [
        {
          name: "react",
          reason: "React fundamentals and patterns.",
          relation_type: "related",
          source: "author-import",
          direction: "current-to-related",
        },
        {
          name: "react",
          reason: "Next.js App Router and deployment.",
          direction: "related-to-current",
        },
      ],
    });
    expect(skillsByName.get("react")).toMatchObject({
      related_skills: [
        {
          name: "nextjs",
          reason: "Next.js App Router and deployment.",
          direction: "current-to-related",
        },
        {
          name: "nextjs",
          reason: "React fundamentals and patterns.",
          relation_type: "related",
          source: "author-import",
          direction: "related-to-current",
        },
      ],
    });

    await expect(
      runTool(tools.get("skill_view"), { name: "nextjs" }),
    ).resolves.toMatchObject({
      success: true,
      related_skills: [
        {
          name: "react",
          reason: "React fundamentals and patterns.",
          relation_type: "related",
          source: "author-import",
          direction: "current-to-related",
        },
        {
          name: "react",
          reason: "Next.js App Router and deployment.",
          direction: "related-to-current",
        },
      ],
    });
  });

  it("ignores metadata when graph is missing and stops displaying a corrupted graph", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-graph-"));
    try {
      const workspaceDir = path.join(tmp, "workspace"),
        stateDir = path.join(tmp, "state");
      writeSkill(workspaceDir, "a", {
        b: "Old metadata must not be a fallback.",
      });
      writeSkill(workspaceDir, "b");
      const api = createApi(stateDir, workspaceDir);
      registerSkillTools(api, {
        bundledSkillsDir: "",
        homeDir: path.join(tmp, "home"),
      });
      const view = toolsForAgent(api).get("skill_view");
      expect(await runTool(view, { name: "a" })).toMatchObject({
        related_skills: [],
      });
      await seedRelation(stateDir, workspaceDir, "a", workspaceDir, "b", "");
      expect(await runTool(view, { name: "a" })).toMatchObject({
        related_skills: [
          {
            name: "b",
            reason: "",
            relation_type: "related",
          },
        ],
      });
      fs.appendFileSync(
        relationGraphPath(path.join(stateDir, "plugins", "skill-harness")),
        '{"op":',
      );
      expect(await runTool(view, { name: "a" })).toMatchObject({
        related_skills: [],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds incoming related skills before pagination", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "alpha", {
      beta: "Alpha delegates the next step to beta.",
    });
    writeSkill(workspaceDir, "beta");
    await seedRelation(
      path.join(tmp, "state"),
      workspaceDir,
      "alpha",
      workspaceDir,
      "beta",
      "Alpha delegates the next step to beta.",
    );
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    await expect(
      runTool(tools.get("skill_list"), {
        offset: 1,
        limit: 1,
        show_related: true,
      }),
    ).resolves.toMatchObject({
      skills: [
        {
          name: "beta",
          related_skills: [
            {
              name: "alpha",
              reason: "Alpha delegates the next step to beta.",
              direction: "related-to-current",
            },
          ],
        },
      ],
    });
  });

  it("excludes shadowed skills from incoming relations", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(stateDir, workspaceDir);
    writeSkill(workspaceDir, "target");
    writeSkill(workspaceDir, "shadowed");
    writeSkill(stateDir, "managed-source", {
      target: "Visible without source filter.",
    });
    writeSkill(stateDir, "shadowed", {
      target: "Must not survive workspace precedence.",
    });
    await seedRelation(
      stateDir,
      stateDir,
      "managed-source",
      workspaceDir,
      "target",
      "Visible without source filter.",
    );
    await seedRelation(
      stateDir,
      stateDir,
      "shadowed",
      workspaceDir,
      "target",
      "Must not survive workspace precedence.",
    );
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    const result = await runTool(tools.get("skill_list"), {
      show_related: true,
    });
    expect(
      result.skills.find((skill: { name: string }) => skill.name === "target"),
    ).toMatchObject({
      related_skills: [
        {
          name: "managed-source",
          reason: "Visible without source filter.",
          direction: "related-to-current",
        },
      ],
    });
  });

  it("ignores related skill formats outside metadata.related-skills", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "target");
    const sourceDir = path.join(workspaceDir, "skills", "legacy-source");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "SKILL.md"),
      "---\nname: legacy-source\ndescription: Legacy relation format.\nmetadata:\n  hermes:\n    related_skills:\n      - target\n---\n\n# Legacy Source\n",
    );
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    const result = await runTool(tools.get("skill_list"), {
      show_related: true,
    });

    expect(
      result.skills.find(
        (skill: { name: string }) => skill.name === "legacy-source",
      ),
    ).toMatchObject({ related_skills: [] });
    expect(
      result.skills.find((skill: { name: string }) => skill.name === "target"),
    ).toMatchObject({ related_skills: [] });
  });

  it("paginates skill_list with a default page size of 150", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    for (let index = 0; index < 155; index += 1) {
      writeSkill(workspaceDir, `skill-${String(index).padStart(3, "0")}`);
    }
    registerSkillTools(api, {
      bundledSkillsDir: "",
      homeDir: path.join(tmp, "home"),
    });
    const tools = toolsForAgent(api);

    await expect(runTool(tools.get("skill_list"), {})).resolves.toMatchObject({
      success: true,
      total: 155,
      count: 150,
      offset: 0,
      limit: 150,
      has_more: true,
      next_offset: 150,
      skills: expect.arrayContaining([
        expect.objectContaining({ name: "skill-000" }),
        expect.objectContaining({ name: "skill-149" }),
      ]),
    });

    const secondPage = await runTool(tools.get("skill_list"), {
      offset: 150,
    });
    expect(secondPage).toMatchObject({
      success: true,
      total: 155,
      count: 5,
      offset: 150,
      limit: 150,
      has_more: false,
    });
    expect(secondPage).not.toHaveProperty("next_offset");
    expect(
      secondPage.skills.map((skill: { name: string }) => skill.name),
    ).toEqual([
      "skill-150",
      "skill-151",
      "skill-152",
      "skill-153",
      "skill-154",
    ]);
  });

  it("includes top-3 ranked related skills and total in skill_search by default, and omits both when show_related is false", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-search-related-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-search-related-state-"),
    );
    try {
      const dataRoot = path.join(stateDir, "plugins", "skill-harness");
      const names = [
        "hub",
        "orphan",
        "a-related",
        "b-similar",
        "x-imported-compose",
        "y-reviewed-compose",
        "z-depends",
      ];
      for (const name of names) writeSkill(workspaceDir, name);
      const source = await registerRelationSource(dataRoot, {
        id: "github:example/search-related",
        root: path.join(workspaceDir, "skills"),
        skills: Object.fromEntries(
          names.map((name) => [
            name,
            { name, source_path: `${name}/SKILL.md` },
          ]),
        ),
      });
      const registry = { version: 1 as const, sources: [source] };
      const identities = new Map(
        await Promise.all(
          names.map(async (name) => {
            const location = path.join(
              workspaceDir,
              "skills",
              name,
              "SKILL.md",
            );
            const identity = await readSkillIdentity(
              { name, location },
              registry,
            );
            expect(identity).toBeDefined();
            return [name, { identity: identity!, location }] as const;
          }),
        ),
      );
      const hub = identities.get("hub")!;
      await appendImportedRelations(dataRoot, [
        {
          from: hub.identity,
          to: identities.get("a-related")!.identity,
          type: "related",
          reason: "Broad related link.",
        },
        {
          from: hub.identity,
          to: identities.get("b-similar")!.identity,
          type: "similar_to",
          reason: "Overlapping alternative.",
        },
        {
          from: hub.identity,
          to: identities.get("x-imported-compose")!.identity,
          type: "composes_with",
          reason: "Imported workflow handoff.",
        },
        {
          from: hub.identity,
          to: identities.get("z-depends")!.identity,
          type: "depends_on",
          reason: "Explicit prerequisite.",
        },
      ]);
      const reviewedTarget = identities.get("y-reviewed-compose")!;
      await applyRelationReviewChanges(
        dataRoot,
        [
          {
            operation: "create",
            from: hub.identity,
            to: reviewedTarget.identity,
            expected: null,
            type: "composes_with",
            reason: "Reviewed workflow handoff.",
            rationale: "Both docs describe a verified workflow handoff.",
            evidence: [hub, reviewedTarget].map((entry) => ({
              skillId: entry.identity.id,
              filePath: "SKILL.md",
              startLine: 6,
              endLine: 6,
              quote: `# ${entry.identity.name}`,
              fileDigest: createHash("sha256")
                .update(fs.readFileSync(entry.location))
                .digest("hex"),
            })),
          },
        ],
        {
          batchId: "search-related-review-batch",
          eventId: "search-related-review-event",
          agentId: "main",
          assertCurrent: async () => {},
        },
      );

      const api = createApi(stateDir, workspaceDir);
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => [
          { name: "hub", score: 0.95 },
          { name: "z-depends", score: 0.7 },
          { name: "orphan", score: 0.5 },
        ]),
        getStatus: vi.fn(() => "ready"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(api, {
        qmdSkillIndex,
        bundledSkillsDir: "",
        homeDir: path.join(stateDir, "home"),
      });
      const tools = toolsForAgent(api, "main");
      const search = tools.get("skill_search");
      const view = tools.get("skill_view");
      const list = tools.get("skill_list");
      expect(search).toBeTruthy();

      const defaultResult = await runTool(search, { query: "hub" });
      expect(defaultResult.skills[0]).toMatchObject({
        name: "hub",
        related_skills_total: 5,
        related_skills: [
          {
            name: "z-depends",
            relation_type: "depends_on",
            source: "author-import",
            direction: "current-to-related",
          },
          {
            name: "y-reviewed-compose",
            relation_type: "composes_with",
            source: "review",
            direction: "current-to-related",
          },
          {
            name: "x-imported-compose",
            relation_type: "composes_with",
            source: "author-import",
            direction: "current-to-related",
          },
        ],
      });
      expect(defaultResult.skills[0].related_skills).toHaveLength(3);
      expect(defaultResult.skills[1]).toMatchObject({
        name: "z-depends",
        related_skills_total: 1,
        related_skills: [
          {
            name: "hub",
            relation_type: "depends_on",
            source: "author-import",
            direction: "related-to-current",
          },
        ],
      });
      expect(defaultResult.skills[2]).toMatchObject({
        name: "orphan",
        related_skills: [],
        related_skills_total: 0,
      });

      const withoutRelated = await runTool(search, {
        query: "hub",
        show_related: false,
      });
      for (const entry of withoutRelated.skills) {
        expect(entry).not.toHaveProperty("related_skills");
        expect(entry).not.toHaveProperty("related_skills_total");
      }

      const expectedFullOrder = [
        "z-depends",
        "y-reviewed-compose",
        "x-imported-compose",
        "b-similar",
        "a-related",
      ];
      const viewResult = await runTool(view, { name: "hub" });
      expect(
        viewResult.related_skills.map((entry: { name: string }) => entry.name),
      ).toEqual(expectedFullOrder);

      const listWithRelated = await runTool(list, { show_related: true });
      const hubEntry = listWithRelated.skills.find(
        (entry: { name: string }) => entry.name === "hub",
      );
      expect(
        hubEntry.related_skills.map((entry: { name: string }) => entry.name),
      ).toEqual(expectedFullOrder);

      // Fail-open when graph is corrupted.
      fs.appendFileSync(relationGraphPath(dataRoot), '{"op":');
      const corruptedResult = await runTool(search, { query: "hub" });
      expect(corruptedResult.skills[0]).toMatchObject({
        name: "hub",
        related_skills: [],
        related_skills_total: 0,
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves distinct NFKC-equivalent skill identities and relations across search, list, view, and review binding", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-nfkc-"));
    try {
      const workspaceDir = path.join(tmp, "workspace");
      const stateDir = path.join(tmp, "state");
      const fullwidthAlpha = "ａｌｐｈａ";
      const fullwidthBeta = "ｂｅｔａ";
      writeSkill(workspaceDir, "alpha", {}, "ASCII alpha skill.");
      writeSkill(workspaceDir, fullwidthAlpha, {}, "Fullwidth alpha skill.");
      writeSkill(workspaceDir, "beta", {}, "ASCII beta skill.");
      writeSkill(workspaceDir, fullwidthBeta, {}, "Fullwidth beta skill.");
      writeSkill(workspaceDir, "target", {}, "Target skill.");

      await seedRelation(
        stateDir,
        workspaceDir,
        fullwidthAlpha,
        workspaceDir,
        "target",
        "Fullwidth alpha links to target.",
      );
      await seedRelation(
        stateDir,
        workspaceDir,
        "beta",
        workspaceDir,
        "target",
        "ASCII beta links to target.",
      );

      const api = createApi(stateDir, workspaceDir);
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => [
          {
            name: "alpha",
            score: 0.92,
            evidence: [
              {
                collection: "skill-meta",
                path: "alpha/SKILL.md",
                score: 0.92,
                snippet: "ASCII alpha skill.",
              },
            ],
          },
          {
            name: fullwidthAlpha,
            score: 0.81,
            evidence: [
              {
                collection: "skill-meta",
                path: "fullwidth-alpha/SKILL.md",
                score: 0.81,
                snippet: "Fullwidth alpha skill.",
              },
            ],
          },
          { name: "beta", score: 0.72 },
          { name: fullwidthBeta, score: 0.61 },
        ]),
        getStatus: vi.fn(() => "ready"),
        close: vi.fn(async () => {}),
      };
      const registry = createReviewToolRegistry();
      registerSkillTools(api, {
        qmdSkillIndex,
        reviewToolRegistry: registry,
        bundledSkillsDir: "",
        homeDir: path.join(tmp, "home"),
      });
      const tools = toolsForAgent(api, "main");
      const search = tools.get("skill_search");
      const list = tools.get("skill_list");
      const view = tools.get("skill_view");

      const searchDefault = await runTool(search, { query: "alpha" });
      expect(searchDefault.skills.map((s: { name: string }) => s.name)).toEqual(
        ["alpha", fullwidthAlpha, "beta", fullwidthBeta],
      );
      expect(searchDefault.skills[0]).toMatchObject({
        name: "alpha",
        description: "ASCII alpha skill.",
        score: 0.92,
        evidence: [{ snippet: "ASCII alpha skill." }],
        related_skills: [],
        related_skills_total: 0,
      });
      expect(searchDefault.skills[1]).toMatchObject({
        name: fullwidthAlpha,
        description: "Fullwidth alpha skill.",
        score: 0.81,
        evidence: [{ snippet: "Fullwidth alpha skill." }],
        related_skills: [
          {
            name: "target",
            reason: "Fullwidth alpha links to target.",
            direction: "current-to-related",
          },
        ],
        related_skills_total: 1,
      });
      expect(searchDefault.skills[2]).toMatchObject({
        name: "beta",
        related_skills: [
          {
            name: "target",
            reason: "ASCII beta links to target.",
            direction: "current-to-related",
          },
        ],
        related_skills_total: 1,
      });
      expect(searchDefault.skills[3]).toMatchObject({
        name: fullwidthBeta,
        related_skills: [],
        related_skills_total: 0,
      });

      const searchNoRelated = await runTool(search, {
        query: "alpha",
        show_related: false,
      });
      expect(
        searchNoRelated.skills.map((s: { name: string }) => s.name),
      ).toEqual(["alpha", fullwidthAlpha, "beta", fullwidthBeta]);

      const run = registry.register({
        agentId: "main",
        sessionId: "nfkc-review",
        sessionKey: "nfkc-review-key",
      });
      try {
        const reviewTools = toolsForAgent(api, "main", {
          sessionId: "nfkc-review",
          sessionKey: "nfkc-review-key",
          toolBindings: structuredClone({
            [REVIEW_TOOL_BINDING_KEY]: run.binding,
          }),
        });
        const reviewSearch = await runTool(reviewTools.get("skill_search"), {
          query: "alpha",
        });
        expect(
          reviewSearch.skills.map((s: { name: string }) => s.name),
        ).toEqual(["alpha", fullwidthAlpha, "beta", fullwidthBeta]);
      } finally {
        await run.close();
      }

      const listRes = await runTool(list, { show_related: true });
      const byName = new Map(
        listRes.skills.map((s: { name: string }) => [s.name, s]),
      );
      expect(byName.get("alpha")).toMatchObject({ related_skills: [] });
      expect(byName.get(fullwidthAlpha)).toMatchObject({
        related_skills: [{ name: "target" }],
      });
      expect(byName.get("beta")).toMatchObject({
        related_skills: [{ name: "target" }],
      });
      expect(byName.get(fullwidthBeta)).toMatchObject({ related_skills: [] });

      expect(await runTool(view, { name: "alpha" })).toMatchObject({
        related_skills: [],
      });
      expect(await runTool(view, { name: fullwidthAlpha })).toMatchObject({
        related_skills: [{ name: "target" }],
      });
      expect(await runTool(view, { name: "beta" })).toMatchObject({
        related_skills: [{ name: "target" }],
      });
      expect(await runTool(view, { name: fullwidthBeta })).toMatchObject({
        related_skills: [],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips stats and graph file I/O on unavailable, empty, non-visible, and opt-out skill_search paths", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-io-"));
    try {
      const workspaceDir = path.join(tmp, "workspace");
      const stateDir = path.join(tmp, "state");
      const dataRoot = path.join(stateDir, "plugins", "skill-harness");
      const statsFile = path.join(dataRoot, "stats.json");
      const graphFile = relationGraphPath(dataRoot);
      writeSkill(workspaceDir, "react", {}, "Build React UIs");
      writeSkill(workspaceDir, "nextjs", {}, "Build Next.js apps");
      writeStats(stateDir, {
        react: {
          usageTurns: 5,
          intentMatchedTurns: 4,
          adoptedTurns: 3,
          adoptionRate: 0.75,
          last7DaysUsage: 2,
          lifecycle: "active",
          needsReview: false,
        },
      });
      await seedRelation(
        stateDir,
        workspaceDir,
        "react",
        workspaceDir,
        "nextjs",
        "React composes with Next.js.",
      );

      let nextHits: Array<{ name: string; score: number }> | undefined =
        undefined;
      const api = createApi(stateDir, workspaceDir);
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => nextHits),
        getStatus: vi.fn(() => "ready"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(api, {
        qmdSkillIndex,
        bundledSkillsDir: "",
        homeDir: path.join(tmp, "home"),
      });
      const search = toolsForAgent(api, "main").get("skill_search");

      const readFileSyncSpy = vi.mocked(fs.readFileSync);
      const statAsyncSpy = vi.mocked(fs.promises.stat);
      const countStatsReads = () =>
        readFileSyncSpy.mock.calls.filter(([target]) => target === statsFile)
          .length;
      const countGraphStats = () =>
        statAsyncSpy.mock.calls.filter(([target]) => target === graphFile)
          .length;

      // 1. Index unavailable -> 0 stats reads, 0 graph reads
      nextHits = undefined;
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(await runTool(search, { query: "react" })).toMatchObject({
        success: false,
      });
      expect(countStatsReads()).toBe(0);
      expect(countGraphStats()).toBe(0);

      // 2. Empty hits -> 0 stats reads, 0 graph reads
      nextHits = [];
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(await runTool(search, { query: "react" })).toMatchObject({
        success: true,
        total: 0,
        skills: [],
      });
      expect(countStatsReads()).toBe(0);
      expect(countGraphStats()).toBe(0);

      // 3. Only non-visible hit -> 0 stats reads, 0 graph reads
      nextHits = [{ name: "nonexistent", score: 0.9 }];
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(await runTool(search, { query: "react" })).toMatchObject({
        success: true,
        total: 0,
        skills: [],
      });
      expect(countStatsReads()).toBe(0);
      expect(countGraphStats()).toBe(0);

      // 4. Visible hit with show_related: false and show_stats: false -> 0 stats reads, 0 graph reads
      nextHits = [{ name: "react", score: 0.9 }];
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(
        await runTool(search, { query: "react", show_related: false }),
      ).toMatchObject({ success: true, total: 1 });
      expect(countStatsReads()).toBe(0);
      expect(countGraphStats()).toBe(0);

      // 5. Visible hit with default params (show_related: true, show_stats: false) -> 0 stats reads, 1 graph stat
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(await runTool(search, { query: "react" })).toMatchObject({
        success: true,
        skills: [{ name: "react", related_skills_total: 1 }],
      });
      expect(countStatsReads()).toBe(0);
      expect(countGraphStats()).toBe(1);

      // 6. Visible hit with show_stats: true -> exactly 1 stats read (not 2)
      readFileSyncSpy.mockClear();
      statAsyncSpy.mockClear();
      expect(
        await runTool(search, { query: "react", show_stats: true }),
      ).toMatchObject({
        success: true,
        skills: [{ name: "react", usage_stats: { usage_turns: 5 } }],
      });
      expect(countStatsReads()).toBe(1);
      expect(countGraphStats()).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("records skill usage into state openclaw.sqlite when skill_view is called", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-db-"));
    const stateDir = path.join(tmp, "state");
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(stateDir, workspaceDir);
    writeSkill(workspaceDir);

    const innerStateDir = path.join(stateDir, "state");
    fs.mkdirSync(innerStateDir, { recursive: true });
    const dbPath = path.join(innerStateDir, "openclaw.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE skill_usage (
        skill_file TEXT NOT NULL PRIMARY KEY,
        skill_key TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_source TEXT NOT NULL,
        first_used_at_ms INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        use_count INTEGER NOT NULL,
        last_agent_id TEXT
      ) STRICT;
    `);
    db.close();

    const registry = createReviewToolRegistry();
    registerSkillTools(api, {
      reviewToolRegistry: registry,
      bundledSkillsDir: "",
      homeDir: path.join(tmp, "home"),
    });
    const tools = toolsForAgent(api);
    const run = registry.register({
      agentId: "main",
      sessionId: "review-1",
      sessionKey: "review-key",
    });
    const reviewTools = toolsForAgent(api, "main", {
      sessionId: "review-1",
      sessionKey: "review-key",
      toolBindings: structuredClone({ [REVIEW_TOOL_BINDING_KEY]: run.binding }),
    });
    await expect(
      runTool(reviewTools.get("skill_search"), { query: " " }),
    ).resolves.toMatchObject({ success: false });
    expect(run.searchCount).toBe(0);
    const inspection = await runTool(reviewTools.get("skill_view"), {
      name: "writer",
    });
    expect(inspection).toMatchObject({
      success: true,
      review_inspection: true,
      relation_review: {
        eligible: false,
        reason: "relation-review-unavailable",
      },
    });
    const before = new DatabaseSync(dbPath);
    expect(before.prepare("SELECT * FROM skill_usage").all()).toHaveLength(0);
    before.close();
    await run.close();
    await expect(
      runTool(reviewTools.get("skill_view"), { name: "writer" }),
    ).rejects.toThrow("review-tool-closed");
    await expect(
      runTool(reviewTools.get("skill_search"), { query: "writer" }),
    ).rejects.toThrow("review-tool-closed");
    const invalidTools = toolsForAgent(api, "main", {
      sessionId: "review-1",
      sessionKey: "review-key",
      toolBindings: { [REVIEW_TOOL_BINDING_KEY]: null },
    });
    await expect(
      runTool(invalidTools.get("skill_view"), { name: "writer" }),
    ).rejects.toThrow("invalid-review-tool-binding");
    await runTool(tools.get("skill_view"), { name: "writer" });

    const checkDb = new DatabaseSync(dbPath);
    const rows = checkDb.prepare("SELECT * FROM skill_usage").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill_key: "writer",
      skill_name: "writer",
      skill_source: "workspace",
      use_count: 1,
      last_agent_id: "main",
    });
    checkDb.close();

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
