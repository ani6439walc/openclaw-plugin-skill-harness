import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import matter from "gray-matter";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { AvailableSkill, IntentCatalogEntry } from "./types.js";

const SKILL_REF_RE = /\bskill:\s*([A-Za-z0-9_-]+)/gi;
const require = createRequire(import.meta.url);

export function extractReferencedSkillNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(SKILL_REF_RE)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function readSkillFile(filePath: string): AvailableSkill | undefined {
  if (!fs.existsSync(filePath)) return;
  try {
    const parsed = matter(fs.readFileSync(filePath, "utf-8"));
    const name =
      typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    if (!name) return;
    const description =
      typeof parsed.data.description === "string"
        ? parsed.data.description.trim()
        : "";
    return { name, location: filePath, description };
  } catch (err) {
    logger.warn("failed to read referenced skill metadata", {
      error: err,
      path: filePath,
    });
    return;
  }
}

function buildSkillIndex(root: string): Map<string, AvailableSkill> {
  const index = new Map<string, AvailableSkill>();

  function visit(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const skill = readSkillFile(path.join(dir, "SKILL.md"));
      const key = skill?.name.toLowerCase();
      if (skill && key && !index.has(key)) {
        index.set(key, skill);
      }
    }

    const childDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right));

    for (const childDir of childDirs) {
      visit(childDir);
    }
  }

  visit(root);
  return index;
}

export function resolveAvailableSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  intentBody: string;
  bundledSkillsDir?: string;
}): AvailableSkill[] {
  const names = extractReferencedSkillNames(params.intentBody);
  if (names.length === 0) return [];

  const stateDir = params.api.runtime.state.resolveStateDir(process.env);
  const workspaceDir = params.api.runtime.agent.resolveAgentWorkspaceDir(
    params.api.config,
    params.agentId,
    process.env,
  );
  const bundledSkillsDir =
    params.bundledSkillsDir ??
    path.join(path.dirname(require.resolve("openclaw")), "..", "skills");

  const roots = [
    path.join(workspaceDir, "skills"),
    path.join(stateDir, "skills"),
    path.join(stateDir, "plugin-skills"),
    bundledSkillsDir,
  ];

  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();
  const rootIndexes = new Map<string, Map<string, AvailableSkill>>();
  const getRootIndex = (root: string) => {
    let index = rootIndexes.get(root);
    if (!index) {
      index = buildSkillIndex(root);
      rootIndexes.set(root, index);
    }
    return index;
  };

  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;

    for (const root of roots) {
      const skill = getRootIndex(root).get(normalizedName);
      if (!skill) continue;
      skills.push(skill);
      seen.add(skill.name.toLowerCase());
      break;
    }
  }
  return skills;
}

export function resolveDomainSkills(params: {
  api: OpenClawPluginApi;
  agentId: string;
  domain: string | null | undefined;
  intents: readonly IntentCatalogEntry[];
  bundledSkillsDir?: string;
}): AvailableSkill[] {
  const domain = (params.domain ?? "").trim().toLowerCase();
  if (!domain) return [];

  const intentBody = params.intents
    .filter(
      (intent) => intent.definition.domain.trim().toLowerCase() === domain,
    )
    .map((intent) => intent.definition.prompt)
    .join("\n");

  if (!intentBody.trim()) return [];

  return resolveAvailableSkills({
    api: params.api,
    agentId: params.agentId,
    intentBody,
    bundledSkillsDir: params.bundledSkillsDir,
  });
}
