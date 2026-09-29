import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { QMDStore } from "@wei840222/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import { readJsonFile, withFileLock, writeJsonAtomic } from "../file-utils.js";
import type { SkillExperienceEntry } from "../experiences/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import {
  buildStoreModels,
  normalizeEmbeddingModel,
} from "./provider-resolver.js";
import { boundQmdQuery } from "./query-budget.js";
import { weightedReciprocalRankFusion } from "./rrf.js";

export const EXPERIENCE_KEYWORDS_COLLECTION = "keywords";
export const EXPERIENCE_SUMMARY_COLLECTION = "summary";
export const EXPERIENCE_BODY_COLLECTION = "body";

export const EXPERIENCE_COLLECTIONS = [
  { name: EXPERIENCE_KEYWORDS_COLLECTION, weight: 1.0 },
  { name: EXPERIENCE_SUMMARY_COLLECTION, weight: 0.8 },
  { name: EXPERIENCE_BODY_COLLECTION, weight: 0.5 },
] as const;

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION = 2;

type QmdCreateStore = (typeof import("@wei840222/qmd"))["createStore"];

type ExperienceIndexMetadata = {
  schemaVersion: typeof EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION;
  fingerprint: string;
};

function isExperienceIndexMetadata(
  value: unknown,
): value is ExperienceIndexMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string"
  );
}

export type QmdRawSearchResult = Record<string, unknown> & {
  filepath?: string;
  file?: string;
  displayPath?: string;
  body?: string;
  score: number;
  explain?: unknown;
};

export interface SkillExperienceEvidence {
  collection: string;
  score: number;
  snippet?: string;
  explain?: unknown;
}

export interface SkillExperienceHit {
  id: string;
  skills: readonly string[];
  score: number;
  semanticScore: number;
  matchedCollections: readonly string[];
  evidence: readonly SkillExperienceEvidence[];
  explain?: unknown;
}

export type SkillExperienceIndexStatus =
  "idle" | "building" | "ready" | "failed";

export interface SkillExperienceQmdIndex {
  schedule(entries: readonly SkillExperienceEntry[]): void;
  search(params: {
    query: string;
    limit?: number;
    expansionContext?: string;
  }): Promise<SkillExperienceHit[] | undefined>;
  getStatus(): SkillExperienceIndexStatus;
  close(): Promise<void>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotFingerprint(
  entries: readonly SkillExperienceEntry[],
  config: ResolvedQmdConfig,
): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return hash(
    JSON.stringify({
      schemaVersion: EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION,
      entries: sorted.map((entry) => ({
        id: entry.id,
        skills: [...entry.skills].sort(),
        summaryHash: hash(entry.summary),
        keywords: [...entry.keywords].sort(),
        bodyHash: hash(entry.body),
      })),
      qmd: {
        timeoutMs: config.timeoutMs,
        embedding: {
          baseUrl: config.embedding.baseUrl,
          model: normalizeEmbeddingModel(config.embedding.model),
          apiKey: config.embedding.apiKey,
          dimension: config.embedding.dimension ?? null,
        },
        expansion: {
          baseUrl: config.expansion.baseUrl,
          model: config.expansion.model,
          apiKey: config.expansion.apiKey,
        },
      },
    }),
  );
}

function extractSemanticScore(result: QmdRawSearchResult): number {
  const explain = result.explain as Record<string, unknown> | undefined;
  if (explain && typeof explain === "object") {
    const rawVectorScores = Array.isArray(explain.vectorScores)
      ? explain.vectorScores.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s),
        )
      : [];
    const rawFtsScores = Array.isArray(explain.ftsScores)
      ? explain.ftsScores.filter(
          (s): s is number => typeof s === "number" && Number.isFinite(s),
        )
      : [];
    if (rawVectorScores.length > 0 || rawFtsScores.length > 0) {
      return Math.max(...rawVectorScores, ...rawFtsScores);
    }
  }
  return result.score;
}

