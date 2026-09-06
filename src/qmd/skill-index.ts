import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { createStore, QMDStore } from "@wei840222/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import { withFileLock } from "../file-utils.js";
import type { AvailableSkill } from "../skills/types.js";
import type {
  ResolvedQmdConfig,
  ResolvedSkillHarnessPluginConfig,
  ResolvedSkillsConfig,
} from "../types.js";
import { normalizeEmbeddingModel } from "./provider-resolver.js";
import { weightedReciprocalRankFusion } from "./rrf.js";

const META_COLLECTION = "skill-meta";
const BODY_COLLECTION = "skill-body";
const REFS_COLLECTION = "skill-references";
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_CANDIDATE_LIMIT = 40;
const MAX_EVIDENCE_PER_SKILL = 3;
const BUILD_LOCK_BUSY = "BUILD_LOCK_BUSY";

type QmdCreateStore = typeof createStore;

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
  schedule(agentId: string, input: SkillQmdScheduleInput): void;
  search(params: {
    agentId: string;
    query: string;
    limit: number;
    includeEvidence?: boolean;
  }): Promise<SkillQmdSearchHit[] | undefined>;
  getStatus(agentId: string): SkillQmdIndexStatus;
  close(): Promise<void>;
}

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
          if (children.length === 0)
            await fs.rmdir(target).catch(() => undefined);
          return;
        }
        const relative = path
          .relative(docsRoot, target)
          .split(path.sep)
          .join("/");
        const contentRelative = relative.endsWith(".identity.yml")
          ? relative.slice(0, -".identity.yml".length)
          : relative;
        if (!expected.has(contentRelative))
          await fs.rm(target, { force: true });
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

export type SkillQmdIndexConfigProvider = () =>
  | ResolvedQmdConfig
  | { qmd: ResolvedQmdConfig; skills?: ResolvedSkillsConfig }
  | ResolvedSkillHarnessPluginConfig;

export interface SkillQmdScheduleInput {
  skills: readonly AvailableSkill[];
  sourceRoots: readonly string[];
}

export function skillIndexFingerprint(params: {
  sourceRoots: readonly string[];
  embeddingModel: string;
  embeddingDimension: number;
}): string {
  const sourceRoots = [...new Set(params.sourceRoots.map((root) => path.resolve(root)))].sort();
  return hash(
    JSON.stringify({
      sourceRoots,
      embeddingModel: normalizeEmbeddingModel(params.embeddingModel),
      embeddingDimension: params.embeddingDimension,
    }),
  );
}

type AgentIndexState = {
  fingerprint?: string;
  expectedFingerprint?: string;
  allowedSkillNames: Set<string>;
  scheduling?: Promise<void>;
};

type SharedIndexState = {
  fingerprint: string;
  root: string;
  docsRoot: string;
  databasePath: string;
  sourceRoots: readonly string[];
  status: SkillQmdIndexStatus;
  store?: QMDStore;
  opening?: Promise<QMDStore | undefined>;
  refreshing?: Promise<void>;
  retryTimer?: unknown;
  consecutiveFailures: number;
  nextRetryAtMs: number;
  needsEmbedding: number;
  lastRefreshError?: unknown;
  agentIds: Set<string>;
  skillsByAgent: Map<string, readonly AvailableSkill[]>;
  refreshSignature?: string;
  queuedSignature?: string;
  usable: boolean;
};

function normalizeAgentId(agentId: string): string {
  return agentId.trim().toLowerCase() || "main";
}

function skillSetSignature(skills: readonly AvailableSkill[]): string {
  return hash(
    JSON.stringify(
      [...skills]
        .map((skill) => [skill.name.toLowerCase(), path.resolve(skill.location)])
        .sort((left, right) =>
          (left[0] ?? "").localeCompare(right[0] ?? "") ||
          (left[1] ?? "").localeCompare(right[1] ?? ""),
        ),
    ),
  );
}

