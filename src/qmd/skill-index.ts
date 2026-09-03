import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { createStore, QMDStore } from "@wei840222/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import { withFileLock } from "../file-utils.js";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import { weightedReciprocalRankFusion } from "./rrf.js";

const META_COLLECTION = "skill-meta";
const BODY_COLLECTION = "skill-body";
const REFS_COLLECTION = "skill-references";
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_CANDIDATE_LIMIT = 40;
const MAX_EVIDENCE_PER_SKILL = 3;
const BUILD_LOCK_BUSY = "BUILD_LOCK_BUSY";

class IncompleteEmbeddingBuildError extends Error {
  readonly preserveGeneration = true;

  constructor(params: { errors: number; needsEmbedding: number }) {
    super(
      `QMD skill index embedding is incomplete (errors=${params.errors}, needsEmbedding=${params.needsEmbedding}).`,
    );
    this.name = "IncompleteEmbeddingBuildError";
  }
}

type QmdCreateStore = typeof createStore;

type SQLiteBackupDatabase = {
  backup(targetPath: string): Promise<unknown>;
};

type ActiveGeneration = {
  generation: string;
  fingerprint: string;
};

type CollectionKind = "meta" | "body" | "reference";

type SearchHit = {
  skillName: string;
  collection: string;
  path: string;
  score: number;
  snippet?: string;
  explain?: unknown;
};

export type SkillQmdEvidence = {
  collection: string;
  path: string;
  score: number;
  snippet?: string;
  explain?: unknown;
};

export type SkillQmdSearchHit = {
  name: string;
  score: number;
  evidence?: SkillQmdEvidence[];
};

export type SkillQmdIndexStatus = "idle" | "building" | "ready" | "failed";

export interface SkillQmdIndex {
  schedule(agentId: string, skills: readonly AvailableSkill[]): void;
  search(params: {
    agentId: string;
    query: string;
    limit: number;
    includeEvidence?: boolean;
  }): Promise<SkillQmdSearchHit[] | undefined>;
  getStatus(agentId: string): SkillQmdIndexStatus;
  close(): Promise<void>;
}

type AgentState = {
  status: SkillQmdIndexStatus;
  store?: QMDStore;
  generationRoot?: string;
  docsRoot?: string;
  currentFingerprint?: string;
  expectedFingerprint?: string;
  desired?: {
    fingerprint: string;
    skills: readonly AvailableSkill[];
  };
  running?: Promise<void>;
  failedFingerprint?: string;
  consecutiveFailures: number;
  nextRetryAtMs: number;
  generation: number;
  retryTimer?: unknown;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function resolveConfinedPath(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    const rootReal = await fs.realpath(root);
    const candidateReal = await fs.realpath(candidate);
    if (!isPathInside(rootReal, candidateReal)) return;
    return candidateReal;
  } catch {
    return;
  }
}

const COLLECTION_DIR_BY_NAME: Record<string, string> = {
  [META_COLLECTION]: "meta",
  [BODY_COLLECTION]: "body",
  [REFS_COLLECTION]: "references",
};

function decodeSkillSegment(encodedSkill: string): string {
  try {
    return decodeURIComponent(encodedSkill);
  } catch {
    return encodedSkill;
  }
}

function identityFromCollectionRelativePath(params: {
  collection: string;
  relativeWithinCollection: string;
}): { skillName?: string; relativePath?: string } {
  const parts = params.relativeWithinCollection.split("/").filter(Boolean);
  if (parts.length < 1) return {};
  const [encodedSkill, ...rest] = parts;
  if (!encodedSkill) return {};
  const skillName = decodeSkillSegment(encodedSkill);
  const remainder = rest.join("/");
  if (remainder) {
    return {
      skillName,
      relativePath:
        params.collection === REFS_COLLECTION
          ? `references/${remainder}`
          : remainder,
    };
  }
  if (params.collection === META_COLLECTION) {
    return { skillName, relativePath: "meta.md" };
  }
  if (params.collection === BODY_COLLECTION) {
    return { skillName, relativePath: "SKILL.md" };
  }
  return { skillName, relativePath: "references/unknown" };
}

