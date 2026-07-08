import { promises as fs } from "node:fs";
import path from "node:path";
import { findAvailableSkill, listAvailableSkills } from "./indexer.js";
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function skillDirFromSkillPath(skillPath: string): string {
  return path.dirname(skillPath);
}

function relativeSupportPath(
  dirName: SupportDirectory,
  filePath: string,
): string {
  return path.join(dirName, filePath).split(path.sep).join("/");
}

async function listFilesRecursively(
  root: string,
  dirName: SupportDirectory,
  dir: string,
): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissingPathError(err)) return [];
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(root, dirName, entryPath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativeSupportPath(dirName, path.relative(root, entryPath)));
    }
  }
  return files;
}

export async function listLinkedSkillFiles(
  skillDir: string,
): Promise<LinkedSkillFiles | undefined> {
  const linkedFiles: LinkedSkillFiles = {};
  for (const dirName of SUPPORT_DIRECTORIES) {
    const files = await listFilesRecursively(
      path.join(skillDir, dirName),
      dirName,
      path.join(skillDir, dirName),
    );
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

  const skillDir = skillDirFromSkillPath(skill.location);
  if (!params.filePath) {
    try {
      const usageStats = await readSkillUsageStats(params);
      return {
        success: true,
        name: skill.name,
        description: skill.description,
        content: await fs.readFile(skill.location, "utf-8"),
        path: skill.location,
        skill_dir: skillDir,
        linked_files: await listLinkedSkillFiles(skillDir),
        usage_hint: null,
        usage_stats: skillUsageStatsForName(usageStats, skill.name),
        source: skill.source,
        domains: skill.domains ?? [],
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
    return {
      success: true,
      name: skill.name,
      file: validation.normalizedFilePath,
      content: await fs.readFile(validation.resolvedPath, "utf-8"),
      file_type: path.extname(validation.normalizedFilePath),
      domains: skill.domains ?? [],
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read support file: ${err instanceof Error ? err.message : String(err)}`,
      available_files: await listLinkedSkillFiles(skillDir),
    };
  }
}
