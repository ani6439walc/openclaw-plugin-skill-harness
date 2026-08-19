import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { isRecord } from "../guards.js";

const TOP_LEVEL_FIELDS = new Set([
  "triggers",
  "examples",
  "domain",
  "skills",
  "candidate",
  "fastpath",
]);
const CANDIDATE_FIELDS = new Set(["scope", "keywords"]);
const FASTPATH_FIELDS = new Set(["keywords"]);
const TERMINAL_DELIMITERS = new Set([".", "!", "?", "。", "！", "？"]);
const MARKDOWN_PREFIX_PATTERN =
  /^\s*(?:#{1,6}(?:\s|$)|```|~~~|[-+*]\s+|\d+[.)]\s+)/;
const SHELL_PREFIX_PATTERN = /^\s*(?:[$>]\s+|[A-Za-z_][A-Za-z0-9_]*=\S+)/;
const SHELL_OPTION_PREFIX_PATTERN = /^\s*[A-Za-z0-9_.+-]+\s+--?[A-Za-z0-9]/;
const SHELL_WRAPPER_COMMANDS = new Set([
  "command",
  "corepack",
  "env",
  "exec",
  "nohup",
  "sudo",
  "time",
  "xargs",
]);
const SHELL_BUILTIN_COMMANDS = new Set([
  "alias",
  "bg",
  "break",
  "builtin",
  "caller",
  "continue",
  "dirs",
  "disown",
  "eval",
  "exit",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "jobs",
  "kill",
  "popd",
  "pushd",
  "read",
  "readonly",
  "return",
  "shift",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);
const SHELL_DIRECT_COMMANDS = new Set([
  "awk",
  "bash",
  "bun",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cp",
  "curl",
  "docker",
  "echo",
  "export",
  "find",
  "fish",
  "git",
  "go",
  "grep",
  "id",
  "kubectl",
  "ln",
  "ls",
  "make",
  "mkdir",
  "mv",
  "node",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "podman",
  "printf",
  "pwd",
  "python",
  "python3",
  "rm",
  "rsync",
  "sed",
  "set",
  "sh",
  "tar",
  "touch",
  "uname",
  "unzip",
  "uv",
  "wget",
  "whoami",
  "yarn",
  "zip",
  "zsh",
]);
const PATH_PATTERN =
  /(?:^|[\s("'`])(?:\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/]|\\\\|\/(?:[^\s/]+(?:\/[^\s/]+)*)?|[^\s/\\]+[\\/][^\s]+)/i;
const SKILL_DIRECTIVE_PATTERN =
  /\b(?:use|load|read|invoke)\b[^.!?。！？\n]*\bskills?\b/i;
const NATURAL_SENTENCE_COMMANDS = new Set(["go", "make", "set"]);

export interface RoutingIntentDefinition {
  triggers: string[];
  examples: string[];
  domain: string;
  skills?: string[];
  candidate?: { scope?: "cross-flow"; keywords?: string[] };
  fastpath: { keywords: string[] };
  guidance: string;
}

export interface RoutingIntentValidationResult {
  valid: boolean;
  errors: string[];
  intents: Array<{
    id: string;
    file: string;
    definition: RoutingIntentDefinition;
  }>;
}


function normalizedStringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    return;
  }
  return value.map((item) => (item as string).trim());
}

function isPathLikeSkillName(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value)
  );
}

function startsWithShellCommand(value: string): boolean {
  if (SHELL_PREFIX_PATTERN.test(value)) return true;
  if (SHELL_OPTION_PREFIX_PATTERN.test(value)) return true;
  const firstToken = value.trimStart().match(/^([A-Za-z0-9_.+-]+)/u)?.[1];
  if (!firstToken) return false;
  const canonicalToken = firstToken.toLowerCase();
  const isShellCommand =
    SHELL_WRAPPER_COMMANDS.has(canonicalToken) ||
    SHELL_BUILTIN_COMMANDS.has(canonicalToken) ||
    SHELL_DIRECT_COMMANDS.has(canonicalToken);
  return (
    isShellCommand &&
    (firstToken === canonicalToken ||
      !NATURAL_SENTENCE_COMMANDS.has(canonicalToken))
  );
}

function validateGuidance(
  file: string,
  value: unknown,
  errors: string[],
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${file}: guidance must be a non-empty string`);
    return;
  }

  const guidance = value.trim();
  if (/^[a-z]/u.test(guidance)) {
    errors.push(
      `${file}: guidance must start with an uppercase ASCII letter when it starts with an ASCII letter`,
    );
  }
  if (/[\r\n\u0085\u2028\u2029]/u.test(guidance)) {
    errors.push(`${file}: guidance must be one line`);
  }
  if (Array.from(guidance).length > 300) {
    errors.push(
      `${file}: guidance must contain at most 300 Unicode code points`,
    );
  }

  const codePoints = Array.from(guidance);
  const terminalIndexes = codePoints.flatMap((codePoint, index) =>
    TERMINAL_DELIMITERS.has(codePoint) ? [index] : [],
  );
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== codePoints.length - 1
  ) {
    errors.push(
      `${file}: guidance must contain exactly one terminal delimiter and it must be the final code point`,
    );
  }
  if (MARKDOWN_PREFIX_PATTERN.test(guidance)) {
    errors.push(
      `${file}: guidance must not start with a Markdown list, heading, or fence`,
    );
  }
  if (startsWithShellCommand(guidance)) {
    errors.push(`${file}: guidance must not start with a shell command prefix`);
  }
  if (PATH_PATTERN.test(guidance)) {
    errors.push(
      `${file}: guidance must not contain an absolute or relative path`,
    );
  }
  if (SKILL_DIRECTIVE_PATTERN.test(guidance)) {
    errors.push(
      `${file}: guidance must not direct the agent to use, load, read, or invoke a skill`,
    );
  }

  return guidance;
}

function errnoCode(error: unknown, fallback = "UNKNOWN"): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
}

export function validateRoutingIntentDirectory(
  intentDirectory: string,
  targetIntentIds: readonly string[] = [],
): RoutingIntentValidationResult {
  const errors: string[] = [];
  const intents: RoutingIntentValidationResult["intents"] = [];
  const seenIds = new Map<string, string>();
  const availableIds = new Set<string>();
  const markdownCandidates: string[] = [];
  let rootExists = true;
  try {
    const rootStat = fs.lstatSync(intentDirectory);
    if (rootStat.isSymbolicLink()) {
      return {
        valid: false,
        errors: [".: intent root cannot be a symbolic link"],
        intents,
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        valid: false,
        errors: [".: intent root must be a directory"],
        intents,
      };
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      rootExists = false;
    } else {
      return {
        valid: false,
        errors: [`.: unable to inspect intent root (${errnoCode(error)})`],
        intents,
      };
    }
  }
  if (rootExists) {
    const visit = (directory: string, relativeDirectory = ""): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs
          .readdirSync(directory, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name, "en"));
      } catch (error) {
        errors.push(
          `${relativeDirectory || "."}: unable to read directory (${errnoCode(error)})`,
        );
        return;
      }
      for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        const declaredPath = path.join(directory, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(declaredPath);
        } catch (error) {
          errors.push(
            `${relativePath}: unable to inspect entry (${errnoCode(error)})`,
          );
          continue;
        }
        if (stat.isSymbolicLink()) {
          errors.push(`${relativePath}: symbolic links are not allowed`);
          continue;
        }
        if (stat.isDirectory()) {
          visit(declaredPath, relativePath);
        } else if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          markdownCandidates.push(relativePath);
        } else if (!stat.isFile()) {
          errors.push(`${relativePath}: unsupported non-regular entry`);
        }
      }
    };
    visit(intentDirectory);
    markdownCandidates.sort();
  }

  if (markdownCandidates.length === 0 && errors.length === 0) {
    errors.push("no intent Markdown files found");
  }

  const files: string[] = [];
  for (const file of markdownCandidates) {
    if (path.dirname(file) !== ".") {
      errors.push(
        `${file}: intent Markdown files must be directly under the intent directory`,
      );
      continue;
    }
    if (!file.endsWith(".md")) {
      errors.push(
        `${file}: intent Markdown filename must use the .md extension`,
      );
      continue;
    }
    try {
      const stat = fs.lstatSync(path.join(intentDirectory, file));
      if (stat.isSymbolicLink()) {
        errors.push(`${file}: symbolic links are not allowed`);
      } else if (!stat.isFile()) {
        errors.push(`${file}: intent Markdown path must be a regular file`);
      } else {
        files.push(file);
      }
    } catch (error) {
      errors.push(
        `${file}: unable to inspect intent Markdown file (${errnoCode(error)})`,
      );
    }
  }

  for (const file of files) {
    const fileErrors: string[] = [];
    const id = file.slice(0, -".md".length);
    availableIds.add(id);

    const canonicalId = id.toLowerCase();
    const duplicateIdFile = seenIds.get(canonicalId);
    if (duplicateIdFile) {
      fileErrors.push(
        `${file}: duplicate intent id ${id} already used by ${duplicateIdFile}`,
      );
    } else {
      seenIds.set(canonicalId, file);
    }

    try {
      const parsed = matter(
        fs.readFileSync(path.join(intentDirectory, file), "utf-8"),
      );
      const data = parsed.data as Record<string, unknown>;

      for (const field of Object.keys(data).sort()) {
        if (!TOP_LEVEL_FIELDS.has(field)) {
          fileErrors.push(`${file}: unsupported top-level field ${field}`);
        }
      }

      const triggers = normalizedStringArray(data.triggers);
      if (!triggers || triggers.length === 0) {
        fileErrors.push(
          `${file}: triggers must contain at least one non-empty string and only non-empty strings`,
        );
      }

      const examples = normalizedStringArray(data.examples);
      if (!examples) {
        fileErrors.push(
          `${file}: examples must be an array containing only non-empty strings`,
        );
      }

      const domain = typeof data.domain === "string" ? data.domain.trim() : "";
      if (!domain) {
        fileErrors.push(`${file}: domain must be a non-empty string`);
      }

      let skills: string[] | undefined;
      if (data.skills !== undefined) {
        skills = normalizedStringArray(data.skills);
        if (!skills) {
          fileErrors.push(
            `${file}: skills must be an array containing only non-empty strings`,
          );
        } else {
          const seenSkills = new Set<string>();
          for (const skill of skills) {
            const canonicalSkill = skill.toLowerCase();
            if (seenSkills.has(canonicalSkill)) {
              fileErrors.push(
                `${file}: duplicate skill name ${canonicalSkill} after trim/lowercase normalization`,
              );
            } else {
              seenSkills.add(canonicalSkill);
            }
            if (isPathLikeSkillName(skill)) {
              fileErrors.push(
                `${file}: skill name must not be path-like: ${skill}`,
              );
            }
          }
        }
      }

      let candidate: RoutingIntentDefinition["candidate"];
      if (data.candidate !== undefined) {
        if (!isRecord(data.candidate)) {
          fileErrors.push(`${file}: candidate must be an object`);
        } else {
          const rawCandidate = data.candidate;
          for (const field of Object.keys(rawCandidate).sort()) {
            if (!CANDIDATE_FIELDS.has(field)) {
              fileErrors.push(
                `${file}: candidate contains unsupported field ${field}`,
              );
            }
          }
          const scope = rawCandidate.scope;
          if (scope !== undefined && scope !== "cross-flow") {
            fileErrors.push(
              `${file}: candidate.scope must be cross-flow when provided`,
            );
          }
          const keywords =
            rawCandidate.keywords === undefined
              ? undefined
              : normalizedStringArray(rawCandidate.keywords);
          if (rawCandidate.keywords !== undefined && !keywords) {
            fileErrors.push(
              `${file}: candidate.keywords must be an array containing only non-empty strings`,
            );
          }
          if (scope === "cross-flow" || keywords !== undefined) {
            candidate = {
              ...(scope === "cross-flow" ? { scope } : {}),
              ...(keywords !== undefined ? { keywords } : {}),
            };
          }
        }
      }

      let fastpathKeywords: string[] = [];
      if (data.fastpath !== undefined) {
        if (!isRecord(data.fastpath)) {
          fileErrors.push(`${file}: fastpath must be an object`);
        } else {
          const rawFastpath = data.fastpath;
          for (const field of Object.keys(rawFastpath).sort()) {
            if (field === "hint") {
              fileErrors.push(`${file}: fastpath.hint is not supported`);
            } else if (!FASTPATH_FIELDS.has(field)) {
              fileErrors.push(
                `${file}: fastpath contains unsupported field ${field}`,
              );
            }
          }
          if (rawFastpath.keywords !== undefined) {
            const keywords = normalizedStringArray(rawFastpath.keywords);
            if (!keywords) {
              fileErrors.push(
                `${file}: fastpath.keywords must be an array containing only non-empty strings`,
              );
            } else {
              fastpathKeywords = keywords;
            }
          }
        }
      }

      const guidance = validateGuidance(file, parsed.content, fileErrors);

      if (
        fileErrors.length === 0 &&
        triggers &&
        examples &&
        domain &&
        guidance
      ) {
        intents.push({
          id,
          file,
          definition: {
            triggers,
            examples,
            domain,
            ...(skills && skills.length > 0 ? { skills } : {}),
            ...(candidate ? { candidate } : {}),
            fastpath: { keywords: fastpathKeywords },
            guidance,
          },
        });
      }
    } catch (error) {
      fileErrors.push(
        `${file}: unable to read or parse intent Markdown (${errnoCode(error, "INVALID")})`,
      );
    }

    errors.push(...fileErrors);
  }

  for (const targetId of targetIntentIds) {
    if (!availableIds.has(targetId)) {
      errors.push(`target intent not found: ${targetId}`);
    }
  }

  return { valid: errors.length === 0, errors, intents };
}
