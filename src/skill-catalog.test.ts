import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  extractReferencedSkillNames,
  resolveAvailableSkills,
  resolveDomainSkills,
} from "./skill-catalog.js";
import type { OpenClawPluginApi } from "../api.js";

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeSkillAt(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe("skill catalog", () => {
  it("extracts unique skill references from intent markdown", () => {
    expect(
      extractReferencedSkillNames(
        "Use skill: architecture-diagram and skill: test-driven-development. Again skill: architecture-diagram.",
      ),
    ).toEqual(["architecture-diagram", "test-driven-development"]);
  });

  it("loads referenced skills from workspace, personal, plugin, and bundled roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");

    writeSkill(
      path.join(workspace, "skills"),
      "agent-orchestration",
      "Workspace orchestration.",
    );
    writeSkill(path.join(state, "skills"), "analysis", "Personal analysis.");
    writeSkill(
      path.join(state, "plugin-skills"),
      "prompt-engineering",
      "Plugin prompt engineering.",
    );
    writeSkill(bundled, "blogwatcher", "Bundled blog watcher.");
    writeSkill(
      path.join(state, "skills"),
      "agent-orchestration",
      "Shadowed personal copy.",
    );

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        intentBody:
          "skill: agent-orchestration\nskill: analysis\nskill: prompt-engineering\nskill: blogwatcher\nskill: missing",
      }),
    ).toEqual([
      {
        name: "agent-orchestration",
        location: path.join(
          workspace,
          "skills",
          "agent-orchestration",
          "SKILL.md",
        ),
        description: "Workspace orchestration.",
      },
      {
        name: "analysis",
        location: path.join(state, "skills", "analysis", "SKILL.md"),
        description: "Personal analysis.",
      },
      {
        name: "prompt-engineering",
        location: path.join(
          state,
          "plugin-skills",
          "prompt-engineering",
          "SKILL.md",
        ),
        description: "Plugin prompt engineering.",
      },
      {
        name: "blogwatcher",
        location: path.join(bundled, "blogwatcher", "SKILL.md"),
        description: "Bundled blog watcher.",
      },
    ]);
  });

  it("loads referenced skills from nested directories in every root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");

    writeSkillAt(
      path.join(workspace, "skills", "coding", "workflow-pack"),
      "deep-workspace",
      "Nested workspace skill.",
    );
    writeSkillAt(
      path.join(state, "skills", "personal", "analysis-pack"),
      "deep-state",
      "Nested state skill.",
    );
    writeSkillAt(
      path.join(state, "plugin-skills", "plugin", "prompt-pack"),
      "deep-plugin",
      "Nested plugin skill.",
    );
    writeSkillAt(
      path.join(bundled, "research", "watcher-pack"),
      "deep-bundled",
      "Nested bundled skill.",
    );

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        intentBody:
          "skill: deep-workspace\nskill: deep-state\nskill: deep-plugin\nskill: deep-bundled",
      }),
    ).toEqual([
      {
        name: "deep-workspace",
        location: path.join(
          workspace,
          "skills",
          "coding",
          "workflow-pack",
          "SKILL.md",
        ),
        description: "Nested workspace skill.",
      },
      {
        name: "deep-state",
        location: path.join(
          state,
          "skills",
          "personal",
          "analysis-pack",
          "SKILL.md",
        ),
        description: "Nested state skill.",
      },
      {
        name: "deep-plugin",
        location: path.join(
          state,
          "plugin-skills",
          "plugin",
          "prompt-pack",
          "SKILL.md",
        ),
        description: "Nested plugin skill.",
      },
      {
        name: "deep-bundled",
        location: path.join(bundled, "research", "watcher-pack", "SKILL.md"),
        description: "Nested bundled skill.",
      },
    ]);
  });

  it("indexes symlinked skill directories and SKILL.md files without following cycles", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");
    const workspaceSkills = path.join(workspace, "skills");

    writeSkillAt(
      path.join(tmp, "shared", "directory-skill"),
      "symlink-dir-skill",
      "Symlinked directory skill.",
    );
    const linkedDir = path.join(workspaceSkills, "links", "directory-skill");
    fs.mkdirSync(path.dirname(linkedDir), { recursive: true });
    fs.symlinkSync(
      path.join(tmp, "shared", "directory-skill"),
      linkedDir,
      "dir",
    );

    writeSkillAt(
      path.join(workspaceSkills, "file-link-skill"),
      "symlink-file-skill",
      "Symlinked file skill.",
    );
    const linkedSkillFile = path.join(
      workspaceSkills,
      "linked-file",
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(linkedSkillFile), { recursive: true });
    fs.renameSync(
      path.join(workspaceSkills, "file-link-skill", "SKILL.md"),
      path.join(tmp, "linked-SKILL.md"),
    );
    fs.symlinkSync(path.join(tmp, "linked-SKILL.md"), linkedSkillFile, "file");

    fs.mkdirSync(path.join(workspaceSkills, "cycle"), { recursive: true });
    fs.symlinkSync(
      workspaceSkills,
      path.join(workspaceSkills, "cycle", "back"),
      "dir",
    );

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        intentBody: "skill: symlink-dir-skill\nskill: symlink-file-skill",
      }),
    ).toEqual([
      {
        name: "symlink-dir-skill",
        location: path.join(linkedDir, "SKILL.md"),
        description: "Symlinked directory skill.",
      },
      {
        name: "symlink-file-skill",
        location: linkedSkillFile,
        description: "Symlinked file skill.",
      },
    ]);
  });

  it("uses cached root indexes across resolution calls within the TTL", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");

    fs.mkdirSync(path.join(workspace, "skills", "group-a", "nested"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(state, "skills", "group-b", "nested"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(state, "plugin-skills", "group-c", "nested"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(bundled, "group-d", "nested"), {
      recursive: true,
    });

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    try {
      expect(
        resolveAvailableSkills({
          api,
          agentId: "main",
          bundledSkillsDir: bundled,
          nowMs: 1_000,
          intentBody:
            "skill: missing-one\nskill: missing-two\nskill: missing-three",
        }),
      ).toEqual([]);

      expect(
        resolveAvailableSkills({
          api,
          agentId: "main",
          bundledSkillsDir: bundled,
          nowMs: 1_001,
          intentBody: "skill: missing-four\nskill: missing-five",
        }),
      ).toEqual([]);

      const calls = readdirSpy.mock.calls.map(([target]) => String(target));
      for (const dir of [
        path.join(workspace, "skills"),
        path.join(workspace, "skills", "group-a"),
        path.join(workspace, "skills", "group-a", "nested"),
        path.join(state, "skills"),
        path.join(state, "skills", "group-b"),
        path.join(state, "skills", "group-b", "nested"),
        path.join(state, "plugin-skills"),
        path.join(state, "plugin-skills", "group-c"),
        path.join(state, "plugin-skills", "group-c", "nested"),
        bundled,
        path.join(bundled, "group-d"),
        path.join(bundled, "group-d", "nested"),
      ]) {
        expect(calls.filter((call) => call === dir)).toHaveLength(1);
      }
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("refreshes cached root indexes after the TTL expires", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");
    fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        cacheTtlMs: 10,
        nowMs: 1_000,
        intentBody: "skill: late-skill",
      }),
    ).toEqual([]);

    writeSkill(path.join(workspace, "skills"), "late-skill", "Appears later.");

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        cacheTtlMs: 10,
        nowMs: 1_005,
        intentBody: "skill: late-skill",
      }),
    ).toEqual([]);

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        cacheTtlMs: 10,
        nowMs: 1_011,
        intentBody: "skill: late-skill",
      }),
    ).toEqual([
      {
        name: "late-skill",
        location: path.join(workspace, "skills", "late-skill", "SKILL.md"),
        description: "Appears later.",
      },
    ]);
  });

  it("ignores blank optional skill roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    writeSkill(
      path.join(workspace, "skills"),
      "workspace-only",
      "Workspace skill.",
    );

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveAvailableSkills({
        api,
        agentId: "main",
        bundledSkillsDir: "",
        intentBody: "skill: workspace-only\nskill: missing",
      }),
    ).toEqual([
      {
        name: "workspace-only",
        location: path.join(workspace, "skills", "workspace-only", "SKILL.md"),
        description: "Workspace skill.",
      },
    ]);
  });

  it("loads skills referenced by every intent in the requested domain", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");

    writeSkill(
      path.join(workspace, "skills"),
      "architecture-diagram",
      "Draw architecture diagrams.",
    );
    writeSkill(
      path.join(state, "plugin-skills"),
      "test-driven-development",
      "Drive changes with tests.",
    );
    writeSkill(bundled, "blogwatcher", "Watch blogs.");

    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;

    expect(
      resolveDomainSkills({
        api,
        agentId: "main",
        bundledSkillsDir: bundled,
        domain: "coding",
        intents: [
          {
            id: "diagram",
            definition: {
              triggers: ["diagram"],
              examples: [],
              domain: "coding",
              fastpath: { keywords: [] },
              prompt: "Use skill: architecture-diagram.",
            },
          },
          {
            id: "testing",
            definition: {
              triggers: ["test"],
              examples: [],
              domain: "coding",
              fastpath: { keywords: [] },
              prompt: "Use skill: test-driven-development.",
            },
          },
          {
            id: "research",
            definition: {
              triggers: ["research"],
              examples: [],
              domain: "research",
              fastpath: { keywords: [] },
              prompt: "Use skill: blogwatcher.",
            },
          },
        ],
      }),
    ).toEqual([
      {
        name: "architecture-diagram",
        location: path.join(
          workspace,
          "skills",
          "architecture-diagram",
          "SKILL.md",
        ),
        description: "Draw architecture diagrams.",
      },
      {
        name: "test-driven-development",
        location: path.join(
          state,
          "plugin-skills",
          "test-driven-development",
          "SKILL.md",
        ),
        description: "Drive changes with tests.",
      },
    ]);
  });

  it("returns no domain skills for blank or absent domains", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ih-skills-"));
    const workspace = path.join(tmp, "workspace");
    const state = path.join(tmp, "state");
    const bundled = path.join(tmp, "bundled");
    const api = {
      config: {},
      runtime: {
        state: { resolveStateDir: () => state },
        agent: { resolveAgentWorkspaceDir: () => workspace },
      },
    } as unknown as OpenClawPluginApi;
    const params = {
      api,
      agentId: "main",
      bundledSkillsDir: bundled,
      intents: [
        {
          id: "diagram",
          definition: {
            triggers: ["diagram"],
            examples: [],
            domain: "coding",
            fastpath: { keywords: [] },
            prompt: "Use skill: architecture-diagram.",
          },
        },
      ],
    };

    expect(resolveDomainSkills({ ...params, domain: "" })).toEqual([]);
    expect(resolveDomainSkills({ ...params, domain: undefined })).toEqual([]);
    expect(resolveDomainSkills({ ...params, domain: null })).toEqual([]);
  });
});
