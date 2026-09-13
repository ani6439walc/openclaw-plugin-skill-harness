import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveOpenClawBundledSkillsDir,
  resolveSkillIndexCacheTtlMs,
  resolveSkillRoots,
} from "./roots.js";
import type { OpenClawPluginApi } from "../../api.js";

function createApi(params: {
  stateDir: string;
  workspaceDir: string;
}): OpenClawPluginApi {
  return {
    config: {},
    runtime: {
      state: { resolveStateDir: () => params.stateDir },
      agent: { resolveAgentWorkspaceDir: () => params.workspaceDir },
    },
  } as unknown as OpenClawPluginApi;
}

function writeSkillRoot(root: string): void {
  fs.mkdirSync(path.join(root, "skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "skill", "SKILL.md"), "# skill\n");
}

describe("resolveSkillRoots", () => {
  it("uses the OpenClaw skill watcher debounce as the index cache TTL", () => {
    expect(
      resolveSkillIndexCacheTtlMs({
        skills: { load: { watch: true, watchDebounceMs: 5_000 } },
      }),
    ).toBe(5_000);
    expect(
      resolveSkillIndexCacheTtlMs({
        skills: { load: { watch: false, watchDebounceMs: 5_000 } },
      }),
    ).toBe(60_000);
    expect(
      resolveSkillIndexCacheTtlMs({ skills: { load: { watch: true } } }),
    ).toBe(60_000);
  });

  it("keeps generated plugin links first and OpenClaw bundled skills ahead of the package fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const homeDir = path.join(tmp, "home");
    const nativeBundledSkillsDir = path.join(tmp, "native");
    const bundledSkillsDir = path.join(tmp, "bundled");
    const sharedRoot = path.join(tmp, "shared");
    const api = createApi({ stateDir, workspaceDir });

    expect(
      resolveSkillRoots({
        api,
        agentId: "main",
        nativeBundledSkillsDir,
        bundledSkillsDir,
        sharedRoots: [sharedRoot],
        homeDir,
      }),
    ).toEqual([
      {
        path: path.join(stateDir, "agents", "main", "agent", "workshop-skills"),
        source: "workshop",
        precedence: 0,
      },
      {
        path: path.join(workspaceDir, "skills"),
        source: "workspace",
        precedence: 1,
      },
      {
        path: path.join(workspaceDir, ".agents", "skills"),
        source: "project-agent",
        precedence: 2,
      },
      {
        path: path.join(homeDir, ".agents", "skills"),
        source: "personal-agent",
        precedence: 3,
      },
      { path: path.join(stateDir, "skills"), source: "managed", precedence: 4 },
      { path: sharedRoot, source: "shared", precedence: 5 },
      {
        path: path.join(stateDir, "plugin-skills"),
        source: "plugin",
        precedence: 6,
      },
      { path: nativeBundledSkillsDir, source: "bundled", precedence: 7 },
      { path: bundledSkillsDir, source: "plugin", precedence: 8 },
    ]);
  });

  it("keeps an explicit OpenClaw bundled root when the plugin fallback is disabled", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const nativeBundledSkillsDir = path.join(tmp, "native");
    const api = createApi({ stateDir, workspaceDir });

    expect(
      resolveSkillRoots({
        api,
        agentId: "main",
        nativeBundledSkillsDir,
        bundledSkillsDir: "",
        homeDir: path.join(tmp, "home"),
      }),
    ).toContainEqual({
      path: nativeBundledSkillsDir,
      source: "bundled",
      precedence: 6,
    });
  });

  it("deduplicates shared roots without reading core extraDirs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-roots-"));
    const workspaceDir = path.join(tmp, "workspace");
    const stateDir = path.join(tmp, "state");
    const api = createApi({ stateDir, workspaceDir });
    const roots = resolveSkillRoots({
      api,
      agentId: "main",
      nativeBundledSkillsDir: "",
      bundledSkillsDir: "",
      sharedRoots: [
        path.join(workspaceDir, "skills"),
        path.join(tmp, "shared"),
        path.join(tmp, "shared"),
      ],
      homeDir: path.join(tmp, "home"),
    });
    expect(
      roots.filter((root) => root.path === path.join(workspaceDir, "skills")),
    ).toHaveLength(1);
    expect(roots[5]).toMatchObject({
      path: path.join(tmp, "shared"),
      source: "shared",
    });
  });
});

describe("resolveOpenClawBundledSkillsDir", () => {
  it("prefers OPENCLAW_BUNDLED_SKILLS_DIR", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-skills-"));
    writeSkillRoot(root);
    expect(
      resolveOpenClawBundledSkillsDir({
        env: { OPENCLAW_BUNDLED_SKILLS_DIR: root },
      }),
    ).toBe(root);
  });

  it("finds a gateway source checkout from argv1", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
    writeSkillRoot(path.join(root, "skills"));
    expect(
      resolveOpenClawBundledSkillsDir({
        argv1: path.join(root, "openclaw.mjs"),
        env: {},
      }),
    ).toBe(path.join(root, "skills"));
  });
});
