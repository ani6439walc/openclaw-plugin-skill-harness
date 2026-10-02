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
      identityFormat: "path",
      entries: sorted.map((entry) => ({
        id: entry.id,
        skills: [...entry.skills].sort(),
        summaryHash: hash(entry.summary),
        keywords: [...entry.keywords].sort(),
        bodyHash: hash(entry.body),
      })),
      qmd: {
        embedding: {
          model: normalizeEmbeddingModel(config.embedding.model),
          dimension: config.embedding.dimension ?? null,
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
  getEntries?: () => readonly SkillExperienceEntry[];
}): SkillExperienceQmdIndex {
  const indexPath = path.join(params.dataRoot, "qmd", "experiences");
  const databasePath = path.join(indexPath, "experience-routing.sqlite");
  const docsRoot = path.join(indexPath, "docs");
  const metadataPath = path.join(indexPath, "metadata.json");

  let store: QMDStore | undefined;
  let connectionSignature: string | undefined;
  let opening: Promise<QMDStore | undefined> | undefined;
  let refreshing: Promise<boolean> | undefined;
  let storeFingerprint: string | undefined;
  let activeSearches = 0;
  let drained: Promise<void> | undefined;
  let resolveDrained: (() => void) | undefined;
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

  async function writeSnapshot(
    entries: readonly SkillExperienceEntry[],
  ): Promise<
    Record<string, { path: string; pattern: string; ignore?: string[] }>
  > {
    const collections = {
      [EXPERIENCE_KEYWORDS_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_KEYWORDS_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.json", "**/*.identity.yml"],
      },
      [EXPERIENCE_SUMMARY_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_SUMMARY_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.json", "**/*.identity.yml"],
      },
      [EXPERIENCE_BODY_COLLECTION]: {
        path: path.join(docsRoot, EXPERIENCE_BODY_COLLECTION),
        pattern: "**/*.md",
        ignore: ["**/*.identity.json", "**/*.identity.yml"],
      },
    };

    const currentFiles = new Set<string>();

    const writeDoc = async (
      collectionName: string,
      entryId: string,
      content: string,
    ) => {
      const colDir = path.join(docsRoot, collectionName);
      await fs.mkdir(colDir, { recursive: true });
      const mdPath = path.join(colDir, `${entryId}.md`);
      currentFiles.add(mdPath);

      let existingMd: string | undefined;
      try {
        existingMd = await fs.readFile(mdPath, "utf8");
      } catch {
        // file does not exist
      }
      if (existingMd !== content) {
        await fs.writeFile(mdPath, content, "utf8");
      }
    };

    for (const entry of entries) {
      // 1. keywords
      const keywordsContent =
        entry.keywords.map((k) => `- ${k}`).join("\n") + "\n";
      await writeDoc(EXPERIENCE_KEYWORDS_COLLECTION, entry.id, keywordsContent);

      // 2. summary
      await writeDoc(
        EXPERIENCE_SUMMARY_COLLECTION,
        entry.id,
        `${entry.summary.trim()}\n`,
      );

      // 3. body
      await writeDoc(
        EXPERIENCE_BODY_COLLECTION,
        entry.id,
        `${entry.body.trim()}\n`,
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
          (dirent.name.endsWith(".md") ||
            dirent.name.endsWith(".identity.yml") ||
            dirent.name.endsWith(".identity.json"))
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

  function storeConnection() {
    const config = params.config();
    const connection = {
      models: buildStoreModels(config),
      remoteRequestTimeoutMs: config.timeoutMs,
    };
    return { ...connection, signature: JSON.stringify(connection) };
  }

  function ensureStore(): Promise<QMDStore | undefined> {
    if (closed) return Promise.resolve(undefined);
    if (opening) return opening;
    if (
      store &&
      connectionSignature === storeConnection().signature &&
      (!params.readOnly || storeFingerprint === expectedFingerprint)
    )
      return Promise.resolve(store);
    const pending = (async () => {
      try {
        await drained;
        while (!closed) {
          const previous = store;
          if (previous) await previous.close();
          store = undefined;
          storeFingerprint = undefined;
          connectionSignature = undefined;
          if (closed) return;
          const connection = storeConnection();
          const createStore =
            params.createStore ?? (await import("@wei840222/qmd")).createStore;
          const fingerprint = expectedFingerprint;
          const opened = await createStore({
            dbPath: databasePath,
            config: { collections: {}, models: connection.models },
            readOnly: true,
            remoteRequestTimeoutMs: connection.remoteRequestTimeoutMs,
          });
          store = opened;
          storeFingerprint = fingerprint;
          connectionSignature = connection.signature;
          if (closed) return;
          if (connection.signature !== storeConnection().signature) continue;
          return opened;
        }
      } catch (error) {
        logger.warn("failed to open QMD experience index", { error });
        return;
      }
    })();
    opening = pending;
    void pending.finally(() => {
      if (opening === pending) opening = undefined;
    });
    return pending;
  }

  function refreshDiscovery(): Promise<boolean> {
    if (refreshing) return refreshing;
    const pending = (async () => {
      try {
        const entries = params.getEntries?.() ?? [...knownEntriesById.values()];
        knownEntriesById = new Map(entries.map((entry) => [entry.id, entry]));
        expectedFingerprint = snapshotFingerprint(entries, params.config());
        // Do not create a lock directory (or an empty SQLite database) when absent.
        if (!(await fs.lstat(databasePath)).isFile()) return false;
        if (
          storeFingerprint !== expectedFingerprint ||
          connectionSignature !== storeConnection().signature
        )
          await drained;
        if (closed) return false;
        const ready = await withFileLock(
          databasePath,
          async () => {
            if (closed) return false;
            const meta = readJsonFile<unknown>(metadataPath);
            if (
              !isExperienceIndexMetadata(meta) ||
              meta.fingerprint !== expectedFingerprint
            )
              return false;
            if (!(await fs.lstat(databasePath)).isFile()) return false;
            // Retry a late connection change without holding the build lock
            // while existing model requests finish.
            if (
              activeSearches > 0 &&
              (storeFingerprint !== expectedFingerprint ||
                connectionSignature !== storeConnection().signature)
            )
              return false;
            const opened = await ensureStore();
            if (!opened || closed) return false;
            const latestEntries = params.getEntries?.() ?? [
              ...knownEntriesById.values(),
            ];
            const latestFingerprint = snapshotFingerprint(
              latestEntries,
              params.config(),
            );
            const latestMeta = readJsonFile<unknown>(metadataPath);
            if (
              !isExperienceIndexMetadata(latestMeta) ||
              latestMeta.fingerprint !== meta.fingerprint ||
              latestFingerprint !== meta.fingerprint
            )
              return false;
            knownEntriesById = new Map(
              latestEntries.map((entry) => [entry.id, entry]),
            );
            currentFingerprint = meta.fingerprint;
            status = "ready";
            return true;
          },
          { maxWaitMs: 1_000 },
        );
        return ready === true;
      } catch {
        return false;
      }
    })();
    refreshing = pending;
    void pending.then((ready) => {
      if (!ready && !closed) status = "idle";
      if (refreshing === pending) refreshing = undefined;
    });
    return pending;
  }

  async function acquireStore() {
    while (!closed) {
      if (params.readOnly && !(await refreshDiscovery())) return;
      if (status !== "ready") return;
      const activeStore = params.readOnly ? store : await ensureStore();
      if (!activeStore || closed || !isReadyForCurrentCatalog()) return;
      if (
        refreshing ||
        opening ||
        connectionSignature !== storeConnection().signature
      )
        continue;
      activeSearches += 1;
      if (activeSearches === 1) {
        drained = new Promise<void>((resolve) => {
          resolveDrained = resolve;
        });
      }
      return {
        store: activeStore,
        entries: knownEntriesById,
        release() {
          activeSearches -= 1;
          if (activeSearches === 0) {
            resolveDrained?.();
            drained = undefined;
            resolveDrained = undefined;
          }
        },
      };
    }
  }

  async function openExistingIndex(): Promise<void> {
    try {
      const meta = readJsonFile<unknown>(metadataPath);
      if (!isExperienceIndexMetadata(meta)) {
        return;
      }
      const opened = await ensureStore();
      if (!opened || closed) return;
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
  }): Promise<boolean> {
    status = "building";
    let nextStore: QMDStore | undefined;
    try {
      await fs.mkdir(indexPath, { recursive: true });
      await opening;
      await drained;
      if (closed) return true;
      const collections = await writeSnapshot(target.entries);
      const createStore =
        params.createStore ?? (await import("@wei840222/qmd")).createStore;

      const refresh = async () => {
        if (closed) return true;
        const connection = storeConnection();
        nextStore = await createStore({
          dbPath: databasePath,
          config: {
            collections,
            models: connection.models,
          },
          remoteRequestTimeoutMs: connection.remoteRequestTimeoutMs,
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
        connectionSignature = connection.signature;
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

      const locked = await withFileLock(databasePath, refresh, {
        maxWaitMs: 30 * 60 * 1000,
      });
      if (locked === undefined) {
        throw new Error("experience index build lock is busy");
      }
      return true;
    } catch (error) {
      if (nextStore) await nextStore.close().catch(() => undefined);
      status = "failed";
      consecutiveFailures += 1;
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
        MAX_RETRY_DELAY_MS,
      );
      desired ??= target;
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!closed && desired && !running) {
          running = runWorker();
        }
      }, delay);
      logger.warn("failed to build QMD experience index", {
        error,
        fingerprint: target.fingerprint,
        retryDelayMs: delay,
      });
      return false;
    }
  }

  async function runWorker(): Promise<void> {
    try {
      await initialization;
      while (!closed && desired) {
        const target = desired;
        desired = undefined;
        buildingFingerprint = target.fingerprint;
        try {
          if (currentFingerprint === target.fingerprint && status === "ready") {
            continue;
          }
          if (!(await build(target))) break;
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
      currentFingerprint !== undefined &&
      currentFingerprint === expectedFingerprint
    );
  }

  const initialization = params.readOnly
    ? Promise.resolve()
    : openExistingIndex();

  return {
    schedule(entries) {
      if (closed) return;
      knownEntriesById = new Map(entries.map((e) => [e.id, e]));
      const fingerprint = snapshotFingerprint(entries, params.config());
      expectedFingerprint = fingerprint;
      if (params.readOnly) return;

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
        clearRetryTimer();
        running = runWorker();
      }
    },
    async search({ query, limit = 8, expansionContext }) {
      await initialization;
      if (closed || (!params.readOnly && !isReadyForCurrentCatalog())) return;
      let lease: Awaited<ReturnType<typeof acquireStore>>;
      try {
        lease = await acquireStore();
        if (!lease) return;
        const activeStore = lease.store;
        const searchLimit = Math.max(limit * 2, 20);
        const collectionResults = await Promise.allSettled(
          EXPERIENCE_COLLECTIONS.map(async (collection) => {
            const results = (await activeStore.search({
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

        const collectionHits = collectionResults.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });

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

          const entry = lease.entries.get(fusedHit.id);
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
      } finally {
        lease?.release();
      }
    },
    getStatus() {
      if (status === "ready") {
        if (opening) return "building";
        if (!store) return "failed";
      }
      return status;
    },
    async close() {
      closed = true;
      desired = undefined;
      clearRetryTimer();
      await initialization;
      await running;
      await refreshing;
      await opening;
      await drained;
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
