import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveStateDirFromApi } from "../file-utils.js";
import type { SkillRoot, SkillSource } from "./types.js";

const require = createRequire(import.meta.url);
export const DEFAULT_SKILL_INDEX_CACHE_TTL_MS = 60_000;

function readSkillLoadConfig(
  config: unknown,
): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object") return;
  const skills = (config as { skills?: unknown }).skills;
  if (!skills || typeof skills !== "object") return;
  const load = (skills as { load?: unknown }).load;
  if (!load || typeof load !== "object" || Array.isArray(load)) return;
  return load as Record<string, unknown>;
}

function isSkillsDirectory(directory: string): boolean {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .some(
        (entry) =>
          (!entry.name.startsWith(".") &&
            entry.isFile() &&
            entry.name.endsWith(".md")) ||
          (!entry.name.startsWith(".") &&
            entry.isDirectory() &&
            fs.existsSync(path.join(directory, entry.name, "SKILL.md"))),
      );
  } catch {
    return false;
  }
}

function findOpenClawPackageRoot(
  startPath: string | undefined,
): string | undefined {
  if (!startPath) return;
  let directory: string;
  try {
    directory = path.dirname(fs.realpathSync(startPath));
  } catch {
    directory = path.dirname(path.resolve(startPath));
  }
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (packageJson.name === "openclaw") return directory;
    } catch {
      // Keep searching ancestors.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export function resolveOpenClawBundledSkillsDir(
  params: {
    argv1?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  const env = params.env ?? process.env;
  const override = env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override) return override;

  const packageRoot = findOpenClawPackageRoot(params.argv1 ?? process.argv[1]);
  const gatewaySkillsDir = packageRoot
    ? path.join(packageRoot, "skills")
    : undefined;
  if (gatewaySkillsDir && isSkillsDirectory(gatewaySkillsDir)) {
    return gatewaySkillsDir;
  }

  try {
    const packageSkillsDir = path.join(
      path.dirname(require.resolve("openclaw")),
      "..",
      "skills",
    );
    return isSkillsDirectory(packageSkillsDir) ? packageSkillsDir : undefined;
  } catch {
    return;
  }
}

export function resolveSkillIndexCacheTtlMs(config: unknown): number {
  const load = readSkillLoadConfig(config);
  if (load?.watch !== true) return DEFAULT_SKILL_INDEX_CACHE_TTL_MS;
  const debounceMs = load.watchDebounceMs;
  if (
    typeof debounceMs !== "number" ||
    !Number.isFinite(debounceMs) ||
    debounceMs < 0
  ) {
    return DEFAULT_SKILL_INDEX_CACHE_TTL_MS;
  }
  return Math.floor(debounceMs);
}

function pushRoot(
  roots: SkillRoot[],
  seen: Set<string>,
  rootPath: string | undefined,
  source: SkillSource,
): void {
  if (!rootPath) return;
  const normalized = path.resolve(rootPath);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  roots.push({ path: normalized, source, precedence: roots.length });
}

export function resolveSkillRoots(params: {
  api: OpenClawPluginApi;
  agentId: string;
  bundledSkillsDir?: string;
  nativeBundledSkillsDir?: string;
  sharedRoots?: readonly string[];
  homeDir?: string;
}): SkillRoot[] {
  const homeDir = params.homeDir ?? os.homedir();
  const stateDir = resolveStateDirFromApi(params.api, process.env);
  const workspaceDir = params.api.runtime.agent.resolveAgentWorkspaceDir(
    params.api.config,
    params.agentId,
    process.env,
  );
  const nativeBundledSkillsDir =
    params.nativeBundledSkillsDir === ""
      ? undefined
      : (params.nativeBundledSkillsDir ?? resolveOpenClawBundledSkillsDir());
  const bundledSkillsDir =
    params.bundledSkillsDir === "" ? undefined : params.bundledSkillsDir;
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();

  if (params.agentId) {
    pushRoot(
      roots,
      seen,
      path.join(stateDir, "agents", params.agentId, "agent", "workshop-skills"),
      "workshop",
    );
  }
  pushRoot(roots, seen, path.join(workspaceDir, "skills"), "workspace");
  pushRoot(
    roots,
    seen,
    path.join(workspaceDir, ".agents", "skills"),
    "project-agent",
  );
  pushRoot(
    roots,
    seen,
    path.join(homeDir, ".agents", "skills"),
    "personal-agent",
  );
  pushRoot(roots, seen, path.join(stateDir, "skills"), "managed");
  for (const sharedRoot of params.sharedRoots ?? []) {
    pushRoot(roots, seen, sharedRoot, "shared");
  }
  pushRoot(roots, seen, path.join(stateDir, "plugin-skills"), "plugin");
  pushRoot(roots, seen, nativeBundledSkillsDir, "bundled");
  pushRoot(roots, seen, bundledSkillsDir, "plugin");

  return roots;
}
