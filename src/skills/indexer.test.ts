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
import type { IntentCatalogEntry } from "../types.js";

function writeSkillAt(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeStats(
  stateDir: string,
  skills: Record<string, { usageTurns: number }>,
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

function createApi(
  stateDir: string,
  workspaceDir: string,
  config: unknown = {},
): OpenClawPluginApi {
  return {
    config,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentWorkspaceDir: () => workspaceDir },
    },
  } as unknown as OpenClawPluginApi;
}

describe("skill indexer", () => {
  it("refreshes the index using the configured skill watcher debounce", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir, {
      skills: { load: { watch: true, watchDebounceMs: 5_000 } },
    });
    const skillDir = path.join(workspaceDir, "skills", "cached");

    writeSkillAt(skillDir, "cached-skill", "Initial description.");
    const initialSkills = await listAvailableSkills({
      api,
      agentId: "main",
      nowMs: 0,
    });
    expect(
      initialSkills.find((skill) => skill.name === "cached-skill"),
    ).toMatchObject({
      description: "Initial description.",
    });

    writeSkillAt(skillDir, "cached-skill", "Updated description.");
    const cachedSkills = await listAvailableSkills({
      api,
      agentId: "main",
      nowMs: 4_999,
    });
    expect(
      cachedSkills.find((skill) => skill.name === "cached-skill"),
    ).toMatchObject({
      description: "Initial description.",
    });
    const refreshedSkills = await listAvailableSkills({
      api,
      agentId: "main",
      nowMs: 5_000,
    });
    expect(
      refreshedSkills.find((skill) => skill.name === "cached-skill"),
    ).toMatchObject({ description: "Updated description." });
  });

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
    writeSkillAt(
      path.join(workspaceDir, "skills", "alpha"),
      "alpha-skill",
      "Lower usage workspace skill.",
    );
    writeSkillAt(
      path.join(workspaceDir, "skills", "zeta"),
      "zeta-skill",
      "Higher usage workspace skill.",
    );
    writeSkillAt(
      path.join(bundledSkillsDir, "aaa-bundle"),
      "aaa-bundled-skill",
      "Alphabetically first bundled skill.",
    );
    writeSkillAt(
      path.join(bundledSkillsDir, "zzz-bundle"),
      "zzz-bundled-skill",
      "Alphabetically last bundled skill.",
    );
    writeStats(stateDir, {
      "zeta-skill": { usageTurns: 8 },
      "alpha-skill": { usageTurns: 2 },
      "aaa-bundled-skill": { usageTurns: 0 },
      "zzz-bundled-skill": { usageTurns: 0 },
    });
    const intents: IntentCatalogEntry[] = [
      {
        id: "workspace-skills",
        definition: {
          triggers: ["workspace"],
          examples: ["workspace"],
          domain: "workspace-domain",
          fastpath: { keywords: [] },
          prompt: "Use skill: shared-skill and skill: zeta-skill.",
        },
      },
    ];

    const skills = await listAvailableSkills({
      api,
      agentId: "main",
      bundledSkillsDir,
      cacheTtlMs: 0,
      homeDir,
      intents,
    });

    expect(skills.map((skill) => [skill.name, skill.source])).toEqual([
      ["zeta-skill", "workspace"],
      ["alpha-skill", "workspace"],
      ["shared-skill", "workspace"],
      ["project-skill", "project-agent"],
      ["personal-skill", "personal-agent"],
      ["managed-skill", "managed"],
      ["plugin-skill", "plugin"],
      ["aaa-bundled-skill", "bundled"],
      ["bundled-skill", "bundled"],
      ["zzz-bundled-skill", "bundled"],
    ]);
    expect(skills.find((skill) => skill.name === "shared-skill")).toMatchObject(
      { description: "Workspace wins.", domains: ["workspace-domain"] },
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
