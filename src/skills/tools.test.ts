import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSkillTools } from "./tools.js";
import type { OpenClawPluginApi } from "../../api.js";
import type { IntentCatalogEntry } from "../types.js";

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

const TOOL_TEST_INTENTS: IntentCatalogEntry[] = [
  {
    id: "writer-frontmatter",
    definition: {
      triggers: ["write"],
      examples: ["write this"],
      domain: "writing",
      fastpath: { keywords: [] },
      skills: ["writer"],
      prompt: "Use the writer skill.",
    },
  },
  {
    id: "writer-body",
    definition: {
      triggers: ["agent workflow"],
      examples: ["agent workflow"],
      domain: "agent-ops",
      fastpath: { keywords: [] },
      prompt: "Use skill: writer when drafting workflow text.",
    },
  },
];

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
  fs.writeFileSync(statsFile, JSON.stringify({ schemaVersion: 1, skills }));
}

async function runTool(tool: unknown, params: Record<string, unknown>) {
  const result = await (
    tool as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).execute("tool-call", params);
  return JSON.parse(result.content[0]?.text ?? "{}");
}

function toolsForAgent(
  api: ReturnType<typeof createApi>,
  agentId = "main",
): Map<string, unknown> {
  return new Map(
    api.registerTool.mock.calls.flatMap(([registeredTool]) => {
      const resolved =
        typeof registeredTool === "function"
          ? (registeredTool as (context: { agentId?: string }) => unknown)({
              agentId,
            })
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
  it("registers skill_list, skill_search, skill_view, and skill_manage tools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const api = createApi(path.join(tmp, "state"), path.join(tmp, "workspace"));

    registerSkillTools(api);

    expect(api.registerTool).toHaveBeenCalledTimes(4);
    expect([...toolsForAgent(api).keys()]).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
      "skill_manage",
    ]);
    const toolsWithoutAgent = toolsForAgent(api, "");
    expect(toolsWithoutAgent.has("skill_list")).toBe(false);
    expect(toolsWithoutAgent.has("skill_search")).toBe(false);
    expect(toolsWithoutAgent.has("skill_view")).toBe(false);
  });

  it("searches with the invoking agent's skill roots and filtered intents", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const mainWorkspace = path.join(tmp, "main-workspace");
    const analystWorkspace = path.join(tmp, "analyst-workspace");
    const api = createApi(stateDir, {
      analyst: analystWorkspace,
      main: mainWorkspace,
    });
    writeSkill(mainWorkspace, "main-only", {}, "Main workspace skill.");
    writeSkill(
      analystWorkspace,
      "analyst-only",
      {},
      "Analyst workspace skill.",
    );
    const getIntents = vi.fn((agentId: string): IntentCatalogEntry[] => [
      {
        id: `${agentId}-workflow`,
        definition: {
          triggers: [`${agentId}-private-secret`],
          examples: [],
          domain: agentId,
          fastpath: { keywords: [] },
          skills: [`${agentId}-only`],
          prompt: "",
        },
      },
    ]);
    registerSkillTools(api, { getIntents });

    const analystSearch = toolsForAgent(api, "analyst").get("skill_search");
    await expect(
      runTool(analystSearch, { query: "analyst-private-secret" }),
    ).resolves.toMatchObject({
      success: true,
      skills: [
        {
          name: "analyst-only",
          matched_intents: [{ id: "analyst-workflow" }],
        },
      ],
    });
    await expect(
      runTool(analystSearch, { query: "main-private-secret" }),
    ).resolves.toMatchObject({ success: true, total: 0, skills: [] });
    expect(getIntents).toHaveBeenCalledWith("analyst");
  });

  it("validates search criteria and keeps verbose search fields opt-in", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "react", {}, "React forms and components.");
    registerSkillTools(api);
    const search = toolsForAgent(api).get("skill_search");

    await expect(runTool(search, { query: "   " })).resolves.toEqual({
      success: false,
      error: "query or at least one filter is required",
    });

    const defaultResult = await runTool(search, { query: "react" });
    expect(defaultResult.skills[0]).toMatchObject({
      name: "react",
      matched_fields: ["name", "description"],
    });
    expect(defaultResult.skills[0]).not.toHaveProperty("usage_stats");
    expect(defaultResult.skills[0]).not.toHaveProperty("related_skills");

    const compactResult = await runTool(search, {
      query: "react",
      show_matches: false,
      show_stats: true,
      show_related: true,
    });
    expect(compactResult.skills[0]).toHaveProperty("usage_stats");
    expect(compactResult.skills[0]).toHaveProperty("related_skills");
    expect(compactResult.skills[0]).not.toHaveProperty("matched_fields");
    expect(compactResult.skills[0]).not.toHaveProperty("matched_intents");
  });

  it("builds related search metadata before applying domain filters", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "nextjs", {
      react: "React fundamentals.",
    });
    writeSkill(workspaceDir, "react");
    const intents: IntentCatalogEntry[] = [
      {
        id: "web-framework",
        definition: {
          triggers: ["web framework"],
          examples: [],
          domain: "web",
          fastpath: { keywords: [] },
          skills: ["nextjs"],
          prompt: "",
        },
      },
      {
        id: "frontend-library",
        definition: {
          triggers: ["frontend library"],
          examples: [],
          domain: "frontend",
          fastpath: { keywords: [] },
          skills: ["react"],
          prompt: "",
        },
      },
    ];
    registerSkillTools(api, { getIntents: () => intents });

    await expect(
      runTool(toolsForAgent(api).get("skill_search"), {
        query: "react",
        domains: ["web"],
        show_related: true,
      }),
    ).resolves.toMatchObject({
      success: true,
      skills: [
        {
          name: "nextjs",
          score: 15,
          matched_fields: ["related_skills"],
          related_skills: [
            expect.objectContaining({
              name: "react",
              direction: "current-to-related",
            }),
          ],
        },
      ],
    });
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
        recommendedTurns: 5,
        adoptedTurns: 2,
        adoptionRate: 0.4,
        lastUsedAt: "2026-07-01T00:00:00.000Z",
        last7DaysUsage: 1,
        lifecycle: "active",
        needsReview: true,
      },
    });
    registerSkillTools(api, { getIntents: () => TOOL_TEST_INTENTS });
    const tools = toolsForAgent(api);

    await expect(
      runTool(tools.get("skill_list"), { source: "workspace" }),
    ).resolves.toMatchObject({
      success: true,
      count: 1,
      skills: [
        {
          name: "writer",
          description: "Write well.",
          source: "workspace",
          domains: ["agent-ops", "writing"],
        },
      ],
    });
    const listWithoutStats = await runTool(tools.get("skill_list"), {
      source: "workspace",
    });
    expect(listWithoutStats.skills[0]).not.toHaveProperty("usage_stats");
    expect(listWithoutStats.skills[0]).not.toHaveProperty("related_skills");

    await expect(
      runTool(tools.get("skill_list"), {
        source: "workspace",
        show_stats: true,
      }),
    ).resolves.toMatchObject({
      success: true,
      skills: [
        {
          name: "writer",
          usage_stats: {
            usage_turns: 3,
            recommended_turns: 5,
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
      runTool(tools.get("skill_list"), { source: "managed" }),
    ).resolves.toMatchObject({
      success: true,
      count: 0,
      skills: [],
    });
    await expect(
      runTool(tools.get("skill_view"), { name: "writer" }),
    ).resolves.toMatchObject({
      success: true,
      name: "writer",
      domains: ["agent-ops", "writing"],
      content: expect.stringContaining("# Writer"),
      usage_stats: {
        usage_turns: 3,
        recommended_turns: 5,
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

    expect(skillsByName.get("nextjs")).toMatchObject({
      related_skills: [
        {
          name: "react",
          reason: "React fundamentals and patterns.",
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

  it("builds incoming related skills before pagination", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(path.join(tmp, "state"), workspaceDir);
    writeSkill(workspaceDir, "alpha", {
      beta: "Alpha delegates the next step to beta.",
    });
    writeSkill(workspaceDir, "beta");
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    await expect(
      runTool(tools.get("skill_list"), {
        source: "workspace",
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

  it("excludes filtered and shadowed skills from incoming relations", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const workspaceDir = path.join(tmp, "workspace");
    const api = createApi(stateDir, workspaceDir);
    writeSkill(workspaceDir, "target");
    writeSkill(workspaceDir, "shadowed");
    writeSkill(stateDir, "managed-source", {
      target: "Visible only without a source filter.",
    });
    writeSkill(stateDir, "shadowed", {
      target: "Must not survive workspace precedence.",
    });
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    const workspaceOnly = await runTool(tools.get("skill_list"), {
      source: "workspace",
      show_related: true,
    });
    expect(
      workspaceOnly.skills.find(
        (skill: { name: string }) => skill.name === "target",
      ),
    ).toMatchObject({ related_skills: [] });

    const allSources = await runTool(tools.get("skill_list"), {
      show_related: true,
    });
    expect(
      allSources.skills.find(
        (skill: { name: string }) => skill.name === "target",
      ),
    ).toMatchObject({
      related_skills: [
        {
          name: "managed-source",
          reason: "Visible only without a source filter.",
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
      source: "workspace",
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
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    await expect(
      runTool(tools.get("skill_list"), { source: "workspace" }),
    ).resolves.toMatchObject({
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
      source: "workspace",
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

  it("creates skills through skill_manage", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir);
    registerSkillTools(api);
    const tools = toolsForAgent(api);

    await expect(
      runTool(tools.get("skill_manage"), {
        action: "create",
        name: "managed-skill",
        content:
          "---\nname: managed-skill\ndescription: Managed by tool.\n---\n\n# Managed Skill\n",
      }),
    ).resolves.toMatchObject({ success: true });

    await expect(
      runTool(tools.get("skill_view"), { name: "managed-skill" }),
    ).resolves.toMatchObject({
      success: true,
      name: "managed-skill",
      source: "managed",
      domains: [],
    });
  });
});
