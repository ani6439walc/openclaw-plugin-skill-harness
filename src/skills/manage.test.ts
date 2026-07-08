import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAvailableSkill } from "./indexer.js";
import { manageSkill } from "./manage.js";
import type { OpenClawPluginApi } from "../../api.js";

function createApi(stateDir: string, workspaceDir: string): OpenClawPluginApi {
  return {
    config: {},
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentWorkspaceDir: () => workspaceDir },
    },
  } as unknown as OpenClawPluginApi;
}

function skillContent(
  name = "drafting",
  description = "Draft reusable workflows.",
) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill carefully.\n`;
}

describe("manageSkill", () => {
  let tmp: string;
  let stateDir: string;
  let workspaceDir: string;
  let api: OpenClawPluginApi;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manage-"));
    stateDir = path.join(tmp, "state");
    workspaceDir = path.join(tmp, "workspace");
    api = createApi(stateDir, workspaceDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates, edits, patches, writes, removes, and deletes managed skills", async () => {
    const created = await manageSkill({
      api,
      agentId: "main",
      action: "create",
      name: "drafting",
      content: skillContent(),
      cacheTtlMs: 0,
    });

    expect(created).toMatchObject({
      success: true,
      message: "Skill 'drafting' created.",
    });
    const skillPath = path.join(stateDir, "skills", "drafting", "SKILL.md");
    expect(fs.readFileSync(skillPath, "utf-8")).toContain("# drafting");
    await expect(
      findAvailableSkill({
        api,
        agentId: "main",
        name: "drafting",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({
      name: "drafting",
      source: "managed",
      location: skillPath,
    });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "write_file",
        name: "drafting",
        filePath: "references/guide.md",
        fileContent: "# Guide\n\nOld wording.\n",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "patch",
        name: "drafting",
        filePath: "references/guide.md",
        oldString: "Old wording.",
        newString: "New wording.",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true, replacements: 1 });
    expect(
      fs.readFileSync(
        path.join(stateDir, "skills", "drafting", "references", "guide.md"),
        "utf-8",
      ),
    ).toContain("New wording.");

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "edit",
        name: "drafting",
        content: skillContent("drafting", "Updated description."),
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(fs.readFileSync(skillPath, "utf-8")).toContain(
      "description: Updated description.",
    );

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "remove_file",
        name: "drafting",
        filePath: "references/guide.md",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(
      fs.existsSync(
        path.join(stateDir, "skills", "drafting", "references", "guide.md"),
      ),
    ).toBe(false);

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "delete",
        name: "drafting",
        absorbedInto: "",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(fs.existsSync(path.dirname(skillPath))).toBe(false);
  });

  it("rejects invalid names, invalid SKILL.md content, and unsafe support paths", async () => {
    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "create",
        name: "BadName",
        content: skillContent("BadName"),
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid skill name"),
    });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "create",
        name: "missing-frontmatter",
        content: "# Missing frontmatter\n",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("YAML frontmatter"),
    });

    await manageSkill({
      api,
      agentId: "main",
      action: "create",
      name: "safe-skill",
      content: skillContent("safe-skill"),
      cacheTtlMs: 0,
    });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "write_file",
        name: "safe-skill",
        filePath: "../secret.md",
        fileContent: "nope",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("traversal"),
    });
    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "write_file",
        name: "safe-skill",
        filePath: "notes.md",
        fileContent: "nope",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("under one of"),
    });
  });

  it("requires unique patch matches unless replaceAll is true", async () => {
    await manageSkill({
      api,
      agentId: "main",
      action: "create",
      name: "patchy",
      content: skillContent("patchy") + "Repeat\nRepeat\n",
      cacheTtlMs: 0,
    });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "patch",
        name: "patchy",
        oldString: "Repeat",
        newString: "Changed",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("multiple matches"),
    });

    await expect(
      manageSkill({
        api,
        agentId: "main",
        action: "patch",
        name: "patchy",
        oldString: "Repeat",
        newString: "Changed",
        replaceAll: true,
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: true, replacements: 2 });
  });
});
