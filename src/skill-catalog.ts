import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import matter from "gray-matter";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { AvailableSkill } from "./types.js";

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
    bundledSkillsDir,
  ];

  const skills: AvailableSkill[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const root of roots) {
      const skill = readSkillFile(path.join(root, name, "SKILL.md"));
      if (
        !skill ||
        skill.name.toLowerCase() !== name.toLowerCase() ||
        seen.has(skill.name.toLowerCase())
      )
        continue;
      skills.push(skill);
      seen.add(skill.name.toLowerCase());
      break;
    }
  }
  return skills;
}
