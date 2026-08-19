import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { experiencesPath } from "../file-utils.js";
import { normalizeForComparison } from "../normalize.js";
import type {
  ExperienceDirectoryValidationError,
  ExperienceDirectoryValidationResult,
  ExperienceSearchParams,
  SkillExperienceEntry,
} from "./types.js";

const MAX_SEGMENT_CODE_POINTS = 64;
const MAX_SUMMARY_CODE_POINTS = 240;
const MAX_KEYWORD_CODE_POINTS = 64;
const MAX_KEYWORDS = 12;
const MAX_BODY_CODE_POINTS = 12_000;
const VALID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const FRONTMATTER_FIELDS = new Set(["skill", "summary", "keywords"]);

type ExperienceScore = readonly [
  identityExact: 0 | 1,
  exactKeywordMatches: number,
  summaryPhraseMatches: number,
  bodyPhraseMatches: number,
];

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  skillSegment?: string;
  entrySegment?: string;
  canonicalIdentity?: string;
  pathError?: string;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeSegment(value: string): string | undefined {
  const normalized = normalizeForComparison(value);
  if (
    !normalized ||
    codePointLength(normalized) > MAX_SEGMENT_CODE_POINTS ||
    !VALID_SEGMENT.test(normalized)
  ) {
    return;
  }
  return normalized;
}

function isNormalizedSegment(value: string): boolean {
  return normalizeSegment(value) === value;
}

function isConfined(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  return relative || ".";
}

