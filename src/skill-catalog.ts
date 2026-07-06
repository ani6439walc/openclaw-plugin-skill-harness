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

function findSkillInRoot(
  root: string,
  skillName: string,
): AvailableSkill | undefined {
  const expectedName = skillName.toLowerCase();

  function visit(dir: string): AvailableSkill | undefined {
    const skill = readSkillFile(path.join(dir, "SKILL.md"));
    if (skill?.name.toLowerCase() === expectedName) return skill;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const childDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right));

    for (const childDir of childDirs) {
      const found = visit(childDir);
      if (found) return found;
    }
  }

  return visit(root);
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
  for (const name of names) {
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;

    for (const root of roots) {
      const skill = findSkillInRoot(root, name);
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
  domain: string;
  intents: readonly IntentCatalogEntry[];
  bundledSkillsDir?: string;
}): AvailableSkill[] {
  const domain = params.domain.trim().toLowerCase();
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
