import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSkillTools } from "./tools.js";
import type { OpenClawPluginApi } from "../../api.js";

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

function writeSkill(workspaceDir: string): void {
  const skillDir = path.join(workspaceDir, "skills", "writer");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: writer\ndescription: Write well.\n---\n\n# Writer\n",
  );
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
    registerSkillTools(api);
    const tools = new Map(
      api.registerTool.mock.calls.map(([tool]) => [tool.name, tool]),
    );

    await expect(
      runTool(tools.get("skill_list"), { category: "workspace" }),
    ).resolves.toMatchObject({
      success: true,
      count: 1,
      skills: [{ name: "writer", description: "Write well." }],
    });
    await expect(
      runTool(tools.get("skill_view"), { name: "writer" }),
    ).resolves.toMatchObject({
      success: true,
      name: "writer",
      content: expect.stringContaining("# Writer"),
    });
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
    });
  });
});