function scanMarkdownFiles(experienceDirectory: string): {
  files: ScannedFile[];
  errors: ExperienceDirectoryValidationError[];
} {
  const root = path.resolve(experienceDirectory);
  const errors: ExperienceDirectoryValidationError[] = [];
  const files: ScannedFile[] = [];
  let rootReal: string;
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) {
      return {
        files,
        errors: [
          { file: ".", message: "experience root cannot be a symbolic link" },
        ],
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        files,
        errors: [{ file: ".", message: "experience root must be a directory" }],
      };
    }
    rootReal = fs.realpathSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { files, errors };
    }
    return {
      files,
      errors: [
        {
          file: ".",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, "en"));
    } catch (error) {
      errors.push({
        file: toRelativePath(root, directory),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const directoryEntry of entries) {
      const declaredPath = path.join(directory, directoryEntry.name);
      const relativePath = toRelativePath(root, declaredPath);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(declaredPath);
      } catch (error) {
        errors.push({
          file: relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (stat.isSymbolicLink()) {
        errors.push({
          file: relativePath,
          message: "symbolic links are not allowed in the experience directory",
        });
        continue;
      }
      if (stat.isDirectory()) {
        let realDirectory: string;
        try {
          realDirectory = fs.realpathSync(declaredPath);
        } catch (error) {
          errors.push({
            file: relativePath,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!isConfined(rootReal, realDirectory)) {
          errors.push({
            file: relativePath,
            message:
              "directory real path is not confined to the experience root",
          });
          continue;
        }
        visit(declaredPath);
        continue;
      }
      if (
        !stat.isFile() ||
        !directoryEntry.name.toLowerCase().endsWith(".md")
      ) {
        continue;
      }

      const segments = relativePath.split("/");
      const entryFile = segments.at(-1) ?? "";
      const entrySegment = entryFile.slice(0, -".md".length);
      const skillSegment = segments.length === 2 ? segments[0] : undefined;
      const canonicalSkill = normalizeSegment(skillSegment ?? "");
      const canonicalEntry = normalizeSegment(entrySegment);
      let pathError: string | undefined;
      if (!entryFile.endsWith(".md")) {
        pathError = "experience Markdown filename must use the .md extension";
      } else if (segments.length !== 2) {
        pathError =
          "experience Markdown path must be <normalized-skill>/<entry-id>.md";
      } else if (!isNormalizedSegment(skillSegment ?? "")) {
        pathError = "skill directory must be a bounded normalized name";
      } else if (!isNormalizedSegment(entrySegment)) {
        pathError = "entry id must be a bounded normalized name";
      }

      files.push({
        absolutePath: declaredPath,
        relativePath,
        skillSegment,
        entrySegment,
        canonicalIdentity:
          canonicalSkill && canonicalEntry
            ? `${canonicalSkill}/${canonicalEntry}`
            : undefined,
        pathError,
      });
    }
  };

  visit(root);
  return { files, errors };
}

function parseExperienceFile(
  rootReal: string,
  file: ScannedFile,
): {
  entry?: SkillExperienceEntry;
  errors: ExperienceDirectoryValidationError[];
} {
  const messages: string[] = [];
  if (file.pathError) messages.push(file.pathError);

  let realFile: string;
  try {
    realFile = fs.realpathSync(file.absolutePath);
    if (!isConfined(rootReal, realFile)) {
      messages.push("file real path is not confined to the experience root");
      return {
        errors: messages.map((message) => ({
          file: file.relativePath,
          message,
        })),
      };
    }
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
    return {
      errors: messages.map((message) => ({ file: file.relativePath, message })),
    };
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(fs.readFileSync(realFile, "utf-8"));
  } catch (error) {
    messages.push(
      `malformed YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      errors: messages.map((message) => ({ file: file.relativePath, message })),
    };
  }

  if (
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    return {
      errors: [
        {
          file: file.relativePath,
          message: "frontmatter must be an object",
        },
      ],
    };
  }
  const data = parsed.data as Record<string, unknown>;
  for (const field of Object.keys(data)) {
    if (!FRONTMATTER_FIELDS.has(field)) {
      messages.push(`unknown frontmatter field ${field}`);
    }
  }
  for (const field of FRONTMATTER_FIELDS) {
    if (!(field in data)) messages.push(`missing frontmatter field ${field}`);
  }

  const skill = typeof data.skill === "string" ? data.skill : "";
  const normalizedSkill = normalizeSegment(skill);
  if (!normalizedSkill || skill !== normalizedSkill) {
    messages.push("skill must be a bounded normalized name");
  } else if (file.skillSegment && normalizedSkill !== file.skillSegment) {
    messages.push(
      `skill ${normalizedSkill} does not match parent directory ${file.skillSegment}`,
    );
  }

  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (!summary) {
    messages.push("summary must be a non-empty string");
  } else if (codePointLength(summary) > MAX_SUMMARY_CODE_POINTS) {
    messages.push(
      `summary must contain at most ${MAX_SUMMARY_CODE_POINTS} Unicode code points`,
    );
  }

  const keywords = Array.isArray(data.keywords) ? data.keywords : undefined;
  const normalizedKeywords: string[] = [];
  if (!keywords || keywords.length < 1 || keywords.length > MAX_KEYWORDS) {
    messages.push(
      `keywords must contain between 1 and ${MAX_KEYWORDS} strings`,
    );
  } else {
    const seen = new Set<string>();
    for (const value of keywords) {
      if (typeof value !== "string" || !value.trim()) {
        messages.push("keywords must contain only non-empty strings");
        continue;
      }
      const trimmed = value.trim();
      if (codePointLength(trimmed) > MAX_KEYWORD_CODE_POINTS) {
        messages.push(
          `each keyword must contain at most ${MAX_KEYWORD_CODE_POINTS} Unicode code points`,
        );
      }
      const normalized = normalizeForComparison(trimmed);
      if (seen.has(normalized)) {
        messages.push(`duplicate keyword ${normalized}`);
      } else {
        seen.add(normalized);
        normalizedKeywords.push(trimmed);
      }
    }
  }

  const body = parsed.content.trim();
  if (!body) {
    messages.push("Markdown body must be non-empty");
  } else if (codePointLength(body) > MAX_BODY_CODE_POINTS) {
    messages.push(
      `Markdown body must contain at most ${MAX_BODY_CODE_POINTS} Unicode code points`,
    );
  }

  if (
    messages.length > 0 ||
    !normalizedSkill ||
    !file.skillSegment ||
    !file.entrySegment
  ) {
    return {
      errors: messages.map((message) => ({ file: file.relativePath, message })),
    };
  }

  return {
    entry: {
      identity: `${normalizedSkill}/${file.entrySegment}`,
      skill: normalizedSkill,
      entryId: file.entrySegment,
      summary,
      keywords: normalizedKeywords,
      body,
      path: file.absolutePath,
    },
    errors: [],
  };
}

function visibleSkillNames(
  visibleSkillsByAgent: Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const visible = new Set<string>();
  for (const skillNames of Object.values(visibleSkillsByAgent)) {
    for (const skillName of skillNames) {
      const normalized = normalizeSegment(skillName);
      if (normalized) visible.add(normalized);
    }
  }
  return visible;
}

export function validateExperienceDirectory(params: {
  experienceDirectory: string;
  visibleSkillsByAgent: Readonly<Record<string, readonly string[]>>;
}): ExperienceDirectoryValidationResult {
  const scanned = scanMarkdownFiles(params.experienceDirectory);
  if (
    scanned.errors.length === 0 &&
    !fs.existsSync(params.experienceDirectory)
  ) {
    return { valid: true, entries: [], errors: [] };
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(params.experienceDirectory));
  } catch {
    return { valid: false, entries: [], errors: scanned.errors };
  }

  const errors = [...scanned.errors];
  const parsedEntries: SkillExperienceEntry[] = [];
  const duplicatePaths = new Map<string, ScannedFile[]>();
  for (const file of scanned.files) {
    if (!file.canonicalIdentity) continue;
    const duplicates = duplicatePaths.get(file.canonicalIdentity) ?? [];
    duplicates.push(file);
    duplicatePaths.set(file.canonicalIdentity, duplicates);
  }
  const rejectedIdentities = new Set<string>();
  for (const [identity, files] of duplicatePaths) {
    if (files.length < 2) continue;
    rejectedIdentities.add(identity);
    for (const file of files) {
      errors.push({
        file: file.relativePath,
        message: `duplicate canonical identity ${identity}`,
      });
    }
  }
  const entriesByIdentity = new Map<string, SkillExperienceEntry[]>();
  for (const file of scanned.files) {
    const parsed = parseExperienceFile(rootReal, file);
    errors.push(...parsed.errors);
    if (!parsed.entry) continue;
    parsedEntries.push(parsed.entry);
    const duplicates = entriesByIdentity.get(parsed.entry.identity) ?? [];
    duplicates.push(parsed.entry);
    entriesByIdentity.set(parsed.entry.identity, duplicates);
  }

  for (const [identity, entries] of entriesByIdentity) {
    if (entries.length < 2) continue;
    rejectedIdentities.add(identity);
    for (const entry of entries) {
      errors.push({
        file: toRelativePath(
          path.resolve(params.experienceDirectory),
          entry.path,
        ),
        message: `duplicate canonical identity ${identity}`,
      });
    }
  }

  const visible = visibleSkillNames(params.visibleSkillsByAgent);
  const validEntries: SkillExperienceEntry[] = [];
  for (const entry of parsedEntries) {
    if (rejectedIdentities.has(entry.identity)) continue;
    if (!visible.has(entry.skill)) {
      errors.push({
        file: toRelativePath(
          path.resolve(params.experienceDirectory),
          entry.path,
        ),
        message: `skill ${entry.skill} is not visible to any configured agent`,
      });
      continue;
    }
    validEntries.push(entry);
  }

  validEntries.sort((left, right) =>
    left.identity.localeCompare(right.identity, "en"),
  );
  errors.sort(
    (left, right) =>
      left.file.localeCompare(right.file, "en") ||
      left.message.localeCompare(right.message, "en"),
  );
  return { valid: errors.length === 0, entries: validEntries, errors };
}

function readCatalogEntries(
  experienceDirectory: string,
): SkillExperienceEntry[] {
  const scanned = scanMarkdownFiles(experienceDirectory);
  if (!fs.existsSync(experienceDirectory)) return [];

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(experienceDirectory));
  } catch {
    return [];
  }

  const byIdentity = new Map<string, SkillExperienceEntry[]>();
  for (const file of scanned.files) {
    const parsed = parseExperienceFile(rootReal, file);
    if (!parsed.entry || parsed.errors.length > 0) continue;
    const entries = byIdentity.get(parsed.entry.identity) ?? [];
    entries.push(parsed.entry);
    byIdentity.set(parsed.entry.identity, entries);
  }

  return [...byIdentity.values()]
    .filter((entries) => entries.length === 1)
    .map(([entry]) => entry)
    .filter((entry): entry is SkillExperienceEntry => Boolean(entry))
    .sort((left, right) => left.identity.localeCompare(right.identity, "en"));
}

function phraseCount(value: string, phrase: string): number {
  if (!phrase) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(phrase, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + phrase.length;
  }
}

function scoreEntry(
  entry: SkillExperienceEntry,
  query: string,
): ExperienceScore {
  const identity = normalizeForComparison(entry.identity);
  const keywords = entry.keywords.map(normalizeForComparison);
  return [
    identity === query ? 1 : 0,
    keywords.filter((keyword) => keyword === query).length,
    phraseCount(normalizeForComparison(entry.summary), query),
    phraseCount(normalizeForComparison(entry.body), query),
  ];
}

function compareScores(left: ExperienceScore, right: ExperienceScore): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class SkillExperienceCatalog {
  private readonly experienceDirectory: string;

  private constructor(dataRoot: string) {
    this.experienceDirectory = experiencesPath(path.resolve(dataRoot));
  }

  static create(dataRoot: string): SkillExperienceCatalog {
    return new SkillExperienceCatalog(dataRoot);
  }

  listForSkills(skillNames: readonly string[]): SkillExperienceEntry[] {
    const requested = new Set(
      skillNames
        .map(normalizeSegment)
        .filter((skillName): skillName is string => Boolean(skillName)),
    );
    if (requested.size === 0) return [];
    return readCatalogEntries(this.experienceDirectory).filter((entry) =>
      requested.has(entry.skill),
    );
  }

  resolve(identity: string): SkillExperienceEntry | undefined {
    const segments = normalizeForComparison(identity).split("/");
    if (segments.length !== 2) return;
    const skill = normalizeSegment(segments[0] ?? "");
    const entryId = normalizeSegment(segments[1] ?? "");
    if (!skill || !entryId) return;
    const canonicalIdentity = `${skill}/${entryId}`;
    return readCatalogEntries(this.experienceDirectory).find(
      (entry) => entry.identity === canonicalIdentity,
    );
  }

  search(params: ExperienceSearchParams): SkillExperienceEntry[] {
    const entries = this.listForSkills(params.skillNames);
    const query = normalizeForComparison(params.query ?? "");
    const limit =
      params.limit === undefined
        ? entries.length
        : Math.max(0, Math.floor(params.limit));
    if (!query) return entries.slice(0, limit);

    return entries
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter(({ score }) => score.some((value) => value > 0))
      .sort(
        (left, right) =>
          compareScores(left.score, right.score) ||
          left.entry.identity.localeCompare(right.entry.identity, "en"),
      )
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
}