function identityFromQmdVirtualPath(params: {
  filepath: string;
  collection: string;
}): { skillName?: string; relativePath?: string } {
  const match = /^qmd:\/\/([^/]+)\/(.*)$/.exec(params.filepath);
  if (!match) return {};
  const virtualCollection = match[1] ?? "";
  const relativeWithinCollection = match[2] ?? "";
  if (!COLLECTION_DIR_BY_NAME[virtualCollection]) return {};
  // Prefer the virtual collection from the QMD hit; fall back to the search filter.
  return identityFromCollectionRelativePath({
    collection: virtualCollection || params.collection,
    relativeWithinCollection,
  });
}

export function skillIdentityFromDocsPath(params: {
  docsRoot: string;
  filepath: string;
  collection: string;
}): { skillName?: string; relativePath?: string } {
  const fromVirtual = identityFromQmdVirtualPath(params);
  if (fromVirtual.skillName) return fromVirtual;

  // QMD hybrid hits often expose collection-relative displayPath values like
  // "openclaw/meta.md" alongside qmd:// virtual filepath values.
  if (
    !params.filepath.includes("://") &&
    !path.isAbsolute(params.filepath) &&
    !params.filepath.startsWith("meta/") &&
    !params.filepath.startsWith("body/") &&
    !params.filepath.startsWith("references/")
  ) {
    const fromDisplay = identityFromCollectionRelativePath({
      collection: params.collection,
      relativeWithinCollection: params.filepath.split(path.sep).join("/"),
    });
    if (fromDisplay.skillName) return fromDisplay;
  }

  const relative = path
    .relative(params.docsRoot, params.filepath)
    .split(path.sep)
    .join("/");
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return {};
  }
  const parts = relative.split("/").filter(Boolean);
  if (parts.length < 2) return {};
  const [collectionDir, encodedSkill, ...rest] = parts;
  if (
    collectionDir !== "meta" &&
    collectionDir !== "body" &&
    collectionDir !== "references"
  ) {
    return {};
  }
  return identityFromCollectionRelativePath({
    collection: params.collection,
    relativeWithinCollection: [encodedSkill, ...rest].join("/"),
  });
}

export function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "_";
  const encoded = encodeURIComponent(trimmed)
    .replaceAll("*", "%2A")
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll(".", "%2E");
  return encoded.length <= 180 ? encoded : `${hash(trimmed).slice(0, 24)}`;
}

async function listReferenceFiles(skillDir: string): Promise<string[]> {
  const referencesRoot = path.join(skillDir, "references");
  const confinedRoot = await resolveConfinedPath(skillDir, referencesRoot);
  if (!confinedRoot) return [];
  const rootReal = confinedRoot;
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await resolveConfinedPath(rootReal, entryPath))) {
          continue;
        }
        await walk(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!(await resolveConfinedPath(rootReal, entryPath))) {
          continue;
        }
        files.push(
          path.relative(referencesRoot, entryPath).split(path.sep).join("/"),
        );
      }
    }
  }

  await walk(referencesRoot);
  return files;
}

async function referenceFingerprint(skillDir: string): Promise<string[]> {
  const files = await listReferenceFiles(skillDir);
  const identities: string[] = [];
  for (const relative of files) {
    try {
      const absolute = path.join(skillDir, "references", relative);
      const raw = await fs.readFile(absolute);
      identities.push(`${relative}:${hash(raw.toString("utf8"))}`);
    } catch {
      identities.push(`${relative}:missing`);
    }
  }
  return identities;
}

async function snapshotFingerprint(
  skills: readonly AvailableSkill[],
  config: ResolvedQmdConfig,
): Promise<string> {
  const ordered = [...skills].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const skillEntries = await Promise.all(
    ordered.map(async (skill) => {
      let bodyHash = "missing";
      try {
        bodyHash = hash(await fs.readFile(skill.location, "utf8"));
      } catch {
        bodyHash = "missing";
      }
      return {
        name: skill.name,
        description: skill.description,
        bodyHash,
        references: await referenceFingerprint(path.dirname(skill.location)),
      };
    }),
  );
  return hash(
    JSON.stringify({
      skills: skillEntries,
      embedding: {
        model: config.embedding.model,
        dimension: config.embedding.dimension,
      },
    }),
  );
}

