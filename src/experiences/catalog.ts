import * as fs from "node:fs";
import * as path from "node:path";
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

const REQUIRED_FILES = ["summary.md", "keywords.md", "body.md"] as const;
const OPTIONAL_FILES = ["skills.md"] as const;
const ALLOWED_FILES = new Set<string>([...REQUIRED_FILES, ...OPTIONAL_FILES]);

type ExperienceScore = readonly [
  idExact: 0 | 1,
  exactKeywordMatches: number,
  summaryPhraseMatches: number,
  bodyPhraseMatches: number,
];

interface ScannedEntry {
  absolutePath: string;
  relativePath: string;
  entrySegment?: string;
  canonicalId?: string;
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

function scanExperienceFolders(experienceDirectory: string): {
  entries: ScannedEntry[];
  errors: ExperienceDirectoryValidationError[];
} {
  const root = path.resolve(experienceDirectory);
  const errors: ExperienceDirectoryValidationError[] = [];
  const entries: ScannedEntry[] = [];
  let rootReal: string;
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) {
      return {
        entries,
        errors: [
          { file: ".", message: "experience root cannot be a symbolic link" },
        ],
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        entries,
        errors: [{ file: ".", message: "experience root must be a directory" }],
      };
    }
    rootReal = fs.realpathSync(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { entries, errors };
    }
    return {
      entries,
      errors: [
        {
          file: ".",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs
      .readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  } catch (error) {
    errors.push({
      file: ".",
      message: error instanceof Error ? error.message : String(error),
    });
    return { entries, errors };
  }

  for (const dirent of dirents) {
    const declaredPath = path.join(root, dirent.name);
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

    if (!stat.isDirectory()) {
      errors.push({
        file: relativePath,
        message: "experience root can only contain experience directories",
      });
      continue;
    }

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
        message: "directory real path is not confined to the experience root",
      });
      continue;
    }

    const entrySegment = dirent.name;
    const canonicalId = normalizeSegment(entrySegment);
    let pathError: string | undefined;
    if (!isNormalizedSegment(entrySegment)) {
      pathError = "entry directory must be a bounded normalized name";
    }

    entries.push({
      absolutePath: declaredPath,
      relativePath,
      entrySegment,
      canonicalId,
      pathError,
    });
  }

  return { entries, errors };
}

