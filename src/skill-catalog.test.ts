import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
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
});
