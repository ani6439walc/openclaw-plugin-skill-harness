import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSkillRoots } from "./roots.js";
import type { OpenClawPluginApi } from "../../api.js";

function createApi(params: {
  stateDir: string;
  workspaceDir: string;
  extraDirs?: string[];
}): OpenClawPluginApi {
  return {
    config: {
      skills: { load: { extraDirs: params.extraDirs ?? [] } },
    },
    runtime: {
      state: { resolveStateDir: () => params.stateDir },
      agent: { resolveAgentWorkspaceDir: () => params.workspaceDir },
    },
  } as unknown as OpenClawPluginApi;
}

describe("resolveSkillRoots", () => {
  it("orders documented OpenClaw skill roots by precedence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const homeDir = path.join(tmp, "home");
    const bundledSkillsDir = path.join(tmp, "bundled");
    const extraDir = path.join(tmp, "extra");
    const api = createApi({ stateDir, workspaceDir, extraDirs: [extraDir] });

    expect(
      resolveSkillRoots({ api, agentId: "main", bundledSkillsDir, homeDir }),
    ).toEqual([
      {
        path: path.join(workspaceDir, "skills"),
        source: "workspace",
        precedence: 0,
      },
      {
        path: path.join(workspaceDir, ".agents", "skills"),
        source: "project-agent",
        precedence: 1,
      },
      {
        path: path.join(homeDir, ".agents", "skills"),
        source: "personal-agent",
        precedence: 2,
      },
      {
        path: path.join(stateDir, "skills"),
        source: "managed",
        precedence: 3,
      },
      { path: bundledSkillsDir, source: "bundled", precedence: 4 },
      { path: extraDir, source: "extra", precedence: 5 },
      {
        path: path.join(stateDir, "plugin-skills"),
        source: "plugin",
        precedence: 6,
      },
    ]);
  });

  it("expands tilde extra dirs and deduplicates roots while preserving first precedence", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const homeDir = path.join(tmp, "home");
    const api = createApi({
      stateDir,
      workspaceDir,
      extraDirs: ["~/shared-skills", path.join(workspaceDir, "skills")],
    });

    const roots = resolveSkillRoots({ api, agentId: "main", homeDir });

    expect(roots.map((root) => root.path)).toContain(
      path.join(homeDir, "shared-skills"),
    );
    expect(
      roots.filter((root) => root.path === path.join(workspaceDir, "skills")),
    ).toHaveLength(1);
    expect(roots[0]).toMatchObject({ source: "workspace" });
  });
});
