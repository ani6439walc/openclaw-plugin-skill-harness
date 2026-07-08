import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAvailableSkill } from "./files.js";
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

function writeSkill(root: string): void {
  const skillDir = path.join(root, "skills", "writer");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "templates"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "private"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: writer\ndescription: Write well.\n---\n\n# Writer\n",
  );
  fs.writeFileSync(
    path.join(skillDir, "references", "style.md"),
    "Style guide",
  );
  fs.writeFileSync(path.join(skillDir, "templates", "note.md"), "Template");
  fs.writeFileSync(path.join(skillDir, "private", "secret.md"), "Secret");
}

describe("readAvailableSkill", () => {
  it("reads main skill content and linked support files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-files-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    writeSkill(workspaceDir);

    const result = await readAvailableSkill({
      api: createApi(stateDir, workspaceDir),
      agentId: "main",
      name: "writer",
      cacheTtlMs: 0,
    });

    expect(result).toMatchObject({
      success: true,
      name: "writer",
      description: "Write well.",
      linked_files: {
        references: ["references/style.md"],
        templates: ["templates/note.md"],
      },
    });
    expect(result.success ? result.content : "").toContain("# Writer");
  });

  it("reads allowed support files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-files-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    writeSkill(workspaceDir);

    await expect(
      readAvailableSkill({
        api: createApi(stateDir, workspaceDir),
        agentId: "main",
        name: "writer",
        filePath: "references/style.md",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({
      success: true,
      name: "writer",
      file: "references/style.md",
      content: "Style guide",
      file_type: ".md",
    });
  });

  it("rejects unknown skills and unsafe support paths", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-files-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir);
    writeSkill(workspaceDir);

    await expect(
      readAvailableSkill({
        api,
        agentId: "main",
        name: "missing",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      readAvailableSkill({
        api,
        agentId: "main",
        name: "writer",
        filePath: "../secret.md",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      readAvailableSkill({
        api,
        agentId: "main",
        name: "writer",
        filePath: "/etc/passwd",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      readAvailableSkill({
        api,
        agentId: "main",
        name: "writer",
        filePath: "private/secret.md",
        cacheTtlMs: 0,
      }),
    ).resolves.toMatchObject({ success: false });
  });
});