export function createSkillQmdIndex(params: {
  dataRoot: string;
  config: SkillQmdIndexConfigProvider;
  createStore?: QmdCreateStore;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): SkillQmdIndex {
  const agents = new Map<string, AgentIndexState>();
  const indexes = new Map<string, SharedIndexState>();
  const skillsRoot = path.join(params.dataRoot, "qmd", "skills");
  const indexesRoot = path.join(skillsRoot, "indexes");
  const mappingsRoot = path.join(skillsRoot, "agents");
  const now = () => params.nowMs?.() ?? Date.now();
  const setTimer =
    params.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    params.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  function config(): { qmd: ResolvedQmdConfig; skills?: ResolvedSkillsConfig } {
    const raw = params.config();
    if ("qmd" in raw) {
      return { qmd: raw.qmd, ...(raw.skills ? { skills: raw.skills } : {}) };
    }
    const skills = "skills" in (raw as Record<string, unknown>)
      ? (raw as ResolvedQmdConfig & { skills?: ResolvedSkillsConfig }).skills
      : undefined;
    return { qmd: raw, ...(skills ? { skills } : {}) };
  }

  function indexState(
    fingerprint: string,
    sourceRoots: readonly string[] = [],
  ): SharedIndexState {
    const existing = indexes.get(fingerprint);
    if (existing) return existing;
    const root = path.join(indexesRoot, fingerprint);
    const created: SharedIndexState = {
      fingerprint,
      root,
      docsRoot: path.join(root, "docs"),
      databasePath: path.join(root, "skill-search.sqlite"),
      sourceRoots: [...sourceRoots],
      status: "idle",
      consecutiveFailures: 0,
      nextRetryAtMs: 0,
      needsEmbedding: 0,
      agentIds: new Set(),
      skillsByAgent: new Map(),
      usable: false,
    };
    indexes.set(fingerprint, created);
    return created;
  }

  function agentState(agentId: string): AgentIndexState {
    const existing = agents.get(agentId);
    if (existing) return existing;
    const created: AgentIndexState = {
      allowedSkillNames: new Set(),
    };
    agents.set(agentId, created);
    return created;
  }

  function mappingPath(agentId: string): string {
    return path.join(mappingsRoot, `${safePathSegment(agentId)}.json`);
  }

  async function writeAgentMapping(
    agentId: string,
    fingerprint: string,
  ): Promise<void> {
    const target = mappingPath(agentId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({
        schemaVersion: 1,
        fingerprint,
        allowedSkillNames: [
          ...(agents.get(agentId)?.allowedSkillNames ?? new Set<string>()),
        ].sort(),
      }),
      "utf8",
    );
    await fs.rename(temporary, target);
  }

  async function loadExistingIndexCatalog(): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(indexesRoot, { withFileTypes: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        logger.warn("failed to load QMD skill index catalog", { error });
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const state = indexState(entry.name);
      try {
        await Promise.all([fs.access(state.databasePath), fs.access(state.docsRoot)]);
        state.status = "ready";
        state.usable = true;
      } catch {
        indexes.delete(entry.name);
      }
    }

    let mappings: Dirent[] = [];
    try {
      mappings = await fs.readdir(mappingsRoot, { withFileTypes: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        logger.warn("failed to load QMD skill agent mappings", { error });
      }
    }
    for (const entry of mappings) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(mappingsRoot, entry.name), "utf8"),
        ) as {
          schemaVersion?: unknown;
          fingerprint?: unknown;
          allowedSkillNames?: unknown;
        };
        if (
          parsed.schemaVersion !== 1 ||
          typeof parsed.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/u.test(parsed.fingerprint)
        ) continue;
        const shared = indexes.get(parsed.fingerprint);
        if (!shared) continue;
        const encodedAgentId = entry.name.slice(0, -".json".length);
        let agentId: string;
        try {
          agentId = decodeURIComponent(encodedAgentId);
        } catch {
          agentId = encodedAgentId;
        }
        const agent = agentState(agentId);
        agent.fingerprint = parsed.fingerprint;
        agent.expectedFingerprint = parsed.fingerprint;
        agent.allowedSkillNames = new Set(
          Array.isArray(parsed.allowedSkillNames)
            ? parsed.allowedSkillNames.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
        );
        shared.agentIds.add(agentId);
      } catch {
        // Invalid mappings fail open and are replaced by the next schedule.
      }
    }
  }

  const initialization = loadExistingIndexCatalog();

  async function createConfiguredStore(
    state: SharedIndexState,
  ): Promise<QMDStore> {
    const { qmd } = config();
    if (
      !qmd.embedding.baseUrl ||
      !qmd.embedding.model ||
      !qmd.expansion.baseUrl ||
      !qmd.expansion.model
    ) {
      throw new Error("QMD embedding and expansion endpoints must be configured.");
    }
    const createQmdStore =
      params.createStore ?? (await import("@wei840222/qmd")).createStore;
    return createQmdStore({
      dbPath: state.databasePath,
      config: {
        collections: skillSnapshotCollections(state.docsRoot),
        models: {
          embed_api_url: qmd.embedding.baseUrl,
          embed_api_model: qmd.embedding.model,
          ...(qmd.embedding.apiKey ? { embed_api_key: qmd.embedding.apiKey } : {}),
          ...(qmd.embedding.dimension ? { embed_dimension: qmd.embedding.dimension } : {}),
          generate_api_url: qmd.expansion.baseUrl,
          generate_api_model: qmd.expansion.model,
          ...(qmd.expansion.apiKey ? { generate_api_key: qmd.expansion.apiKey } : {}),
        },
      },
      remoteRequestTimeoutMs: qmd.timeoutMs,
    });
  }

  function ensureStore(state: SharedIndexState): Promise<QMDStore | undefined> {
    if (state.store) return Promise.resolve(state.store);
    if (state.opening) return state.opening;
    const opening = (async () => {
      try {
        await Promise.all([fs.access(state.databasePath), fs.access(state.docsRoot)]);
        const store = await createConfiguredStore(state);
        state.store = store;
        state.status = "ready";
        return store;
      } catch (error) {
        state.lastRefreshError = error;
        state.status = "failed";
        logger.warn("failed to open persisted QMD skill index", {
          error,
          fingerprint: state.fingerprint,
        });
        return;
      }
    })();
    state.opening = opening;
    void opening.finally(() => {
      if (state.opening === opening) state.opening = undefined;
    });
    return opening;
  }

  function clearRetryTimer(state: SharedIndexState): void {
    if (state.retryTimer === undefined) return;
    clearTimer(state.retryTimer);
    state.retryTimer = undefined;
  }

  function resetRetryState(state: SharedIndexState): void {
    clearRetryTimer(state);
    state.consecutiveFailures = 0;
    state.nextRetryAtMs = 0;
    state.lastRefreshError = undefined;
  }

  function mergedSkills(state: SharedIndexState): readonly AvailableSkill[] {
    const byName = new Map<string, AvailableSkill>();
    for (const skills of state.skillsByAgent.values()) {
      for (const skill of skills) {
        const key = skill.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, skill);
      }
    }
    return [...byName.values()];
  }

  function armRetry(state: SharedIndexState): void {
    if (state.retryTimer !== undefined) return;
    const delayMs = Math.max(0, state.nextRetryAtMs - now());
    state.retryTimer = setTimer(() => {
      state.retryTimer = undefined;
      startRefresh(state);
    }, delayMs);
  }

  function recordRefreshProblem(
    state: SharedIndexState,
    error: unknown,
  ): void {
    state.consecutiveFailures += 1;
    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (state.consecutiveFailures - 1),
      MAX_RETRY_DELAY_MS,
    );
    state.nextRetryAtMs = now() + delayMs;
    state.lastRefreshError = error;
    state.status = state.usable ? "ready" : "failed";
    logger.warn("failed to refresh QMD skill index", {
      error,
      delayMs,
      fingerprint: state.fingerprint,
    });
    armRetry(state);
  }

  async function bindAgents(state: SharedIndexState): Promise<void> {
    await Promise.all(
      [...state.agentIds].map(async (agentId) => {
        const agent = agents.get(agentId);
        if (!agent || agent.expectedFingerprint !== state.fingerprint) return;
        const previousFingerprint = agent.fingerprint;
        agent.fingerprint = state.fingerprint;
        await writeAgentMapping(agentId, state.fingerprint);
        await fs
          .rm(path.join(skillsRoot, safePathSegment(agentId)), {
            recursive: true,
            force: true,
          })
          .catch(() => undefined);
        if (previousFingerprint && previousFingerprint !== state.fingerprint) {
          const previous = indexes.get(previousFingerprint);
          previous?.agentIds.delete(agentId);
          previous?.skillsByAgent.delete(agentId);
        }
      }),
    );
  }

  async function refreshIndex(state: SharedIndexState): Promise<void> {
    clearRetryTimer(state);
    if (!state.store) state.status = "building";
    const locked = await withFileLock(
      state.root,
      async () => {
        try {
          await fs.mkdir(state.root, { recursive: true });
          const skills = mergedSkills(state);
          const collections = await writeSkillSnapshot({
            docsRoot: state.docsRoot,
            skills,
          });
          let store = state.store;
          if (!store) {
            const { qmd } = config();
            const createQmdStore =
              params.createStore ?? (await import("@wei840222/qmd")).createStore;
            store = await createQmdStore({
              dbPath: state.databasePath,
              config: {
                collections,
                models: {
                  embed_api_url: qmd.embedding.baseUrl,
                  embed_api_model: qmd.embedding.model,
                  ...(qmd.embedding.apiKey ? { embed_api_key: qmd.embedding.apiKey } : {}),
                  ...(qmd.embedding.dimension ? { embed_dimension: qmd.embedding.dimension } : {}),
                  generate_api_url: qmd.expansion.baseUrl,
                  generate_api_model: qmd.expansion.model,
                  ...(qmd.expansion.apiKey ? { generate_api_key: qmd.expansion.apiKey } : {}),
                },
              },
              remoteRequestTimeoutMs: qmd.timeoutMs,
            });
            state.store = store;
          }
          await store.update();
          state.usable = true;
          await bindAgents(state);
          state.status = "ready";
          const embedResult = await store.embed();
          const status = await store.getStatus();
          state.needsEmbedding = status.needsEmbedding;
          if (embedResult.errors > 0 || status.needsEmbedding > 0) {
            recordRefreshProblem(
              state,
              new Error(
                `QMD skill embedding incomplete (errors=${embedResult.errors}, needsEmbedding=${status.needsEmbedding})`,
              ),
            );
          } else {
            resetRetryState(state);
          }
          state.status = "ready";
        } catch (error) {
          recordRefreshProblem(state, error);
        }
        return true;
      },
      { maxWaitMs: 30 * 60 * 1000 },
    );
    if (locked === undefined) {
      recordRefreshProblem(
        state,
        Object.assign(new Error("skill index refresh lock is busy"), {
          code: BUILD_LOCK_BUSY,
        }),
      );
    }
  }

  function startRefresh(state: SharedIndexState): void {
    if (state.refreshing) return;
    const signature = skillSetSignature(mergedSkills(state));
    state.refreshSignature = signature;
    const refreshing = refreshIndex(state);
    state.refreshing = refreshing;
    void refreshing.finally(() => {
      if (state.refreshing === refreshing) state.refreshing = undefined;
      if (state.queuedSignature && state.queuedSignature !== state.refreshSignature) {
        state.queuedSignature = undefined;
        startRefresh(state);
      }
    });
  }

  function scheduleLocked(
    agentId: string,
    input: SkillQmdScheduleInput,
  ): void {
    const agent = agentState(agentId);
    agent.allowedSkillNames = new Set(
      input.skills.map((skill) => skill.name.toLowerCase()),
    );
    const scheduling = (async () => {
      await initialization;
      const { qmd } = config();
      const fingerprint = skillIndexFingerprint({
        sourceRoots: input.sourceRoots,
        embeddingModel: qmd.embedding.model,
        embeddingDimension: qmd.embedding.dimension,
      });
      agent.expectedFingerprint = fingerprint;
      const state = indexState(fingerprint, input.sourceRoots);
      state.agentIds.add(agentId);
      state.skillsByAgent.set(agentId, [...input.skills]);
      const signature = skillSetSignature(mergedSkills(state));
      if (state.refreshing) {
        if (signature !== state.refreshSignature) state.queuedSignature = signature;
        return;
      }
      if (state.lastRefreshError && now() < state.nextRetryAtMs) return;
      startRefresh(state);
    })();
    agent.scheduling = scheduling;
    void scheduling
      .catch((error: unknown) => {
        logger.warn("failed to schedule QMD skill index", { error, agentId });
      })
      .finally(() => {
        if (agent.scheduling === scheduling) agent.scheduling = undefined;
      });
  }

  return {
    schedule(agentId, input) {
      scheduleLocked(normalizeAgentId(agentId), input);
    },
    async search({ agentId, query, limit, includeEvidence }) {
      await initialization;
      const normalizedAgentId = normalizeAgentId(agentId);
      const agent = agents.get(normalizedAgentId);
      if (!agent?.fingerprint) return;
      const state = indexes.get(agent.fingerprint);
      if (!state) return;
      const activeStore = state.store ?? (await ensureStore(state));
      if (!activeStore) return;

      const { skills } = config();
      const collectionWeights = skills?.search?.collectionWeights ?? {
        meta: 1,
        body: 1,
        references: 1,
      };
      const candidateLimit = Math.max(limit, DEFAULT_CANDIDATE_LIMIT);
      const collections = [
        { name: META_COLLECTION, weight: collectionWeights.meta },
        { name: BODY_COLLECTION, weight: collectionWeights.body },
        { name: REFS_COLLECTION, weight: collectionWeights.references },
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
            })
              .filter((hit) => agent.allowedSkillNames.has(hit.skillName.toLowerCase()))
              .sort((left, right) => {
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
          for (const hit of entry.ranked) hitById.set(hitId(hit), hit);
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
          } else {
            if (fusedHit.score > existing.score) existing.score = fusedHit.score;
            existing.evidence.push(evidence);
            existing.evidence.sort((left, right) => right.score - left.score);
            if (existing.evidence.length > MAX_EVIDENCE_PER_SKILL) {
              existing.evidence.length = MAX_EVIDENCE_PER_SKILL;
            }
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
      const agent = agents.get(normalizeAgentId(agentId));
      const fingerprint = agent?.fingerprint ?? agent?.expectedFingerprint;
      if (!fingerprint) return "idle";
      return indexes.get(fingerprint)?.status ?? "idle";
    },
    async close() {
      await initialization;
      await Promise.all(
        [...agents.values()]
          .map((agent) => agent.scheduling)
          .filter((value): value is Promise<void> => value !== undefined),
      );
      for (const state of indexes.values()) clearRetryTimer(state);
      await Promise.all(
        [...indexes.values()]
          .map((state) => state.refreshing)
          .filter((value): value is Promise<void> => value !== undefined),
      );
      await Promise.all(
        [...indexes.values()].map(async (state) => {
          const store = state.store;
          state.store = undefined;
          if (store) await store.close().catch(() => undefined);
        }),
      );
      agents.clear();
      indexes.clear();
    },
  };
}
