import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { findAvailableSkill, clearSkillIndexCache } from "./indexer.js";
import { resolveSkillRoots } from "./roots.js";
import type { AvailableSkill, SkillResolutionParams } from "./types.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SUPPORT_FILE_BYTES = 1_048_576;
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SUPPORT_DIRECTORIES = [
  "references",
  "templates",
  "scripts",
  "assets",
  "examples",
] as const;

type SupportDirectory = (typeof SUPPORT_DIRECTORIES)[number];

export type SkillManageAction =
  "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file";

export interface SkillManageParams extends SkillResolutionParams {
  action: SkillManageAction | string;
  name: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  category?: string;
  filePath?: string;
  fileContent?: string;
  absorbedInto?: string;
}

export type SkillManageResult =
  | ({ success: true; message: string } & Record<string, unknown>)
  | ({ success: false; error: string } & Record<string, unknown>);

interface ExistingSkill {
  skill: AvailableSkill;
  skillDir: string;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function validateName(name: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (name.length > MAX_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`;
  }
  return;
}

function validateCategory(category: string | undefined): string | undefined {
  if (category === undefined) return;
  const trimmed = category.trim();
  if (!trimmed) return;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return `Invalid category '${category}'. Categories must be a single directory name.`;
  }
  return validateName(trimmed)?.replace("Skill name", "Category");
}

function validateContentSize(
  content: string,
  label = "SKILL.md",
): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `${label} content is ${content.length.toLocaleString()} characters (limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). Split large material into supporting files.`;
  }
  return;
}

function validateFrontmatter(content: string): string | undefined {
  if (!content.trim()) return "Content cannot be empty.";
  if (!content.startsWith("---")) {
    return "SKILL.md must start with YAML frontmatter (---).";
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (error) {
    return `YAML frontmatter parse error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const data = parsed.data as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name.trim()) {
    return "Frontmatter must include 'name' field.";
  }
  if (typeof data.description !== "string" || !data.description.trim()) {
    return "Frontmatter must include 'description' field.";
  }
  if (data.description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (!parsed.content.trim()) {
    return "SKILL.md must have content after the frontmatter.";
  }
  return;
}

function parseDescription(content: string): string {
  try {
    const parsed = matter(content);
    const description = (parsed.data as Record<string, unknown>).description;
    return typeof description === "string" ? description.slice(0, 120) : "";
  } catch {
    return "";
  }
}

function managedSkillsRoot(params: SkillResolutionParams): string {
  return path.join(
    params.api.runtime.state.resolveStateDir(process.env),
    "skills",
  );
}

function resolveNewSkillDir(params: SkillManageParams): string {
  const category = params.category?.trim();
  return category
    ? path.join(managedSkillsRoot(params), category, params.name)
    : path.join(managedSkillsRoot(params), params.name);
}

function skillDirFromPath(skillPath: string): string {
  return path.dirname(skillPath);
}

async function atomicWriteText(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateSupportPath(
  skillDir: string,
  filePath: string,
):
  | { success: true; resolvedPath: string; normalizedFilePath: string }
  | { success: false; error: string } {
  const trimmed = filePath.trim();
  if (!trimmed) return { success: false, error: "file_path cannot be blank" };
  if (path.isAbsolute(trimmed)) {
    return { success: false, error: "file_path must be relative" };
  }
  const normalized = path.normalize(trimmed);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    return { success: false, error: "file_path cannot contain traversal" };
  }
  const firstSegment = normalized.split(path.sep)[0];
  if (!SUPPORT_DIRECTORIES.includes(firstSegment as SupportDirectory)) {
    return {
      success: false,
      error: `file_path must be under one of: ${SUPPORT_DIRECTORIES.join(", ")}`,
    };
  }
  if (normalized.split(path.sep).filter(Boolean).length < 2) {
    return {
      success: false,
      error: `Provide a file path, not just a directory. Example: ${firstSegment}/example.md`,
    };
  }
  const resolvedPath = path.resolve(skillDir, normalized);
  const relative = path.relative(skillDir, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { success: false, error: "file_path escapes the skill directory" };
  }
  return {
    success: true,
    resolvedPath,
    normalizedFilePath: normalized.split(path.sep).join("/"),
  };
}

async function existingSkill(
  params: SkillManageParams,
): Promise<ExistingSkill | undefined> {
  const skill = await findAvailableSkill(params);
  if (!skill) return;
  return { skill, skillDir: skillDirFromPath(skill.location) };
}

async function skillNotFoundResult(
  params: SkillManageParams,
  suffix = "",
): Promise<SkillManageResult> {
  return {
    success: false,
    error: `Skill not found: ${params.name}${suffix}`,
  };
}

async function createSkill(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  const nameError = validateName(params.name);
  if (nameError) return { success: false, error: nameError };
  const categoryError = validateCategory(params.category);
  if (categoryError) return { success: false, error: categoryError };
  if (!params.content) {
    return {
      success: false,
      error: "content is required for 'create'. Provide full SKILL.md content.",
    };
  }
  const frontmatterError = validateFrontmatter(params.content);
  if (frontmatterError) return { success: false, error: frontmatterError };
  const sizeError = validateContentSize(params.content);
  if (sizeError) return { success: false, error: sizeError };

  const existing = await existingSkill(params);
  if (existing) {
    return {
      success: false,
      error: `A skill named '${params.name}' already exists at ${existing.skillDir}.`,
    };
  }

  const skillDir = resolveNewSkillDir(params);
  const skillPath = path.join(skillDir, "SKILL.md");
  await atomicWriteText(skillPath, params.content);
  clearSkillIndexCache();

  return {
    success: true,
    message: `Skill '${params.name}' created.`,
    path: path.relative(managedSkillsRoot(params), skillDir) || params.name,
    skill_md: skillPath,
    category: params.category?.trim() || undefined,
    _change: { description: parseDescription(params.content) },
    hint: `To add support files, call skill_manage(action='write_file', name='${params.name}', file_path='references/example.md', file_content='...').`,
  };
}

async function editSkill(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  if (!params.content) {
    return {
      success: false,
      error:
        "content is required for 'edit'. Provide full updated SKILL.md content.",
    };
  }
  const frontmatterError = validateFrontmatter(params.content);
  if (frontmatterError) return { success: false, error: frontmatterError };
  const sizeError = validateContentSize(params.content);
  if (sizeError) return { success: false, error: sizeError };
  const existing = await existingSkill(params);
  if (!existing) return await skillNotFoundResult(params);

  const original = await fs.readFile(existing.skill.location, "utf-8");
  try {
    await atomicWriteText(existing.skill.location, params.content);
  } catch (error) {
    await atomicWriteText(existing.skill.location, original).catch(
      () => undefined,
    );
    return {
      success: false,
      error: `Failed to edit skill: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  clearSkillIndexCache();

  return {
    success: true,
    message: `Skill '${params.name}' updated (full rewrite).`,
    path: existing.skillDir,
    _change: { description: parseDescription(params.content) },
  };
}

function replaceContent(params: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}):
  | { success: true; content: string; replacements: number }
  | { success: false; error: string; file_preview: string } {
  const replacements = params.content.split(params.oldString).length - 1;
  if (replacements === 0) {
    return {
      success: false,
      error: "old_string not found.",
      file_preview: params.content.slice(0, 500),
    };
  }
  if (replacements > 1 && !params.replaceAll) {
    return {
      success: false,
      error: `old_string has multiple matches (${replacements}); pass replace_all=true to replace all occurrences.`,
      file_preview: params.content.slice(0, 500),
    };
  }
  return {
    success: true,
    content: params.content.split(params.oldString).join(params.newString),
    replacements,
  };
}

async function patchSkill(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  if (!params.oldString) {
    return { success: false, error: "old_string is required for 'patch'." };
  }
  if (params.newString === undefined) {
    return {
      success: false,
      error:
        "new_string is required for 'patch'. Use an empty string to delete matched text.",
    };
  }

  const existing = await existingSkill(params);
  if (!existing) return await skillNotFoundResult(params);
  const target = params.filePath
    ? validateSupportPath(existing.skillDir, params.filePath)
    : {
        success: true as const,
        resolvedPath: existing.skill.location,
        normalizedFilePath: "SKILL.md",
      };
  if (!target.success) return { success: false, error: target.error };

  let content: string;
  try {
    content = await fs.readFile(target.resolvedPath, "utf-8");
  } catch (error) {
    return {
      success: false,
      error: `File not found: ${target.normalizedFilePath} (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const replaced = replaceContent({
    content,
    oldString: params.oldString,
    newString: params.newString,
    replaceAll: params.replaceAll,
  });
  if (!replaced.success) return replaced;

  const sizeError = validateContentSize(
    replaced.content,
    target.normalizedFilePath,
  );
  if (sizeError) return { success: false, error: sizeError };
  if (!params.filePath) {
    const frontmatterError = validateFrontmatter(replaced.content);
    if (frontmatterError) {
      return {
        success: false,
        error: `Patch would break SKILL.md structure: ${frontmatterError}`,
      };
    }
  }

  await atomicWriteText(target.resolvedPath, replaced.content);
  clearSkillIndexCache();
  return {
    success: true,
    message: `Patched ${target.normalizedFilePath} in skill '${params.name}' (${replaced.replacements} replacement${replaced.replacements === 1 ? "" : "s"}).`,
    replacements: replaced.replacements,
    _change: {
      old: params.oldString.slice(0, 200),
      new: params.newString.slice(0, 200),
    },
  };
}

async function writeSupportFile(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  if (!params.filePath) {
    return {
      success: false,
      error:
        "file_path is required for 'write_file'. Example: references/api-guide.md",
    };
  }
  if (params.fileContent === undefined) {
    return {
      success: false,
      error: "file_content is required for 'write_file'.",
    };
  }
  const contentBytes = Buffer.byteLength(params.fileContent, "utf-8");
  if (contentBytes > MAX_SUPPORT_FILE_BYTES) {
    return {
      success: false,
      error: `File content is ${contentBytes.toLocaleString()} bytes (limit: ${MAX_SUPPORT_FILE_BYTES.toLocaleString()} bytes / 1 MiB).`,
    };
  }
  const sizeError = validateContentSize(params.fileContent, params.filePath);
  if (sizeError) return { success: false, error: sizeError };

  const existing = await existingSkill(params);
  if (!existing) {
    return await skillNotFoundResult(
      params,
      " Create it first with action='create'.",
    );
  }
  const target = validateSupportPath(existing.skillDir, params.filePath);
  if (!target.success) return { success: false, error: target.error };

  await atomicWriteText(target.resolvedPath, params.fileContent);
  clearSkillIndexCache();
  return {
    success: true,
    message: `File '${target.normalizedFilePath}' written to skill '${params.name}'.`,
    path: target.resolvedPath,
  };
}

async function listAvailableFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const subdir of SUPPORT_DIRECTORIES) {
    const root = path.join(skillDir, subdir);
    const visit = async (dir: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isMissingPathError(error)) return;
        return;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile()) {
          files.push(
            path.relative(skillDir, entryPath).split(path.sep).join("/"),
          );
        }
      }
    };
    await visit(root);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function removeSupportFile(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  if (!params.filePath) {
    return {
      success: false,
      error: "file_path is required for 'remove_file'.",
    };
  }
  const existing = await existingSkill(params);
  if (!existing) return await skillNotFoundResult(params);
  const target = validateSupportPath(existing.skillDir, params.filePath);
  if (!target.success) return { success: false, error: target.error };

  try {
    await fs.unlink(target.resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        success: false,
        error: `File '${target.normalizedFilePath}' not found in skill '${params.name}'.`,
        available_files: await listAvailableFiles(existing.skillDir),
      };
    }
    return {
      success: false,
      error: `Failed to remove file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  await removeEmptyParents(
    path.dirname(target.resolvedPath),
    existing.skillDir,
  );
  clearSkillIndexCache();
  return {
    success: true,
    message: `File '${target.normalizedFilePath}' removed from skill '${params.name}'.`,
  };
}

async function containingSkillRoot(
  params: SkillManageParams,
  skillDir: string,
): Promise<string | undefined> {
  let resolvedSkillDir: string;
  try {
    resolvedSkillDir = await fs.realpath(skillDir);
  } catch {
    return;
  }

  for (const root of resolveSkillRoots(params)) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root.path);
    } catch {
      continue;
    }
    const relative = path.relative(resolvedRoot, resolvedSkillDir);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return resolvedRoot;
    }
  }
  return;
}

async function validateDeleteTarget(
  params: SkillManageParams,
  existing: ExistingSkill,
): Promise<string | undefined> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(existing.skillDir);
  } catch (error) {
    return `Refusing to delete '${existing.skillDir}': could not stat path (${error instanceof Error ? error.message : String(error)}).`;
  }
  if (stat.isSymbolicLink()) {
    return `Refusing to delete '${existing.skillDir}': the skill directory is a symlink.`;
  }
  const root = await containingSkillRoot(params, existing.skillDir);
  if (!root) {
    return `Refusing to delete '${existing.skillDir}': path does not resolve inside any known skills root.`;
  }
  const relative = path.relative(root, await fs.realpath(existing.skillDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `Refusing to delete '${existing.skillDir}': resolves to a skills root.`;
  }
  return;
}

async function removeEmptyParents(
  startDir: string,
  stopDir: string,
): Promise<void> {
  let current = startDir;
  const resolvedStop = path.resolve(stopDir);
  while (path.resolve(current) !== resolvedStop) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    await fs.rmdir(current);
    current = path.dirname(current);
  }
}

async function deleteSkill(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  const existing = await existingSkill(params);
  if (!existing) return await skillNotFoundResult(params);

  const absorbedTarget = params.absorbedInto?.trim() ?? "";
  if (absorbedTarget) {
    if (absorbedTarget === params.name) {
      return {
        success: false,
        error: `absorbed_into='${absorbedTarget}' cannot equal the skill being deleted.`,
      };
    }
    const target = await findAvailableSkill({
      ...params,
      name: absorbedTarget,
    });
    if (!target) {
      return {
        success: false,
        error: `absorbed_into='${absorbedTarget}' does not exist. Create or patch the umbrella skill first, then retry the delete.`,
      };
    }
  }

  const unsafe = await validateDeleteTarget(params, existing);
  if (unsafe) return { success: false, error: unsafe };

  const root = await containingSkillRoot(params, existing.skillDir);
  await fs.rm(existing.skillDir, { recursive: true, force: false });
  if (root) {
    await removeEmptyParents(path.dirname(existing.skillDir), root);
  }
  clearSkillIndexCache();

  return {
    success: true,
    message: `Skill '${params.name}' deleted.${absorbedTarget ? ` Content absorbed into '${absorbedTarget}'.` : ""}`,
  };
}

export async function manageSkill(
  params: SkillManageParams,
): Promise<SkillManageResult> {
  switch (params.action) {
    case "create":
      return await createSkill(params);
    case "edit":
      return await editSkill(params);
    case "patch":
      return await patchSkill(params);
    case "delete":
      return await deleteSkill(params);
    case "write_file":
      return await writeSupportFile(params);
    case "remove_file":
      return await removeSupportFile(params);
    default:
      return {
        success: false,
        error: `Unknown action '${params.action}'. Use: create, edit, patch, delete, write_file, remove_file`,
      };
  }
}
