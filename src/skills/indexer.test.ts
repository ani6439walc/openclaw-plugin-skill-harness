import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../api.js";
import {
  findAvailableSkill,
  listAvailableSkills,
  resetDuplicateSkillWarningCache,
  resolveAvailableSkills,
  resolveSkillInventory,
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
  it("fingerprints raw skill bytes before UTF-8 decoding", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "raw-bytes");
    const skillPath = path.join(skillDir, "SKILL.md");
    const prefix = Buffer.from(
      "---\nname: raw-bytes\ndescription: Raw bytes.\n---\n\n# Raw bytes\n",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, Buffer.concat([prefix, Buffer.from([0x80])]));

    const first = await resolveSkillInventory({
      api,
      agentId: "main",
      cacheTtlMs: 0,
    });
    fs.writeFileSync(skillPath, Buffer.concat([prefix, Buffer.from([0x81])]));
    const second = await resolveSkillInventory({
      api,
      agentId: "main",
      cacheTtlMs: 0,
    });

    expect(
      first?.find((skill) => skill.name === "raw-bytes")?.fingerprint,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      second?.find((skill) => skill.name === "raw-bytes")?.fingerprint,
    ).not.toBe(first?.find((skill) => skill.name === "raw-bytes")?.fingerprint);
  });

  it("fingerprints the resolved precedence winner independently of content", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const firstRoot = path.join(tmp, "first");
    const secondRoot = path.join(tmp, "second");
    writeSkillAt(path.join(firstRoot, "shared"), "shared", "Same content.");
    writeSkillAt(path.join(secondRoot, "shared"), "shared", "Same content.");

    const first = await resolveSkillInventory({
      api: createApi(stateDir, workspaceDir, {
        skills: { load: { extraDirs: [firstRoot, secondRoot] } },
      }),
      agentId: "main",
      bundledSkillsDir: "",
      cacheTtlMs: 0,
      homeDir: path.join(tmp, "home"),
    });
    const second = await resolveSkillInventory({
      api: createApi(stateDir, workspaceDir, {
        skills: { load: { extraDirs: [secondRoot, firstRoot] } },
      }),
      agentId: "main",
      bundledSkillsDir: "",
      cacheTtlMs: 0,
      homeDir: path.join(tmp, "home"),
    });

    const firstShared = first?.find((skill) => skill.name === "shared");
    const secondShared = second?.find((skill) => skill.name === "shared");
    expect(firstShared?.source).toBe("extra");
    expect(firstShared?.fingerprint).toBe(secondShared?.fingerprint);
    expect(firstShared?.winnerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(secondShared?.winnerFingerprint).not.toBe(
      firstShared?.winnerFingerprint,
    );
  });

  it("does not resolve an inventory when bundled skill policy is unreadable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    writeSkillAt(
      path.join(workspaceDir, "skills", "visible"),
      "visible",
      "Visible skill.",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{ invalid json");

    await expect(
      resolveSkillInventory({
        api: createApi(stateDir, workspaceDir),
        agentId: "main",
        bundledSkillsDir: "",
        cacheTtlMs: 0,
        homeDir: path.join(tmp, "home"),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not resolve an inventory when a bundled skill policy entry is malformed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    writeSkillAt(
      path.join(workspaceDir, "skills", "visible"),
      "visible",
      "Visible skill.",
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        skills: { entries: { visible: { enabled: "false" } } },
      }),
    );

    await expect(
      resolveSkillInventory({
        api: createApi(stateDir, workspaceDir),
        agentId: "main",
        bundledSkillsDir: "",
        cacheTtlMs: 0,
        homeDir: path.join(tmp, "home"),
      }),
    ).resolves.toBeUndefined();
  });

  it("does not resolve an inventory when skill traversal is incomplete", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const skillsDir = path.join(workspaceDir, "skills");
    writeSkillAt(path.join(skillsDir, "visible"), "visible", "Visible skill.");
    fs.symlinkSync("loop", path.join(skillsDir, "loop"));

    await expect(
      resolveSkillInventory({
        api: createApi(stateDir, workspaceDir),
        agentId: "main",
        bundledSkillsDir: "",
        cacheTtlMs: 0,
        homeDir: path.join(tmp, "home"),
      }),
    ).resolves.toBeUndefined();
  });

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
          skills: ["shared-skill", "zeta-skill"],
          keywords: [],
          guidance: "Use the workspace skill workflow.",
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
        skillNames: ["testing-skill", "missing"],
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

  it("deduplicates duplicate skill name warning logs across repeated index runs", async () => {
    resetDuplicateSkillWarningCache();
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi(stateDir, workspaceDir);
    writeSkillAt(
      path.join(workspaceDir, "skills", "first-dup"),
      "dup-skill",
      "First duplicate",
    );
    writeSkillAt(
      path.join(workspaceDir, "skills", "second-dup"),
      "dup-skill",
      "Second duplicate",
    );

    await resolveSkillInventory({ api, agentId: "main", cacheTtlMs: 0 });
    await resolveSkillInventory({ api, agentId: "main", cacheTtlMs: 0 });

    const duplicateWarnings = warnSpy.mock.calls.filter(
      ([msg]) => msg === "duplicate skill name ignored while indexing skills",
    );
    expect(duplicateWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
