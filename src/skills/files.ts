import { promises as fs } from "node:fs";
import path from "node:path";
import { listConfinedFiles, resolveConfinedFile } from "./paths.js";
import { findAvailableSkill, listAvailableSkills } from "./indexer.js";
import { relatedSkillsBySkillName } from "./related.js";
import type {
  LinkedSkillFiles,
  SkillReadParams,
  SkillReadResult,
} from "./types.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";

const SUPPORT_DIRECTORIES = [
  "references",
  "templates",
  "scripts",
  "assets",
  "examples",
] as const;

type SupportDirectory = (typeof SUPPORT_DIRECTORIES)[number];

export async function listLinkedSkillFiles(
  skillDir: string,
): Promise<LinkedSkillFiles | undefined> {
  const linkedFiles: LinkedSkillFiles = {};
  for (const dirName of SUPPORT_DIRECTORIES) {
    const files = (
      await listConfinedFiles(skillDir, path.join(skillDir, dirName))
    ).map((file) => path.relative(skillDir, file).split(path.sep).join("/"));
    if (files.length > 0) linkedFiles[dirName] = files;
  }
  return Object.keys(linkedFiles).length > 0 ? linkedFiles : undefined;
}

function validateSupportPath(
  skillDir: string,
  filePath: string,
):
  | { success: true; resolvedPath: string; normalizedFilePath: string }
  | {
      success: false;
      error: string;
    } {
  const trimmed = filePath.trim();
  if (!trimmed) return { success: false, error: "file_path cannot be blank" };
  if (path.isAbsolute(trimmed)) {
    return { success: false, error: "file_path must be relative" };
  }
  const normalizedFilePath = path.normalize(trimmed);
  if (
    normalizedFilePath === ".." ||
    normalizedFilePath.startsWith(`..${path.sep}`) ||
    normalizedFilePath.includes(`${path.sep}..${path.sep}`)
  ) {
    return { success: false, error: "file_path cannot contain traversal" };
  }
  const firstSegment = normalizedFilePath.split(path.sep)[0];
  if (!SUPPORT_DIRECTORIES.includes(firstSegment as SupportDirectory)) {
    return {
      success: false,
      error: `file_path must be under one of: ${SUPPORT_DIRECTORIES.join(", ")}`,
    };
  }
  const resolvedPath = path.resolve(skillDir, normalizedFilePath);
  const relative = path.relative(skillDir, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { success: false, error: "file_path escapes the skill directory" };
  }
  return {
    success: true,
    resolvedPath,
    normalizedFilePath: normalizedFilePath.split(path.sep).join("/"),
  };
}

export async function readAvailableSkill(
  params: SkillReadParams,
): Promise<SkillReadResult> {
  const skill = await findAvailableSkill(params);
  if (!skill) {
    const availableSkills = await listAvailableSkills(params);
    return {
      success: false,
      error: `Skill not found: ${params.name}`,
      available_skills: availableSkills.map((available) => available.name),
    };
  }

  const skillDir = path.dirname(skill.location);
  const relatedSkills =
    (
      await relatedSkillsBySkillName(
        await listAvailableSkills(params),
        params.api,
      )
    ).get(skill.name.toLowerCase()) ?? [];
  if (!params.filePath) {
    try {
      const resolved = await resolveConfinedFile(skillDir, skill.location);
      if (!resolved)
        throw new Error(
          "Skill file must be a regular file within the skill directory",
        );
      const usageStats = await readSkillUsageStats(params);
      return {
        success: true,
        name: skill.name,
        description: skill.description,
        content: await fs.readFile(resolved, "utf-8"),
        path: skill.location,
        skill_dir: skillDir,
        linked_files: await listLinkedSkillFiles(skillDir),
        usage_hint: null,
        usage_stats: skillUsageStatsForName(usageStats, skill.name),
        related_skills: relatedSkills,
        source: skill.source,
        readiness_status: "available",
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read skill: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const validation = validateSupportPath(skillDir, params.filePath);
  if (!validation.success) {
    return {
      success: false,
      error: validation.error,
      available_files: await listLinkedSkillFiles(skillDir),
    };
  }

  try {
    const resolved = await resolveConfinedFile(
      skillDir,
      validation.resolvedPath,
    );
    if (!resolved)
      throw new Error(
        "Support file must be a regular file within the skill directory",
      );
    return {
      success: true,
      name: skill.name,
      file: validation.normalizedFilePath,
      content: await fs.readFile(resolved, "utf-8"),
      file_type: path.extname(validation.normalizedFilePath),
      related_skills: relatedSkills,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read support file: ${err instanceof Error ? err.message : String(err)}`,
      available_files: await listLinkedSkillFiles(skillDir),
    };
  }
}
