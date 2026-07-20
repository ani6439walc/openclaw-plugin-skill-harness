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

function normalizePath(input: string, homeDir: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  const expanded =
    trimmed === "~" || trimmed.startsWith(`~${path.sep}`)
      ? path.join(homeDir, trimmed.slice(2))
      : trimmed;
  return path.resolve(expanded);
}

function readExtraSkillDirs(config: unknown): string[] {
  const extraDirs = readSkillLoadConfig(config)?.extraDirs;
  if (!Array.isArray(extraDirs)) return [];
  return extraDirs.filter(
    (entry): entry is string => typeof entry === "string",
  );
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

function defaultBundledSkillsDir(): string | undefined {
  try {
    return path.join(path.dirname(require.resolve("openclaw")), "..", "skills");
  } catch {
    return;
  }
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
  homeDir?: string;
}): SkillRoot[] {
  const homeDir = params.homeDir ?? os.homedir();
  const stateDir = resolveStateDirFromApi(params.api, process.env);
  const workspaceDir = params.api.runtime.agent.resolveAgentWorkspaceDir(
    params.api.config,
    params.agentId,
    process.env,
  );
  const bundledSkillsDir =
    params.bundledSkillsDir === ""
      ? undefined
      : (params.bundledSkillsDir ?? defaultBundledSkillsDir());
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();

  pushRoot(
    roots,
    seen,
    normalizePath(path.join(workspaceDir, "skills"), homeDir),
    "workspace",
  );
  pushRoot(
    roots,
    seen,
    normalizePath(path.join(workspaceDir, ".agents", "skills"), homeDir),
    "project-agent",
  );
  pushRoot(
    roots,
    seen,
    normalizePath(path.join(homeDir, ".agents", "skills"), homeDir),
    "personal-agent",
  );
  pushRoot(
    roots,
    seen,
    normalizePath(path.join(stateDir, "skills"), homeDir),
    "managed",
  );
  pushRoot(
    roots,
    seen,
    normalizePath(path.join(stateDir, "plugin-skills"), homeDir),
    "plugin",
  );
  pushRoot(
    roots,
    seen,
    bundledSkillsDir ? normalizePath(bundledSkillsDir, homeDir) : undefined,
    "bundled",
  );

  for (const extraDir of readExtraSkillDirs(params.api.config)) {
    pushRoot(roots, seen, normalizePath(extraDir, homeDir), "extra");
  }

  return roots;
}