function stripMarkdownFrontmatter(raw: string): string {
  try {
    return matter(raw).content.trim();
  } catch {
    return raw.trim();
  }
}

function normalizeIndexedContent(content: string): string {
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

function identitySidecarBody(params: {
  skill: AvailableSkill;
  kind: CollectionKind;
  relativePath: string;
}): string {
  return matter.stringify("", {
    skill: params.skill.name,
    source: params.skill.source ?? "extra",
    kind: params.kind,
    path: params.relativePath,
  });
}

async function writeIndexedDocument(params: {
  contentPath: string;
  skill: AvailableSkill;
  kind: CollectionKind;
  relativePath: string;
  content: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.contentPath), { recursive: true });
  const content = normalizeIndexedContent(params.content);
  const identity = identitySidecarBody({
    skill: params.skill,
    kind: params.kind,
    relativePath: params.relativePath,
  });
  const writeIfChanged = async (target: string, next: string) => {
    try {
      if ((await fs.readFile(target, "utf8")) === next) return;
    } catch {
      // New documents are written below.
    }
    await fs.writeFile(target, next, "utf8");
  };
  await Promise.all([
    writeIfChanged(params.contentPath, content),
    writeIfChanged(`${params.contentPath}.identity.yml`, identity),
  ]);
}

function skillSnapshotCollections(
  docsRoot: string,
): Record<string, { path: string; pattern: string; ignore?: string[] }> {
  return {
    [META_COLLECTION]: {
      path: path.join(docsRoot, "meta"),
      pattern: "**/meta.md",
    },
    [BODY_COLLECTION]: {
      path: path.join(docsRoot, "body"),
      pattern: "**/SKILL.md",
    },
    [REFS_COLLECTION]: {
      path: path.join(docsRoot, "references"),
      pattern: "**/*",
      ignore: ["**/*.identity.yml"],
    },
  };
}

async function removeStaleSnapshotDocuments(
  docsRoot: string,
  expected: ReadonlySet<string>,
): Promise<void> {
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(target);
          const children = await fs.readdir(target).catch(() => []);
          if (children.length === 0) await fs.rmdir(target).catch(() => undefined);
          return;
        }
        const relative = path.relative(docsRoot, target).split(path.sep).join("/");
        const contentRelative = relative.endsWith(".identity.yml")
          ? relative.slice(0, -".identity.yml".length)
          : relative;
        if (!expected.has(contentRelative)) await fs.rm(target, { force: true });
      }),
    );
  }
  await visit(docsRoot);
}

export async function writeSkillSnapshot(params: {
  docsRoot: string;
  skills: readonly AvailableSkill[];
}): Promise<
  Record<string, { path: string; pattern: string; ignore?: string[] }>
> {
  const metaRoot = path.join(params.docsRoot, "meta");
  const bodyRoot = path.join(params.docsRoot, "body");
  const referencesRoot = path.join(params.docsRoot, "references");
  await Promise.all([
    fs.mkdir(metaRoot, { recursive: true }),
    fs.mkdir(bodyRoot, { recursive: true }),
    fs.mkdir(referencesRoot, { recursive: true }),
  ]);

  const expected = new Set<string>();
  for (const skill of params.skills) {
    const skillSegment = safePathSegment(skill.name);
    const skillDir = path.dirname(skill.location);
    const metaPath = path.join(metaRoot, skillSegment, "meta.md");
    const bodyPath = path.join(bodyRoot, skillSegment, "SKILL.md");
    expected.add(`meta/${skillSegment}/meta.md`);
    expected.add(`body/${skillSegment}/SKILL.md`);
    await writeIndexedDocument({
      contentPath: metaPath,
      skill,
      kind: "meta",
      relativePath: "meta.md",
      content: `# ${skill.name}\n\n${skill.description}`.trim(),
    });

    let bodyContent = "";
    try {
      bodyContent = await fs.readFile(skill.location, "utf8");
    } catch (error) {
      logger.warn("failed to read skill body for QMD snapshot", {
        error,
        skill: skill.name,
        location: skill.location,
      });
      bodyContent = skill.description;
    }
    await writeIndexedDocument({
      contentPath: bodyPath,
      skill,
      kind: "body",
      relativePath: "SKILL.md",
      content: stripMarkdownFrontmatter(bodyContent),
    });

    for (const relative of await listReferenceFiles(skillDir)) {
      const sourcePath = path.join(skillDir, "references", relative);
      const confinedSource = await resolveConfinedPath(skillDir, sourcePath);
      if (!confinedSource) continue;
      const targetPath = path.join(referencesRoot, skillSegment, relative);
      expected.add(`references/${skillSegment}/${relative}`);
      let content = "";
      try {
        content = await fs.readFile(confinedSource, "utf8");
      } catch (error) {
        logger.warn("failed to read skill reference for QMD snapshot", {
          error,
          skill: skill.name,
          path: relative,
        });
        continue;
      }
      await writeIndexedDocument({
        contentPath: targetPath,
        skill,
        kind: "reference",
        relativePath: `references/${relative}`,
        content: stripMarkdownFrontmatter(content),
      });
    }
  }

  await removeStaleSnapshotDocuments(params.docsRoot, expected);
  return skillSnapshotCollections(params.docsRoot);
}

