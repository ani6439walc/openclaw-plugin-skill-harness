import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSkillTools } from "./tools.js";
import type { OpenClawPluginApi } from "../../api.js";
import type { IntentCatalogEntry } from "../types.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";
import { SkillExperienceCatalog } from "../experiences/index.js";

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

function writeExperience(
  dataRoot: string,
  skill: string,
  entryId: string,
  body: string,
): void {
  const directory = path.join(dataRoot, "experiences", skill);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${entryId}.md`),
    `---\nskill: ${skill}\nsummary: ${entryId} summary\nkeywords: [${entryId}]\n---\n${body}\n`,
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
      guidance: "Use the writer skill.",
    },
  },
  {
    id: "writer-body",
    definition: {
      triggers: ["agent workflow"],
      examples: ["agent workflow"],
      domain: "agent-ops",
      skills: ["writer"],
      fastpath: { keywords: [] },
      guidance: "Use the writer workflow when drafting workflow text.",
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
  it("registers the four skill tools followed by agent-scoped skill_experience", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, path.join(tmp, "workspace"));

    registerSkillTools(api, {
      experienceCatalog: new SkillExperienceCatalog(
        path.join(stateDir, "plugins", "skill-harness"),
      ),
    });

    expect(api.registerTool).toHaveBeenCalledTimes(5);
    expect([...toolsForAgent(api).keys()]).toEqual([
      "skill_list",
      "skill_search",
      "skill_view",
      "skill_manage",
      "skill_experience",
    ]);
    const toolsWithoutAgent = toolsForAgent(api, "");
    expect(toolsWithoutAgent.has("skill_list")).toBe(false);
    expect(toolsWithoutAgent.has("skill_search")).toBe(false);
    expect(toolsWithoutAgent.has("skill_view")).toBe(false);
    expect(toolsWithoutAgent.has("skill_experience")).toBe(false);
  });

  it("describes focused discovery, required reading, and authorized mutation", () => {
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
    expect(description("skill_manage")).toContain(
      "Use only when available and authorized",
    );
  });

  it("returns only bounded experience for requested skills visible to the invoking agent", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    const mainWorkspace = path.join(tmp, "main-workspace");
    const analystWorkspace = path.join(tmp, "analyst-workspace");
    const api = createApi(stateDir, {
      main: mainWorkspace,
      analyst: analystWorkspace,
    });
    writeSkill(mainWorkspace, "react");
    writeSkill(analystWorkspace, "vue");
    writeExperience(dataRoot, "react", "alpha", "😀".repeat(2_500));
    writeExperience(dataRoot, "react", "beta", "b".repeat(2_500));
    writeExperience(dataRoot, "react", "gamma", "c".repeat(2_500));
    writeExperience(dataRoot, "react", "ignored", "d".repeat(100));
    writeExperience(dataRoot, "vue", "private", "private analyst guidance");
    const experienceFile = path.join(
      dataRoot,
      "experiences",
      "react",
      "alpha.md",
    );
    const readBefore = fs.readFileSync(experienceFile, "utf8");

    registerSkillTools(api, {
      experienceCatalog: new SkillExperienceCatalog(dataRoot),
    });
    const tool = toolsForAgent(api, "main").get("skill_experience");
    const result = await runTool(tool, {
      skills: [" REACT ", "react", "vue", "missing"],
    });

    expect(result).toMatchObject({
      success: true,
      unavailable_skills: ["vue", "missing"],
    });
    expect(
      result.entries.map((entry: { identity: string }) => entry.identity),
    ).toEqual(["react/alpha", "react/beta", "react/gamma"]);
    expect(
      result.entries.map(
        (entry: { body: string }) => Array.from(entry.body).length,
      ),
    ).toEqual([2_000, 2_000, 1_000]);
    expect(result.entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.anything() }),
      ]),
    );
    expect(fs.readFileSync(experienceFile, "utf8")).toBe(readBefore);
    expect(api.runtime.agent).not.toHaveProperty("runEmbeddedAgent");
  });

  it("uses the catalog canonical identity for the invoking agent visibility intersection", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    const mainWorkspace = path.join(tmp, "main-workspace");
    const analystWorkspace = path.join(tmp, "analyst-workspace");
    const api = createApi(stateDir, {
      main: mainWorkspace,
      analyst: analystWorkspace,
    });
    writeSkill(mainWorkspace, "react");
    writeSkill(analystWorkspace, "vue");
    writeExperience(dataRoot, "react", "forms", "Use controlled forms.");
    writeExperience(dataRoot, "vue", "signals", "Use explicit signals.");

    registerSkillTools(api, {
      experienceCatalog: new SkillExperienceCatalog(dataRoot),
    });
    const result = await runTool(
      toolsForAgent(api, "main").get("skill_experience"),
      { skills: ["ＲＥＡＣＴ", "ＶＵＥ"] },
    );

    expect(result).toMatchObject({
      success: true,
      requested_skills: ["react", "vue"],
      unavailable_skills: ["vue"],
      entries: [expect.objectContaining({ identity: "react/forms" })],
    });
  });

  it("validates skill count and Unicode query length at execution", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const workspace = path.join(tmp, "workspace");
    const api = createApi(stateDir, workspace);
    writeSkill(workspace, "react");
    registerSkillTools(api, {
      experienceCatalog: new SkillExperienceCatalog(
        path.join(stateDir, "plugins", "skill-harness"),
      ),
    });
    const tool = toolsForAgent(api).get("skill_experience");

    await expect(runTool(tool, { skills: [] })).resolves.toMatchObject({
      success: false,
    });
    await expect(
      runTool(tool, { skills: ["react", 3] }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      runTool(tool, {
        skills: Array.from({ length: 7 }, (_, index) => `s${index}`),
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      runTool(tool, { skills: ["react"], query: "😀".repeat(501) }),
    ).resolves.toEqual({
      success: false,
      error: "query must contain at most 500 Unicode code points",
    });
    await expect(
      runTool(tool, { skills: ["react"], query: 3 }),
    ).resolves.toEqual({
      success: false,
      error: "query must be a string",
    });
  });

  it("returns an explicit empty result when visible skills have no experience", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const stateDir = path.join(tmp, "state");
    const workspace = path.join(tmp, "workspace");
    const api = createApi(stateDir, workspace);
    writeSkill(workspace, "react");
    registerSkillTools(api, {
      experienceCatalog: new SkillExperienceCatalog(
        path.join(stateDir, "plugins", "skill-harness"),
      ),
    });

    await expect(
      runTool(toolsForAgent(api).get("skill_experience"), {
        skills: ["react"],
      }),
    ).resolves.toEqual({
      success: true,
      requested_skills: ["react"],
      unavailable_skills: [],
      entries: [],
    });
  });

  it("searches visible skills through the QMD skill index", async () => {
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
      const intents: IntentCatalogEntry[] = [
        {
          id: "frontend",
          definition: {
            domain: "frontend",
            triggers: ["react"],
            examples: ["build a react ui"],
            skills: ["react"],
            fastpath: { keywords: ["react"] },
            guidance: "Use the react skill for UI work.",
          },
        },
      ];
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
        getIntents: () => intents,
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
            domains: ["frontend"],
            score: 0.84,
          },
        ],
      });
      expect(result.skills[0]).not.toHaveProperty("usage_stats");
      expect(result.skills[0]).not.toHaveProperty("evidence");
      expect(scheduleSkillSearchIndex).not.toHaveBeenCalledWith("main");
      expect(qmdSkillIndex.schedule).not.toHaveBeenCalled();
      expect(qmdSkillIndex.search).toHaveBeenCalledWith({
        agentId: "main",
        query: "react ui",
        limit: 20,
        includeEvidence: false,
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

  it("validates search criteria and keeps evidence and stats opt-in", async () => {
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
        skills: [{ name: "react", score: 0.84 }],
      });
      expect(defaultResult.skills[0]).not.toHaveProperty("usage_stats");
      expect(defaultResult.skills[0]).not.toHaveProperty("evidence");
      expect(defaultResult.skills[0]).not.toHaveProperty("related_skills");

      const richResult = await runTool(search, {
        query: "react",
        show_stats: true,
        show_evidence: true,
      });
      expect(richResult.skills[0]).toHaveProperty("usage_stats");
      expect(richResult.skills[0]).toMatchObject({
        evidence: [
          {
            collection: "skill-meta",
            path: "meta.md",
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

  it("schedules skill search index after successful skill_manage", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-manage-qmd-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "skill-tools-manage-state-"),
    );
    try {
      const api = createApi(stateDir, workspaceDir);
      const scheduleSkillSearchIndex = vi.fn();
      const qmdSkillIndex: SkillQmdIndex = {
        schedule: vi.fn(),
        search: vi.fn(async () => []),
        getStatus: vi.fn((_agentId: string) => "ready"),
        close: vi.fn(async () => {}),
      };
      registerSkillTools(api, { qmdSkillIndex, scheduleSkillSearchIndex });
      const manage = toolsForAgent(api, "main").get("skill_manage");
      expect(manage).toBeTruthy();
      const result = await runTool(manage, {
        action: "create",
        name: "fresh-skill",
        content:
          "---\nname: fresh-skill\ndescription: Fresh skill\n---\n\n# Fresh\n",
      });
      expect(result).toMatchObject({ success: true });
      expect(scheduleSkillSearchIndex).not.toHaveBeenCalledWith("main");
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
