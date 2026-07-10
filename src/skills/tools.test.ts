import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSkillTools } from "./tools.js";
import type { OpenClawPluginApi } from "../../api.js";
import type { IntentCatalogEntry } from "../types.js";

function createApi(
  stateDir: string,
  workspaceDir: string,
): OpenClawPluginApi & {
  registerTool: ReturnType<typeof vi.fn>;
} {
  return {
    config: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentWorkspaceDir: () => workspaceDir },
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
    `---\nname: ${name}\ndescription: Write well.\n${relatedSkillsFrontmatter}---\n\n# ${heading}\n`,
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

describe("registerSkillTools", () => {
  it("registers skill_list, skill_view, and skill_manage tools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tools-"));
    const api = createApi(path.join(tmp, "state"), path.join(tmp, "workspace"));

    registerSkillTools(api);

    expect(api.registerTool).toHaveBeenCalledTimes(3);
    expect(api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "skill_list",
      "skill_view",
      "skill_manage",
    ]);
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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

    const result = await runTool(tools.get("skill_list"), {
      source: "workspace",
    });
    const skillsByName = new Map(
      result.skills.map((skill: { name: string }) => [skill.name, skill]),
    );

    expect(skillsByName.get("nextjs")).toMatchObject({
      related_skills: [
        {
          name: "react",
          reason: "React fundamentals and patterns.",
          direction: "current_to_related",
        },
        {
          name: "react",
          reason: "Next.js App Router and deployment.",
          direction: "related_to_current",
        },
      ],
    });
    expect(skillsByName.get("react")).toMatchObject({
      related_skills: [
        {
          name: "nextjs",
          reason: "Next.js App Router and deployment.",
          direction: "current_to_related",
        },
        {
          name: "nextjs",
          reason: "React fundamentals and patterns.",
          direction: "related_to_current",
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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

    await expect(
      runTool(tools.get("skill_list"), {
        source: "workspace",
        offset: 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      skills: [
        {
          name: "beta",
          related_skills: [
            {
              name: "alpha",
              reason: "Alpha delegates the next step to beta.",
              direction: "related_to_current",
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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

    const workspaceOnly = await runTool(tools.get("skill_list"), {
      source: "workspace",
    });
    expect(
      workspaceOnly.skills.find(
        (skill: { name: string }) => skill.name === "target",
      ),
    ).toMatchObject({ related_skills: [] });

    const allSources = await runTool(tools.get("skill_list"), {});
    expect(
      allSources.skills.find(
        (skill: { name: string }) => skill.name === "target",
      ),
    ).toMatchObject({
      related_skills: [
        {
          name: "managed-source",
          reason: "Visible only without a source filter.",
          direction: "related_to_current",
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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

    const result = await runTool(tools.get("skill_list"), {
      source: "workspace",
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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

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
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

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
