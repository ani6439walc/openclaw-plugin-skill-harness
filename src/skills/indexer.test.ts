import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findAvailableSkill,
  listAvailableSkills,
  resolveAvailableSkills,
} from "./indexer.js";
import type { OpenClawPluginApi } from "../../api.js";

function writeSkillAt(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function createApi(stateDir: string, workspaceDir: string): OpenClawPluginApi {
  return {
    config: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentWorkspaceDir: () => workspaceDir },
    },
  } as unknown as OpenClawPluginApi;
}

describe("skill indexer", () => {
  it("lists nested skills across all roots using first-root precedence", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const homeDir = path.join(tmp, "home");
    const bundledSkillsDir = path.join(tmp, "bundled");
    const api = createApi(stateDir, workspaceDir);

    writeSkillAt(
      path.join(workspaceDir, "skills", "group", "shared"),
      "shared-skill",
      "Workspace wins.",
    );
    writeSkillAt(
      path.join(workspaceDir, ".agents", "skills", "project"),
      "project-skill",
      "Project agent skill.",
    );
    writeSkillAt(
      path.join(homeDir, ".agents", "skills", "personal"),
      "personal-skill",
      "Personal agent skill.",
    );
    writeSkillAt(
      path.join(stateDir, "skills", "managed"),
      "managed-skill",
      "Managed skill.",
    );
    writeSkillAt(
      path.join(bundledSkillsDir, "bundle"),
      "bundled-skill",
      "Bundled skill.",
    );
    writeSkillAt(
      path.join(stateDir, "plugin-skills", "plugin"),
      "plugin-skill",
      "Plugin skill.",
    );
    writeSkillAt(
      path.join(stateDir, "skills", "shared"),
      "shared-skill",
      "Lower precedence copy.",
    );

    const skills = await listAvailableSkills({
      api,
      agentId: "main",
      bundledSkillsDir,
      cacheTtlMs: 0,
      homeDir,
    });

    expect(skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["shared-skill", "workspace"],
      ["project-skill", "project-agent"],
      ["personal-skill", "personal-agent"],
      ["managed-skill", "managed"],
      ["bundled-skill", "bundled"],
      ["plugin-skill", "plugin"],
    ]);
    expect(skills.find((skill) => skill.name === "shared-skill")).toMatchObject(
      { description: "Workspace wins." },
    );
  });

  it("resolves intent-referenced skills and individual skills through shared roots", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir);
    writeSkillAt(
      path.join(workspaceDir, ".agents", "skills", "testing"),
      "testing-skill",
      "Testing skill.",
    );

    await expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        intentBody: "Use skill: testing-skill and skill: missing.",
        cacheTtlMs: 0,
      }),
    ).resolves.toEqual([
      {
        name: "testing-skill",
        location: path.join(
          workspaceDir,
          ".agents",
          "skills",
          "testing",
          "SKILL.md",
        ),
        description: "Testing skill.",
      },
    ]);

    await expect(
      findAvailableSkill({
        api,
        agentId: "main",
        name: "testing-skill",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ name: "testing-skill" });
  });
});