function parseFrontmatterIdentity(raw: string | undefined): {
  skillName?: string;
  relativePath?: string;
  snippet?: string;
} {
  if (!raw) return {};
  try {
    const parsed = matter(raw);
    return {
      skillName:
        typeof parsed.data.skill === "string"
          ? parsed.data.skill.trim()
          : undefined,
      relativePath:
        typeof parsed.data.path === "string"
          ? parsed.data.path.trim()
          : undefined,
      snippet: parsed.content.trim().slice(0, 240) || undefined,
    };
  } catch {
    return {};
  }
}

function hitId(
  hit: Pick<SearchHit, "skillName" | "collection" | "path">,
): string {
  return `${hit.skillName}\u0000${hit.collection}\u0000${hit.path}`;
}

function parseStoreHits(params: {
  results: readonly {
    body?: string;
    filepath?: string;
    file?: string;
    displayPath?: string;
    score: number;
    explain?: unknown;
  }[];
  collection: string;
  docsRoot?: string;
}): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const result of params.results) {
    if (!Number.isFinite(result.score)) continue;
    const fromBody = parseFrontmatterIdentity(result.body);
    let skillName = fromBody.skillName;
    let relativePath = fromBody.relativePath;
    const pathCandidates = [
      result.filepath,
      result.file,
      result.displayPath,
    ].filter((value): value is string => Boolean(value));
    if ((!skillName || !relativePath) && params.docsRoot) {
      for (const filepath of pathCandidates) {
        const fromPath = skillIdentityFromDocsPath({
          docsRoot: params.docsRoot,
          filepath,
          collection: params.collection,
        });
        skillName = skillName ?? fromPath.skillName;
        relativePath = relativePath ?? fromPath.relativePath;
        if (skillName && relativePath) break;
      }
    }
    if (!skillName) continue;
    hits.push({
      skillName,
      collection: params.collection,
      path: relativePath ?? "unknown",
      score: result.score,
      ...(fromBody.snippet ? { snippet: fromBody.snippet } : {}),
      ...(result.explain === undefined ? {} : { explain: result.explain }),
    });
  }
  return hits;
}

