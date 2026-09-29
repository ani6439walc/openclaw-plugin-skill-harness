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

const EXPERIENCES_COLLECTION = "skill-experiences";
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION = 1;

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

export interface SkillExperienceHit {
  identity: string;
  skill: string;
  entryId: string;
  score: number;
  semanticScore: number;
  collection: string;
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
  const sorted = [...entries].sort((a, b) =>
    a.identity.localeCompare(b.identity),
  );
  return hash(
    JSON.stringify({
      schemaVersion: EXPERIENCE_INDEX_METADATA_SCHEMA_VERSION,
      entries: sorted.map((entry) => ({
        identity: entry.identity,
        skill: entry.skill,
        entryId: entry.entryId,
        summary: entry.summary,
        keywords: entry.keywords,
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

function identityFromCandidatePath(targetPath: string):
  | {
      identity: string;
      skill: string;
      entryId: string;
    }
  | undefined {
  const normalized = targetPath.split(path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return;
  const fileName = segments[segments.length - 1];
  if (!fileName?.endsWith(".md")) return;
  const entryId = fileName.slice(0, -".md".length);
  const skill = segments[segments.length - 2];
  if (!skill || !entryId) return;
  return {
    identity: `${skill}/${entryId}`,
    skill,
    entryId,
  };
}

function parseExperienceHits(
  results: readonly QmdRawSearchResult[],
  collection: string,
): SkillExperienceHit[] {
  const hitByIdentity = new Map<string, SkillExperienceHit>();
  for (const result of results) {
    if (!Number.isFinite(result.score)) continue;
    let identityInfo:
      { identity: string; skill: string; entryId: string } | undefined;

    const pathCandidates = [
      result.filepath,
      result.file,
      result.displayPath,
    ].filter((val): val is string => Boolean(val));

    for (const cand of pathCandidates) {
      identityInfo = identityFromCandidatePath(cand);
      if (identityInfo) break;
    }

    if (!identityInfo && result.body) {
      try {
        const parsed = matter(result.body);
        const skill =
          typeof parsed.data.skill === "string"
            ? parsed.data.skill.trim()
            : undefined;
        if (skill && result.filepath) {
          const entryId = path.basename(result.filepath, ".md");
          identityInfo = {
            identity: `${skill}/${entryId}`,
            skill,
            entryId,
          };
        }
      } catch {
        // Fallback ignore
      }
    }

    if (!identityInfo) continue;
    const semanticScore = extractSemanticScore(result);
    const existing = hitByIdentity.get(identityInfo.identity);
    if (!existing || semanticScore > existing.semanticScore) {
      hitByIdentity.set(identityInfo.identity, {
        identity: identityInfo.identity,
        skill: identityInfo.skill,
        entryId: identityInfo.entryId,
        score: result.score,
        semanticScore,
        collection,
        ...(result.explain === undefined ? {} : { explain: result.explain }),
      });
    }
  }

  return [...hitByIdentity.values()].sort(
    (left, right) =>
      right.semanticScore - left.semanticScore ||
      right.score - left.score ||
      left.identity.localeCompare(right.identity, "en"),
  );
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
      [EXPERIENCES_COLLECTION]: {
        path: docsRoot,
        pattern: "**/*.md",
      },
    };

    const currentFiles = new Set<string>();
    for (const entry of entries) {
      const relPath = path.join(entry.skill, `${entry.entryId}.md`);
      const targetPath = path.join(docsRoot, relPath);
      currentFiles.add(targetPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      const frontmatter = {
        skill: entry.skill,
        summary: entry.summary,
        keywords: entry.keywords,
      };
      const yamlStr = matter.stringify(entry.body, frontmatter);

      let existing: string | undefined;
      try {
        existing = await fs.readFile(targetPath, "utf8");
      } catch {
        // file doesn't exist
      }
      if (existing !== yamlStr) {
        await fs.writeFile(targetPath, yamlStr, "utf8");
      }
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
        } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
          if (!currentFiles.has(full)) {
            await fs.rm(full, { force: true });
          }
        }
      }
    }

    await cleanDir(docsRoot);
    return collections;
  }

  async function openExistingIndex(): Promise<boolean> {
    try {
      const meta = readJsonFile(metadataPath);
      if (!isExperienceIndexMetadata(meta)) return false;
      const qmd = params.config();
      const createQmdStore =
        params.createStore ?? (await import("@wei840222/qmd")).createStore;
      store = await createQmdStore({
        dbPath: databasePath,
        config: {
          collections: {
            [EXPERIENCES_COLLECTION]: {
              path: docsRoot,
              pattern: "**/*.md",
            },
          },
          models: buildStoreModels(qmd),
        },
        remoteRequestTimeoutMs: qmd.timeoutMs,
      });
      currentFingerprint = meta.fingerprint;
      status = "ready";
      return true;
    } catch (error) {
      logger.warn("failed to open existing QMD experience index", { error });
      return false;
    }
  }

  async function build(target: {
    entries: readonly SkillExperienceEntry[];
    fingerprint: string;
  }): Promise<void> {
    let nextStore: QMDStore | undefined;
    try {
      status = "building";
      const refresh = async (): Promise<boolean> => {
        if (params.readOnly) {
          status = "idle";
          return true;
        }
        await fs.rm(metadataPath, { force: true });
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
        const createQmdStore =
          params.createStore ?? (await import("@wei840222/qmd")).createStore;
        const collections = await writeSnapshot(target.entries);
        nextStore = await createQmdStore({
          dbPath: databasePath,
          config: {
            collections,
            models: buildStoreModels(qmd),
          },
          remoteRequestTimeoutMs: qmd.timeoutMs,
        });
        await nextStore.update();
        const embedResult = await nextStore.embed();
        const indexStatus = await nextStore.getStatus();
        if (embedResult.errors > 0 || indexStatus.needsEmbedding > 0) {
          throw new Error(
            `QMD experience index embedding is incomplete (errors=${embedResult.errors}, needsEmbedding=${indexStatus.needsEmbedding}).`,
          );
        }

        const previousStore = store;
        persistFingerprint(target.fingerprint);
        store = nextStore;
        currentFingerprint = target.fingerprint;
        status = "ready";
        resetRetryState();
        if (previousStore) {
          await previousStore.close().catch((err: unknown) => {
            logger.warn("failed to close previous QMD experience index", {
              error: err,
            });
          });
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
        const results = (await store.search({
          query: boundQmdQuery(query),
          collections: [EXPERIENCES_COLLECTION],
          includeHyde: true,
          ...(expansionContext ? { expansionContext } : {}),
          rerank: false,
          limit,
          candidateLimit: limit,
          minScore: 0,
          explain: true,
        })) as unknown as QmdRawSearchResult[];

        return parseExperienceHits(results, EXPERIENCES_COLLECTION);
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