function idFromCandidatePath(targetPath: string): string | undefined {
  const normalized = targetPath.split(path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return;
  const fileName = segments[segments.length - 1];
  if (!fileName?.endsWith(".md")) return;
  return fileName.slice(0, -".md".length);
}

function parseFrontmatterIdentity(raw: string | undefined): {
  id?: string;
  skills?: string[];
  snippet?: string;
} {
  if (!raw) return {};
  try {
    const parsed = matter(raw);
    return {
      id:
        typeof parsed.data.id === "string" ? parsed.data.id.trim() : undefined,
      skills: Array.isArray(parsed.data.skills)
        ? parsed.data.skills.filter((s): s is string => typeof s === "string")
        : undefined,
      snippet: parsed.content.trim().slice(0, 240) || undefined,
    };
  } catch {
    return {};
  }
}

interface RawCollectionHit {
  id: string;
  collection: string;
  score: number;
  semanticScore: number;
  snippet?: string;
  explain?: unknown;
}

function parseStoreHits(params: {
  results: readonly QmdRawSearchResult[];
  collection: string;
}): RawCollectionHit[] {
  const hits: RawCollectionHit[] = [];
  for (const result of params.results) {
    if (!Number.isFinite(result.score)) continue;

    const fromBody = parseFrontmatterIdentity(result.body);
    let id = fromBody.id;

    if (!id) {
      const pathCandidates = [
        result.filepath,
        result.file,
        result.displayPath,
      ].filter((val): val is string => Boolean(val));

      for (const cand of pathCandidates) {
        id = idFromCandidatePath(cand);
        if (id) break;
      }
    }

    if (!id) continue;
    const semanticScore = extractSemanticScore(result);

    hits.push({
      id,
      collection: params.collection,
      score: result.score,
      semanticScore,
      ...(fromBody.snippet ? { snippet: fromBody.snippet } : {}),
      ...(result.explain === undefined ? {} : { explain: result.explain }),
    });
  }
  return hits;
}

export function createSkillExperienceQmdIndex(params: {
  dataRoot: string;
  config: () => ResolvedQmdConfig;
  createStore?: QmdCreateStore;
  readOnly?: boolean;
}): SkillExperienceQmdIndex {
  const indexPath = path.join(params.dataRoot, "qmd", "experiences");
  const databasePath = path.join(indexPath, "experience-routing.sqlite");
  const docsRoot = path.join(indexPath, "docs");
  const metadataPath = path.join(indexPath, "metadata.json");

  let store: QMDStore | undefined;
  let status: SkillExperienceIndexStatus = "idle";
  let closed = false;
  let running: Promise<void> | undefined;
  let currentFingerprint: string | undefined;
  let expectedFingerprint: string | undefined;
  let buildingFingerprint: string | undefined;
  let desired:
    | { entries: readonly SkillExperienceEntry[]; fingerprint: string }
    | undefined;
  let consecutiveFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let knownEntriesById = new Map<string, SkillExperienceEntry>();

  function clearRetryTimer(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  }

  function resetRetryState(): void {
    clearRetryTimer();
    consecutiveFailures = 0;
  }

  function persistFingerprint(fingerprint: string): void {
    const meta: ExperienceIndexMetadata = {
      schemaVersion: EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION,
      fingerprint,
    };
    writeJsonAtomic(metadataPath, meta);
  }

  function sidecarYaml(entry: SkillExperienceEntry, kind: string): string {
    return matter.stringify("", {
      id: entry.id,
      skills: entry.skills,
      kind,
      path: entry.path,
    });
  }

  async function writeSnapshot(
    entries: readonly SkillExperienceEntry[],
  ): Promise<
    Record<string, { path: string; pattern: string; ignore?: string[] }>
  > {
    const collections = {
      [EXPERIENCE_KEYWORDS_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_KEYWORDS_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.yml"],
      },
      [EXPERIENCE_SUMMARY_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_SUMMARY_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.yml"],
      },
      [EXPERIENCE_BODY_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_BODY_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.yml"],
      },
    };

    const currentFiles = new Set<string>();

    const writeDoc = async (
      collectionName: string,
      entryId: string,
      content: string,
      sidecar: string,
    ) => {
      const colDir = path.join(docsRoot, collectionName);
      await fs.mkdir(colDir, { recursive: true });
      const mdPath = path.join(colDir, `${entryId}.md`);
      const sidecarPath = `${mdPath}.identity.yml`;
      currentFiles.add(mdPath);
      currentFiles.add(sidecarPath);

      let existingMd: string | undefined;
      try {
        existingMd = await fs.readFile(mdPath, "utf8");
      } catch {
        // file does not exist
      }
      if (existingMd !== content) {
        await fs.writeFile(mdPath, content, "utf8");
      }

      let existingSidecar: string | undefined;
      try {
        existingSidecar = await fs.readFile(sidecarPath, "utf8");
      } catch {
        // sidecar does not exist
      }
      if (existingSidecar !== sidecar) {
        await fs.writeFile(sidecarPath, sidecar, "utf8");
      }
    };

    for (const entry of entries) {
      // 1. keywords
      const keywordsContent =
        entry.keywords.map((k) => `- ${k}`).join("\n") + "\n";
      await writeDoc(
        EXPERIENCE_KEYWORDS_COLLECTION,
        entry.id,
        keywordsContent,
        sidecarYaml(entry, "keywords"),
      );

      // 2. summary
      await writeDoc(
        EXPERIENCE_SUMMARY_COLLECTION,
        entry.id,
        `${entry.summary.trim()}\n`,
        sidecarYaml(entry, "summary"),
      );

      // 3. body
      await writeDoc(
        EXPERIENCE_BODY_COLLECTION,
        entry.id,
        `${entry.body.trim()}\n`,
        sidecarYaml(entry, "body"),
      );
    }

    async function cleanDir(dir: string): Promise<void> {
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await cleanDir(full);
          try {
            await fs.rmdir(full);
          } catch {
            // Not empty
          }
        } else if (
          dirent.isFile() &&
          (dirent.name.endsWith(".md") || dirent.name.endsWith(".identity.yml"))
        ) {
          if (!currentFiles.has(full)) {
            await fs.rm(full, { force: true });
          }
        }
      }
    }

    await cleanDir(docsRoot);
    return collections;
  }

  async function openExistingIndex(): Promise<void> {
    try {
      const meta = readJsonFile<unknown>(metadataPath);
      if (!isExperienceIndexMetadata(meta)) {
        return;
      }
      const resolvedConfig = params.config();
      const createStore =
        params.createStore ?? (await import("@wei840222/qmd")).createStore;
      const opened = await createStore({
        dbPath: databasePath,
        config: { collections: {}, models: buildStoreModels(resolvedConfig) },
        readOnly: true,
        remoteRequestTimeoutMs: resolvedConfig.timeoutMs,
      });
      if (closed) {
        await opened.close();
        return;
      }
      store = opened;
      currentFingerprint = meta.fingerprint;
      status = "ready";
      resetRetryState();
    } catch {
      status = "idle";
    }
  }

  async function build(target: {
    entries: readonly SkillExperienceEntry[];
    fingerprint: string;
  }): Promise<void> {
    status = "building";
    let nextStore: QMDStore | undefined;
    try {
      await fs.mkdir(indexPath, { recursive: true });
      const resolvedConfig = params.config();
      const collections = await writeSnapshot(target.entries);
      const createStore =
        params.createStore ?? (await import("@wei840222/qmd")).createStore;

      const refresh = async () => {
        nextStore = await createStore({
          dbPath: databasePath,
          config: {
            collections,
            models: buildStoreModels(resolvedConfig),
          },
          remoteRequestTimeoutMs: resolvedConfig.timeoutMs,
        });

        await nextStore.update();
        const embedResult = await nextStore.embed();
        const indexStatus = await nextStore.getStatus();
        if (embedResult.errors > 0 || indexStatus.needsEmbedding > 0) {
          throw new Error(
            `QMD experience index embedding is incomplete (errors=${embedResult.errors}, needsEmbedding=${indexStatus.needsEmbedding}).`,
          );
        }

        const active = store;
        store = nextStore;
        nextStore = undefined;
        currentFingerprint = target.fingerprint;
        status = "ready";
        resetRetryState();
        persistFingerprint(target.fingerprint);

        if (active) {
          await active.close().catch(() => undefined);
        }
        return true;
      };

      if (params.readOnly) {
        await refresh();
        return;
      }
      const locked = await withFileLock(databasePath, refresh, {
        maxWaitMs: 30 * 60 * 1000,
      });
      if (locked === undefined) {
        throw new Error("experience index build lock is busy");
      }
    } catch (error) {
      if (nextStore) await nextStore.close().catch(() => undefined);
      status = "failed";
      consecutiveFailures += 1;
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
        MAX_RETRY_DELAY_MS,
      );
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        if (!closed && desired) {
          void runWorker();
        }
      }, delay);
      logger.warn("failed to build QMD experience index", {
        error,
        fingerprint: target.fingerprint,
        retryDelayMs: delay,
      });
    }
  }

  async function runWorker(): Promise<void> {
    try {
      while (!closed && desired) {
        const target = desired;
        desired = undefined;
        buildingFingerprint = target.fingerprint;
        try {
          await build(target);
        } finally {
          buildingFingerprint = undefined;
        }
      }
    } finally {
      running = undefined;
    }
  }

  function isReadyForCurrentCatalog(): boolean {
    return (
      status === "ready" &&
      store !== undefined &&
      currentFingerprint !== undefined &&
      currentFingerprint === expectedFingerprint
    );
  }

  void openExistingIndex();

  return {
    schedule(entries) {
      if (closed) return;
      knownEntriesById = new Map(entries.map((e) => [e.id, e]));
      const fingerprint = snapshotFingerprint(entries, params.config());
      expectedFingerprint = fingerprint;

      if (currentFingerprint === fingerprint && status === "ready") {
        desired = undefined;
        return;
      }
      if (buildingFingerprint === fingerprint) {
        desired = undefined;
        return;
      }

      desired = { entries, fingerprint };
      if (!running) {
        running = runWorker();
      }
    },
    async search({ query, limit = 8, expansionContext }) {
      if (closed || !isReadyForCurrentCatalog() || !store) return;
      try {
        const searchLimit = Math.max(limit * 2, 20);
        const collectionHits = await Promise.all(
          EXPERIENCE_COLLECTIONS.map(async (collection) => {
            const results = (await store!.search({
              query: boundQmdQuery(query),
              collections: [collection.name],
              includeHyde: true,
              ...(expansionContext ? { expansionContext } : {}),
              rerank: false,
              limit: searchLimit,
              candidateLimit: searchLimit,
              minScore: 0,
              explain: true,
            })) as unknown as QmdRawSearchResult[];

            const ranked = parseStoreHits({
              results,
              collection: collection.name,
            }).sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              return left.id.localeCompare(right.id);
            });
            return { collection, ranked };
          }),
        );

        // Weighted Reciprocal Rank Fusion
        const fused = weightedReciprocalRankFusion({
          lists: collectionHits.map((entry) =>
            entry.ranked.map((hit) => ({ id: hit.id })),
          ),
          weights: collectionHits.map((entry) => entry.collection.weight),
        });

        const hitsById = new Map<string, RawCollectionHit[]>();
        for (const col of collectionHits) {
          for (const hit of col.ranked) {
            const list = hitsById.get(hit.id) ?? [];
            list.push(hit);
            hitsById.set(hit.id, list);
          }
        }

        const hits: SkillExperienceHit[] = [];
        for (const fusedHit of fused) {
          const rawHits = hitsById.get(fusedHit.id);
          if (!rawHits || rawHits.length === 0) continue;

          const entry = knownEntriesById.get(fusedHit.id);
          const skills = entry?.skills ?? [];
          const semanticScore = Math.max(
            ...rawHits.map((h) => h.semanticScore),
          );
          const matchedCollections = [
            ...new Set(rawHits.map((h) => h.collection)),
          ];
          const evidence: SkillExperienceEvidence[] = rawHits.map((h) => ({
            collection: h.collection,
            score: h.score,
            ...(h.snippet ? { snippet: h.snippet } : {}),
            ...(h.explain !== undefined ? { explain: h.explain } : {}),
          }));

          hits.push({
            id: fusedHit.id,
            skills,
            score: fusedHit.score,
            semanticScore,
            matchedCollections,
            evidence,
            ...(rawHits[0].explain !== undefined
              ? { explain: rawHits[0].explain }
              : {}),
          });

          if (hits.length >= limit) break;
        }

        return hits;
      } catch (error) {
        logger.warn("QMD experience search failed", { error });
        return;
      }
    },
    getStatus: () => status,
    async close() {
      closed = true;
      desired = undefined;
      clearRetryTimer();
      await running;
      buildingFingerprint = undefined;
      const activeStore = store;
      store = undefined;
      currentFingerprint = undefined;
      expectedFingerprint = undefined;
      resetRetryState();
      status = "idle";
      if (activeStore) await activeStore.close();
    },
  };
}