export function createSkillQmdIndex(params: {
  dataRoot: string;
  config: () => ResolvedQmdConfig;
  createStore?: QmdCreateStore;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): SkillQmdIndex {
  const agents = new Map<string, AgentState>();
  const now = () => params.nowMs?.() ?? Date.now();
  const setTimer =
    params.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    params.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  function agentRoot(agentId: string): string {
    return path.join(
      params.dataRoot,
      "qmd",
      "skills",
      safePathSegment(agentId),
    );
  }

  function activeGenerationPath(agentId: string): string {
    return path.join(agentRoot(agentId), "active.json");
  }

  async function readActiveGeneration(
    agentId: string,
  ): Promise<{ generationRoot: string; docsRoot: string } | undefined> {
    try {
      const active = JSON.parse(
        await fs.readFile(activeGenerationPath(agentId), "utf8"),
      ) as Partial<ActiveGeneration>;
      if (!active.generation || !active.fingerprint) return;
      const generationRoot = path.join(agentRoot(agentId), active.generation);
      const docsRoot = path.join(generationRoot, "docs");
      await Promise.all([
        fs.access(path.join(generationRoot, "skill-search.sqlite")),
        fs.access(docsRoot),
      ]);
      return { generationRoot, docsRoot };
    } catch {
      return;
    }
  }

  async function writeActiveGeneration(
    agentId: string,
    generationRoot: string,
    fingerprint: string,
  ): Promise<void> {
    const target = activeGenerationPath(agentId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({ generation: path.basename(generationRoot), fingerprint }),
      "utf8",
    );
    await fs.rename(temporary, target);
  }

  async function cloneGeneration(params: {
    source: { generationRoot: string; docsRoot: string };
    targetRoot: string;
    sourceStore?: QMDStore;
    createStore?: QmdCreateStore;
  }): Promise<void> {
    await fs.mkdir(params.targetRoot, { recursive: true });
    const targetDbPath = path.join(params.targetRoot, "skill-search.sqlite");
    let sourceStore = params.sourceStore;
    try {
      if (!sourceStore) {
        const createQmdStore =
          params.createStore ?? (await import("@wei840222/qmd")).createStore;
        sourceStore = await createQmdStore({
          dbPath: path.join(params.source.generationRoot, "skill-search.sqlite"),
          readOnly: true,
        });
      }
      if (!sourceStore) throw new Error("missing skill generation source store");
      const database = sourceStore.internal?.db as unknown as
        | SQLiteBackupDatabase
        | undefined;
      if (database) await database.backup(targetDbPath);
      await fs.cp(params.source.docsRoot, path.join(params.targetRoot, "docs"), {
        recursive: true,
      });
    } finally {
      if (sourceStore && sourceStore !== params.sourceStore) {
        await sourceStore.close().catch(() => undefined);
      }
    }
  }

  async function clearOrphanGenerations(
    agentId: string,
    keepRoots: readonly string[] = [],
  ): Promise<void> {
    const root = agentRoot(agentId);
    const resolvedKeepRoots = new Set(
      keepRoots.map((entry) => path.resolve(entry)),
    );
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !entry.name.startsWith("gen-")) return;
        const candidate = path.join(root, entry.name);
        if (resolvedKeepRoots.has(path.resolve(candidate))) {
          return;
        }
        await fs
          .rm(candidate, { recursive: true, force: true })
          .catch(() => undefined);
      }),
    );
  }

  async function findReusableGeneration(
    agentId: string,
    fingerprint: string,
  ): Promise<{ generationRoot: string; docsRoot: string } | undefined> {
    const root = agentRoot(agentId);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    const suffix = `-${fingerprint.slice(0, 12)}`;
    const candidates = entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of candidates) {
      const generationRoot = path.join(root, entry.name);
      const docsRoot = path.join(generationRoot, "docs");
      try {
        await Promise.all([
          fs.access(path.join(generationRoot, "skill-search.sqlite")),
          fs.access(docsRoot),
        ]);
        return { generationRoot, docsRoot };
      } catch {
        // A stale directory will be removed by the fresh-build path below.
      }
    }
  }

  function getState(agentId: string): AgentState {
    const existing = agents.get(agentId);
    if (existing) return existing;
    const created: AgentState = {
      status: "idle",
      consecutiveFailures: 0,
      nextRetryAtMs: 0,
      generation: 0,
    };
    agents.set(agentId, created);
    return created;
  }

  function clearRetryTimer(state: AgentState): void {
    if (state.retryTimer === undefined) return;
    clearTimer(state.retryTimer);
    state.retryTimer = undefined;
  }

  function resetRetryState(state: AgentState): void {
    clearRetryTimer(state);
    state.failedFingerprint = undefined;
    state.consecutiveFailures = 0;
    state.nextRetryAtMs = 0;
  }

  function isRetryableBuildError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code =
      "code" in error && error.code !== undefined ? String(error.code) : "";
    if (code === "LEASE_BUSY" || code === BUILD_LOCK_BUSY) return true;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("LEASE_BUSY") || message.includes(BUILD_LOCK_BUSY);
  }

  function preservesGeneration(error: unknown): boolean {
    return (
      error instanceof IncompleteEmbeddingBuildError ||
      (typeof error === "object" &&
        error !== null &&
        "preserveGeneration" in error &&
        error.preserveGeneration === true)
    );
  }

  function armRetryResume(
    agentId: string,
    state: AgentState,
    target: { fingerprint: string; skills: readonly AvailableSkill[] },
  ): void {
    if (state.retryTimer !== undefined) return;
    const delayMs = Math.max(0, state.nextRetryAtMs - now());
    state.retryTimer = setTimer(() => {
      state.retryTimer = undefined;
      if (state.desired && state.desired.fingerprint !== target.fingerprint) {
        maybeStart(agentId, state);
        return;
      }
      state.desired = {
        fingerprint: target.fingerprint,
        skills: [...target.skills],
      };
      maybeStart(agentId, state);
    }, delayMs);
  }

  function recordBuildFailure(
    state: AgentState,
    fingerprint: string,
    error: unknown,
  ): void {
    state.consecutiveFailures =
      state.failedFingerprint === fingerprint
        ? state.consecutiveFailures + 1
        : 1;
    state.failedFingerprint = fingerprint;
    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (state.consecutiveFailures - 1),
      MAX_RETRY_DELAY_MS,
    );
    state.nextRetryAtMs = now() + delayMs;
    state.status = state.store ? "ready" : "failed";
    logger.warn("failed to refresh QMD skill index", { error, delayMs });
  }

  async function nextGenerationNumber(agentId: string): Promise<number> {
    const root = agentRoot(agentId);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return 1;
      }
      throw error;
    }
    let maxGeneration = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("gen-")) continue;
      const match = /^gen-(\d+)-/.exec(entry.name);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > maxGeneration) {
        maxGeneration = value;
      }
    }
    return maxGeneration + 1;
  }

  async function build(
    agentId: string,
    state: AgentState,
    target: { fingerprint: string; skills: readonly AvailableSkill[] },
  ): Promise<void> {
    clearRetryTimer(state);
    state.status = "building";
    const root = agentRoot(agentId);
    let generationRoot = "";
    let nextStore: QMDStore | undefined;

    const locked = await withFileLock(
      root,
      async () => {
        try {
          const qmd = params.config();
          if (
            !qmd.embedding.baseUrl ||
            !qmd.embedding.model ||
            !qmd.expansion.baseUrl ||
            !qmd.expansion.model
          ) {
            throw new Error(
              "QMD embedding and expansion endpoints must be configured.",
            );
          }
          const reusable = await findReusableGeneration(
            agentId,
            target.fingerprint,
          );
          if (reusable) {
            generationRoot = reusable.generationRoot;
          } else {
            const generation = await nextGenerationNumber(agentId);
            state.generation = generation;
            generationRoot = path.join(
              root,
              `gen-${generation}-${target.fingerprint.slice(0, 12)}`,
            );
            const previous = state.generationRoot && state.docsRoot
              ? { generationRoot: state.generationRoot, docsRoot: state.docsRoot }
              : await readActiveGeneration(agentId);
            await clearOrphanGenerations(
              agentId,
              previous ? [previous.generationRoot] : [],
            );
            if (previous) {
              await cloneGeneration({
                source: previous,
                targetRoot: generationRoot,
                sourceStore:
                  previous.generationRoot === state.generationRoot
                    ? state.store
                    : undefined,
                createStore: params.createStore,
              });
            } else {
              await fs.mkdir(generationRoot, { recursive: true });
            }
          }
          const docsRoot =
            reusable?.docsRoot ?? path.join(generationRoot, "docs");
          const collections = reusable
            ? skillSnapshotCollections(docsRoot)
            : await writeSkillSnapshot({
                docsRoot,
                skills: target.skills,
              });
          // Dynamic import keeps tests able to inject createStore without loading
          // the native QMD package at module evaluation time.
          const createQmdStore =
            params.createStore ?? (await import("@wei840222/qmd")).createStore;
          nextStore = await createQmdStore({
            dbPath: path.join(generationRoot, "skill-search.sqlite"),
            config: {
              collections,
              models: {
                embed_api_url: qmd.embedding.baseUrl,
                embed_api_model: qmd.embedding.model,
                ...(qmd.embedding.apiKey
                  ? { embed_api_key: qmd.embedding.apiKey }
                  : {}),
                ...(qmd.embedding.dimension
                  ? { embed_dimension: qmd.embedding.dimension }
                  : {}),
                generate_api_url: qmd.expansion.baseUrl,
                generate_api_model: qmd.expansion.model,
                ...(qmd.expansion.apiKey
                  ? { generate_api_key: qmd.expansion.apiKey }
                  : {}),
              },
            },
            remoteRequestTimeoutMs: qmd.timeoutMs,
          });
          await nextStore.update();
          const embedResult = await nextStore.embed();
          const status = await nextStore.getStatus();
          if (embedResult.errors > 0 || status.needsEmbedding > 0) {
            throw new IncompleteEmbeddingBuildError({
              errors: embedResult.errors,
              needsEmbedding: status.needsEmbedding,
            });
          }

          if (
            state.desired &&
            state.desired.fingerprint !== target.fingerprint
          ) {
            await nextStore.close();
            await fs
              .rm(generationRoot, { recursive: true, force: true })
              .catch(() => undefined);
            return true;
          }

          const previousStore = state.store;
          const previousRoot = state.generationRoot;
          await writeActiveGeneration(agentId, generationRoot, target.fingerprint);
          state.store = nextStore;
          state.generationRoot = generationRoot;
          state.docsRoot = docsRoot;
          state.currentFingerprint = target.fingerprint;
          state.status = "ready";
          resetRetryState(state);
          if (previousStore) {
            await previousStore.close().catch((error: unknown) => {
              logger.warn("failed to close previous QMD skill index", {
                error,
              });
            });
          }
          if (previousRoot && previousRoot !== generationRoot) {
            await fs
              .rm(previousRoot, { recursive: true, force: true })
              .catch(() => undefined);
          }
          nextStore = undefined;
          return true;
        } catch (error) {
          if (nextStore) await nextStore.close().catch(() => undefined);
          nextStore = undefined;
          if (
            !(generationRoot && preservesGeneration(error)) &&
            generationRoot
          ) {
            await fs
              .rm(generationRoot, { recursive: true, force: true })
              .catch(() => undefined);
          }
          recordBuildFailure(state, target.fingerprint, error);
          if (preservesGeneration(error) || isRetryableBuildError(error)) {
            armRetryResume(agentId, state, target);
          }
          return true;
        }
      },
      // Embedding a full skill corpus can take minutes; wait for the peer build
      // instead of racing clearOrphanGenerations against its generation root.
      { maxWaitMs: 30 * 60 * 1000 },
    );

    if (locked === undefined) {
      const error = Object.assign(new Error("skill index build lock is busy"), {
        code: BUILD_LOCK_BUSY,
      });
      recordBuildFailure(state, target.fingerprint, error);
      armRetryResume(agentId, state, target);
    }
  }

  async function runWorker(agentId: string, state: AgentState): Promise<void> {
    try {
      while (state.desired) {
        const target = state.desired;
        state.desired = undefined;
        await build(agentId, state, target);
      }
    } finally {
      state.running = undefined;
    }
  }

  function maybeStart(agentId: string, state: AgentState): void {
    if (state.running || !state.desired) return;
    state.running = runWorker(agentId, state);
  }

  function scheduleLocked(
    agentId: string,
    skills: readonly AvailableSkill[],
  ): void {
    const state = getState(agentId);
    void (async () => {
      const fingerprint = await snapshotFingerprint(skills, params.config());
      if (
        fingerprint === state.currentFingerprint &&
        !state.desired &&
        state.store
      ) {
        state.expectedFingerprint = fingerprint;
        return;
      }
      state.expectedFingerprint = fingerprint;
      if (
        state.failedFingerprint === fingerprint &&
        now() < state.nextRetryAtMs
      ) {
        return;
      }

      state.desired = { fingerprint, skills: [...skills] };
      maybeStart(agentId, state);
    })().catch((error: unknown) => {
      logger.warn("failed to schedule QMD skill index", { error, agentId });
    });
  }

  return {
    schedule(agentId, skills) {
      scheduleLocked(agentId.trim() || "main", skills);
    },
    async search({ agentId, query, limit, includeEvidence }) {
      const state = agents.get(agentId.trim() || "main");
      const activeStore = state?.store;
      if (!activeStore) return;

      const qmd = params.config();
      const candidateLimit = Math.max(limit, DEFAULT_CANDIDATE_LIMIT);
      const collections = [
        {
          name: META_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.meta,
        },
        {
          name: BODY_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.body,
        },
        {
          name: REFS_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.references,
        },
      ];

      try {
        const collectionHits = await Promise.all(
          collections.map(async (collection) => {
            const results = await activeStore.search({
              query,
              collection: collection.name,
              limit: candidateLimit,
              candidateLimit,
              rerank: false,
              includeHyde: false,
              minScore: 0,
            });
            const ranked = parseStoreHits({
              results: results as Array<{
                filepath?: string;
                file?: string;
                displayPath?: string;
                body?: string;
                score: number;
                explain?: unknown;
              }>,
              collection: collection.name,
              docsRoot: state.docsRoot,
            }).sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              return hitId(left).localeCompare(hitId(right));
            });
            return { collection, ranked };
          }),
        );

        const fused = weightedReciprocalRankFusion({
          lists: collectionHits.map((entry) =>
            entry.ranked.map((hit) => ({ id: hitId(hit) })),
          ),
          weights: collectionHits.map((entry) => entry.collection.weight),
        });

        const hitById = new Map<string, SearchHit>();
        for (const entry of collectionHits) {
          for (const hit of entry.ranked) {
            hitById.set(hitId(hit), hit);
          }
        }

        const bestBySkill = new Map<
          string,
          { score: number; evidence: SkillQmdEvidence[] }
        >();
        for (const fusedHit of fused) {
          const hit = hitById.get(fusedHit.id);
          if (!hit) continue;
          const evidence: SkillQmdEvidence = {
            collection: hit.collection,
            path: hit.path,
            score: fusedHit.score,
            ...(hit.snippet ? { snippet: hit.snippet } : {}),
            ...(hit.explain === undefined ? {} : { explain: hit.explain }),
          };
          const existing = bestBySkill.get(hit.skillName);
          if (!existing) {
            bestBySkill.set(hit.skillName, {
              score: fusedHit.score,
              evidence: [evidence],
            });
            continue;
          }
          if (fusedHit.score > existing.score) {
            existing.score = fusedHit.score;
          }
          existing.evidence.push(evidence);
          existing.evidence.sort((left, right) => right.score - left.score);
          if (existing.evidence.length > MAX_EVIDENCE_PER_SKILL) {
            existing.evidence.length = MAX_EVIDENCE_PER_SKILL;
          }
        }

        return [...bestBySkill.entries()]
          .map(([name, value]) => ({
            name,
            score: value.score,
            ...(includeEvidence ? { evidence: value.evidence } : {}),
          }))
          .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return left.name.localeCompare(right.name);
          })
          .slice(0, Math.max(1, limit));
      } catch (error) {
        logger.warn("QMD skill search failed", { error, agentId });
        return;
      }
    },
    getStatus(agentId) {
      return agents.get(agentId.trim() || "main")?.status ?? "idle";
    },
    async close() {
      for (const state of agents.values()) {
        state.desired = undefined;
        clearRetryTimer(state);
      }
      await Promise.all(
        [...agents.values()]
          .map((state) => state.running)
          .filter((running): running is Promise<void> => running !== undefined),
      );
      for (const [agentId, state] of agents.entries()) {
        const activeStore = state.store;
        state.store = undefined;
        state.docsRoot = undefined;
        state.currentFingerprint = undefined;
        state.expectedFingerprint = undefined;
        resetRetryState(state);
        state.status = "idle";
        if (activeStore) await activeStore.close().catch(() => undefined);
        if (state.generationRoot) {
          await fs
            .rm(state.generationRoot, { recursive: true, force: true })
            .catch(() => undefined);
        }
        await fs
          .rm(agentRoot(agentId), { recursive: true, force: true })
          .catch(() => undefined);
      }
      agents.clear();
    },
  };
}