function parseExperienceFolder(
  rootReal: string,
  entry: ScannedEntry,
): {
  entry?: SkillExperienceEntry;
  errors: ExperienceDirectoryValidationError[];
} {
  const messages: string[] = [];
  if (entry.pathError) messages.push(entry.pathError);

  let realDir: string;
  try {
    realDir = fs.realpathSync(entry.absolutePath);
    if (!isConfined(rootReal, realDir)) {
      messages.push(
        "directory real path is not confined to the experience root",
      );
      return {
        errors: messages.map((message) => ({
          file: entry.relativePath,
          message,
        })),
      };
    }
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
    return {
      errors: messages.map((message) => ({
        file: entry.relativePath,
        message,
      })),
    };
  }

  let childDirents: fs.Dirent[];
  try {
    childDirents = fs
      .readdirSync(realDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
    return {
      errors: messages.map((message) => ({
        file: entry.relativePath,
        message,
      })),
    };
  }

  for (const child of childDirents) {
    const childRelative = path.join(entry.relativePath, child.name);
    const childDeclaredPath = path.join(entry.absolutePath, child.name);
    let childStat: fs.Stats;
    try {
      childStat = fs.lstatSync(childDeclaredPath);
    } catch (error) {
      messages.push(
        `failed to stat ${childRelative}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (childStat.isSymbolicLink()) {
      messages.push(
        `symbolic links are not allowed in experience entry: ${child.name}`,
      );
      continue;
    }
    if (childStat.isDirectory()) {
      messages.push(
        `subdirectories are not allowed inside experience entry: ${child.name}`,
      );
      continue;
    }
    if (!ALLOWED_FILES.has(child.name)) {
      messages.push(`unexpected file in experience entry: ${child.name}`);
    }
  }

  const existingFileNames = new Set(childDirents.map((d) => d.name));
  for (const req of REQUIRED_FILES) {
    if (!existingFileNames.has(req)) {
      messages.push(`missing required file: ${req}`);
    }
  }

  if (messages.length > 0) {
    return {
      errors: messages.map((message) => ({
        file: entry.relativePath,
        message,
      })),
    };
  }

  // Parse summary.md
  let summary = "";
  try {
    summary = fs.readFileSync(path.join(realDir, "summary.md"), "utf8").trim();
  } catch (error) {
    messages.push(
      `failed to read summary.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!summary) {
    messages.push("summary must be a non-empty string");
  } else if (codePointLength(summary) > MAX_SUMMARY_CODE_POINTS) {
    messages.push(
      `summary must contain at most ${MAX_SUMMARY_CODE_POINTS} Unicode code points`,
    );
  }

  // Parse keywords.md
  const normalizedKeywords: string[] = [];
  try {
    const rawKeywords = fs.readFileSync(
      path.join(realDir, "keywords.md"),
      "utf8",
    );
    const lines = rawKeywords.split(/\r?\n/);
    const seen = new Set<string>();
    for (const rawLine of lines) {
      let trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        trimmed = trimmed.slice(2).trim();
      }
      if (!trimmed) continue;

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
  } catch (error) {
    messages.push(
      `failed to read keywords.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    normalizedKeywords.length < 1 ||
    normalizedKeywords.length > MAX_KEYWORDS
  ) {
    messages.push(
      `keywords must contain between 1 and ${MAX_KEYWORDS} strings`,
    );
  }

  // Parse body.md
  let body = "";
  try {
    body = fs.readFileSync(path.join(realDir, "body.md"), "utf8").trim();
  } catch (error) {
    messages.push(
      `failed to read body.md: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!body) {
    messages.push("Markdown body must be non-empty");
  } else if (codePointLength(body) > MAX_BODY_CODE_POINTS) {
    messages.push(
      `Markdown body must contain at most ${MAX_BODY_CODE_POINTS} Unicode code points`,
    );
  }

  // Parse skills.md (optional)
  const normalizedSkills: string[] = [];
  if (existingFileNames.has("skills.md")) {
    try {
      const rawSkills = fs.readFileSync(
        path.join(realDir, "skills.md"),
        "utf8",
      );
      const lines = rawSkills.split(/\r?\n/);
      const seen = new Set<string>();
      for (const rawLine of lines) {
        let trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          trimmed = trimmed.slice(2).trim();
        }
        if (!trimmed) continue;

        const normalized = normalizeSegment(trimmed);
        if (!normalized || normalized !== trimmed) {
          messages.push(`skill ${trimmed} must be a bounded normalized name`);
          continue;
        }
        if (!seen.has(normalized)) {
          seen.add(normalized);
          normalizedSkills.push(normalized);
        }
      }
    } catch (error) {
      messages.push(
        `failed to read skills.md: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (messages.length > 0 || !entry.canonicalId) {
    return {
      errors: messages.map((message) => ({
        file: entry.relativePath,
        message,
      })),
    };
  }

  return {
    entry: {
      id: entry.canonicalId,
      skills: normalizedSkills,
      summary,
      keywords: normalizedKeywords,
      body,
      path: entry.absolutePath,
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
  const scanned = scanExperienceFolders(params.experienceDirectory);
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
  const duplicatePaths = new Map<string, ScannedEntry[]>();
  for (const entry of scanned.entries) {
    if (!entry.canonicalId) continue;
    const duplicates = duplicatePaths.get(entry.canonicalId) ?? [];
    duplicates.push(entry);
    duplicatePaths.set(entry.canonicalId, duplicates);
  }
  const rejectedIds = new Set<string>();
  for (const [id, entries] of duplicatePaths) {
    if (entries.length < 2) continue;
    rejectedIds.add(id);
    for (const entry of entries) {
      errors.push({
        file: entry.relativePath,
        message: `duplicate canonical id ${id}`,
      });
    }
  }

  const entriesById = new Map<string, SkillExperienceEntry[]>();
  for (const entry of scanned.entries) {
    const parsed = parseExperienceFolder(rootReal, entry);
    errors.push(...parsed.errors);
    if (!parsed.entry) continue;
    parsedEntries.push(parsed.entry);
    const duplicates = entriesById.get(parsed.entry.id) ?? [];
    duplicates.push(parsed.entry);
    entriesById.set(parsed.entry.id, duplicates);
  }

  for (const [id, entries] of entriesById) {
    if (entries.length < 2) continue;
    rejectedIds.add(id);
    for (const entry of entries) {
      errors.push({
        file: toRelativePath(
          path.resolve(params.experienceDirectory),
          entry.path,
        ),
        message: `duplicate canonical id ${id}`,
      });
    }
  }

  const visible = visibleSkillNames(params.visibleSkillsByAgent);
  const validEntries: SkillExperienceEntry[] = [];
  for (const entry of parsedEntries) {
    if (rejectedIds.has(entry.id)) continue;
    let skillError = false;
    for (const skill of entry.skills) {
      if (!visible.has(skill)) {
        errors.push({
          file: toRelativePath(
            path.resolve(params.experienceDirectory),
            entry.path,
          ),
          message: `skill ${skill} is not visible to any configured agent`,
        });
        skillError = true;
      }
    }
    if (!skillError) {
      validEntries.push(entry);
    }
  }

  validEntries.sort((left, right) => left.id.localeCompare(right.id, "en"));
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
  const scanned = scanExperienceFolders(experienceDirectory);
  if (!fs.existsSync(experienceDirectory)) return [];

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(experienceDirectory));
  } catch {
    return [];
  }

  const byId = new Map<string, SkillExperienceEntry[]>();
  for (const entry of scanned.entries) {
    const parsed = parseExperienceFolder(rootReal, entry);
    if (!parsed.entry || parsed.errors.length > 0) continue;
    const entries = byId.get(parsed.entry.id) ?? [];
    entries.push(parsed.entry);
    byId.set(parsed.entry.id, entries);
  }

  return [...byId.values()]
    .filter((entries) => entries.length === 1)
    .map(([entry]) => entry)
    .filter((entry): entry is SkillExperienceEntry => Boolean(entry))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
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
  const id = normalizeForComparison(entry.id);
  const keywords = entry.keywords.map(normalizeForComparison);
  const skills = entry.skills.map(normalizeForComparison);
  return [
    id === query || skills.includes(query) ? 1 : 0,
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

  constructor(dataRoot: string) {
    this.experienceDirectory = experiencesPath(path.resolve(dataRoot));
  }

  listAll(): SkillExperienceEntry[] {
    return readCatalogEntries(this.experienceDirectory);
  }

  listForSkills(skillNames: readonly string[]): SkillExperienceEntry[] {
    const requested = new Set(
      skillNames
        .map(normalizeSegment)
        .filter((skillName): skillName is string => Boolean(skillName)),
    );
    if (requested.size === 0) return [];
    return readCatalogEntries(this.experienceDirectory).filter((entry) =>
      entry.skills.some((skill) => requested.has(skill)),
    );
  }

  resolve(id: string): SkillExperienceEntry | undefined {
    const canonicalId = normalizeSegment(id);
    if (!canonicalId) return;
    return readCatalogEntries(this.experienceDirectory).find(
      (entry) => entry.id === canonicalId,
    );
  }

  search(params: ExperienceSearchParams): SkillExperienceEntry[] {
    const entries =
      params.skills !== undefined
        ? this.listForSkills(params.skills)
        : this.listAll();
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
          left.entry.id.localeCompare(right.entry.id, "en"),
      )
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
}
