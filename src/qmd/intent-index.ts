import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { QMDStore } from "@wei840222/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import { readJsonFile, withFileLock, writeJsonAtomic } from "../file-utils.js";
import type { IntentCatalogEntry, ResolvedQmdConfig } from "../types.js";
import { normalizeEmbeddingModel } from "./provider-resolver.js";
import { boundQmdQuery } from "./query-budget.js";

const TRIGGERS_COLLECTION = "intent-triggers";
const EXAMPLES_COLLECTION = "intent-examples";
const KEYWORDS_COLLECTION = "intent-keywords";
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const INTENT_INDEX_METADATA_SCHEMA_VERSION = 1;

type QmdCreateStore = (typeof import("@wei840222/qmd"))["createStore"];

type IntentIndexMetadata = {
  schemaVersion: typeof INTENT_INDEX_METADATA_SCHEMA_VERSION;
  fingerprint: string;
};

function isIntentIndexMetadata(value: unknown): value is IntentIndexMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === INTENT_INDEX_METADATA_SCHEMA_VERSION &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string"
  );
}

type QmdResult = {
  body: string;
  score: number;
  explain?: unknown;
};

type QmdLexResult = {
  filepath: string;
  score: number;
};

export type QmdIntentHit = {
  intentId: string;
  score: number;
  collection: string;
  explain?: unknown;
};

export type QmdIntentIndexStatus = "idle" | "building" | "ready" | "failed";

export interface IntentQmdIndex {
  schedule(intents: readonly IntentCatalogEntry[]): void;
  searchIntentTriggers(params: {
    query: string;
    rawLimit: number;
    expansionContext?: string;
  }): Promise<QmdIntentHit[] | undefined>;
  searchKeywords(params: {
    query: string;
    limit?: number;
  }): Promise<QmdIntentHit[] | undefined>;
  getStatus(): QmdIntentIndexStatus;
  close(): Promise<void>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildStoreModels(config: ResolvedQmdConfig) {
  return {
      embed_api_url: config.embedding.baseUrl,
      embed_api_model: config.embedding.model,
      ...(config.embedding.apiKey
        ? { embed_api_key: config.embedding.apiKey }
        : {}),
      ...(config.embedding.dimension
        ? { embed_dimension: config.embedding.dimension }
        : {}),
      generate_api_url: config.expansion.baseUrl,
      generate_api_model: config.expansion.model,
    ...(config.expansion.apiKey
      ? { generate_api_key: config.expansion.apiKey }
      : {}),
  };
}

function snapshotFingerprint(
  intents: readonly IntentCatalogEntry[],
  config: ResolvedQmdConfig,
): string {
  return hash(
    JSON.stringify({
      intents: intents.map((intent) => ({
        id: intent.id,
        triggers: intent.definition.triggers,
        examples: intent.definition.examples,
        domain: intent.definition.domain,
        keywords: intent.definition.keywords,
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

function documentPath(
  collectionRoot: string,
  intent: IntentCatalogEntry,
  index: number,
): string {
  return path.join(collectionRoot, `${intent.id}-${index}.md`);
}

function documentBody(params: {
  intent: IntentCatalogEntry;
  kind: "trigger" | "example" | "keyword";
  text: string;
}): string {
  return matter.stringify(params.text.trim(), {
    intent_id: params.intent.id,
    domain: params.intent.definition.domain,
    kind: params.kind,
  });
}

type SnapshotDocument = { path: string; content: string };

async function writeSnapshotDiff(params: {
  root: string;
  documents: readonly SnapshotDocument[];
}): Promise<void> {
  const expected = new Map(
    params.documents.map((document) => [document.path, document.content]),
  );
  for (const [relative, content] of expected) {
    const target = path.join(params.root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      if ((await fs.readFile(target, "utf8")) === content) continue;
    } catch {
      // The document does not exist yet.
    }
    await fs.writeFile(target, content, "utf8");
  }
  async function visit(directory: string): Promise<void> {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        if ((await fs.readdir(target).catch(() => [])).length === 0) {
          await fs.rmdir(target).catch(() => undefined);
        }
        continue;
      }
      const relative = path
        .relative(params.root, target)
        .split(path.sep)
        .join("/");
      if (!expected.has(relative)) await fs.rm(target, { force: true });
    }
  }
  await visit(params.root);
}

function snapshotDocuments(intents: readonly IntentCatalogEntry[]): {
  documents: SnapshotDocument[];
  collections: Record<string, { path: string; pattern: string }>;
} {
  const documents: SnapshotDocument[] = [];
  const append = (params: {
    root: string;
    intents: readonly IntentCatalogEntry[];
    kind: "trigger" | "example" | "keyword";
    texts: (intent: IntentCatalogEntry) => readonly string[];
  }) => {
    for (const intent of params.intents) {
      params.texts(intent).forEach((text, index) => {
        documents.push({
          path: path.join(params.root, `${intent.id}-${index}.md`),
          content: documentBody({ intent, kind: params.kind, text }),
        });
      });
    }
  };
  append({
    root: "triggers",
    intents,
    kind: "trigger",
    texts: (intent) => intent.definition.triggers,
  });
  append({
    root: "examples",
    intents,
    kind: "example",
    texts: (intent) => intent.definition.examples,
  });
  append({
    root: "keywords",
    intents,
    kind: "keyword",
    texts: (intent) => intent.definition.keywords,
  });
  const collections: Record<string, { path: string; pattern: string }> = {
    [TRIGGERS_COLLECTION]: { path: "triggers", pattern: "**/*.md" },
    [EXAMPLES_COLLECTION]: { path: "examples", pattern: "**/*.md" },
    [KEYWORDS_COLLECTION]: { path: "keywords", pattern: "**/*.md" },
  };
  return { documents, collections };
}

function parseHits(
  results: readonly QmdResult[],
  collection: string,
): QmdIntentHit[] {
  const hits: QmdIntentHit[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!Number.isFinite(result.score)) continue;
    let intentId: unknown;
    try {
      intentId = matter(result.body).data.intent_id;
    } catch {
      continue;
    }
    if (typeof intentId !== "string" || !intentId.trim()) continue;
    const normalizedId = intentId.trim().toLowerCase();
    if (seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    hits.push({
      intentId: intentId.trim(),
      score: result.score,
      collection,
      ...(result.explain === undefined ? {} : { explain: result.explain }),
    });
  }
  return hits;
}

function parseLexHits(
  results: readonly QmdLexResult[],
  collection: string,
): QmdIntentHit[] {
  const hits: QmdIntentHit[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!Number.isFinite(result.score)) continue;
    const match = /^(.+)-\d+\.md$/u.exec(path.basename(result.filepath));
    const intentId = match?.[1];
    if (!intentId) continue;
    const normalizedId = intentId.toLowerCase();
    if (seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    hits.push({ intentId, score: result.score, collection });
  }
  return hits;
}

export function createIntentQmdIndex(params: {
  dataRoot: string;
  config: () => ResolvedQmdConfig;
  createStore?: QmdCreateStore;
}): IntentQmdIndex {
  const databasePath = path.join(
    params.dataRoot,
    "qmd",
    "intent-routing.sqlite",
  );
  const snapshotRoot = path.join(params.dataRoot, "qmd", "intents");
  const metadataPath = path.join(
    params.dataRoot,
    "qmd",
    "intent-routing.json",
  );
  let currentFingerprint: string | undefined;
  let expectedFingerprint: string | undefined;
  let desired:
    { fingerprint: string; intents: readonly IntentCatalogEntry[] } | undefined;
  let store: QMDStore | undefined;
  let status: QmdIntentIndexStatus = "idle";
  let running: Promise<void> | undefined;
  let buildingFingerprint: string | undefined;
  let failedFingerprint: string | undefined;
  let consecutiveFailures = 0;
  let nextRetryAtMs = 0;

  async function writeSnapshot(
    intents: readonly IntentCatalogEntry[],
  ): Promise<{
    collections: Record<string, { path: string; pattern: string }>;
  }> {
    const snapshot = snapshotDocuments(intents);
    await writeSnapshotDiff({
      root: snapshotRoot,
      documents: snapshot.documents,
    });
    return {
      collections: Object.fromEntries(
        Object.entries(snapshot.collections).map(([name, collection]) => [
          name,
          { ...collection, path: path.join(snapshotRoot, collection.path) },
        ]),
      ),
    };
  }

  function resetRetryState(): void {
    failedFingerprint = undefined;
    consecutiveFailures = 0;
    nextRetryAtMs = 0;
  }

  function readPersistedFingerprint(): string | undefined {
    try {
      const metadata = readJsonFile<unknown>(metadataPath);
      return isIntentIndexMetadata(metadata) ? metadata.fingerprint : undefined;
    } catch {
      return;
    }
  }

  function persistFingerprint(fingerprint: string): void {
    writeJsonAtomic(metadataPath, {
      schemaVersion: INTENT_INDEX_METADATA_SCHEMA_VERSION,
      fingerprint,
    } satisfies IntentIndexMetadata);
  }

  async function reopenCompletedStore(
    fingerprint: string,
  ): Promise<QMDStore | undefined> {
    if (readPersistedFingerprint() !== fingerprint) return;
    const createQmdStore =
      params.createStore ?? (await import("@wei840222/qmd")).createStore;
    let reopenedStore: QMDStore | undefined;
    try {
      const qmd = params.config();
      reopenedStore = await createQmdStore({
        dbPath: databasePath,
        config: { collections: {}, models: buildStoreModels(qmd) },
        readOnly: true,
        remoteRequestTimeoutMs: qmd.timeoutMs,
      });
      const indexStatus = await reopenedStore.getStatus();
      if (indexStatus.needsEmbedding > 0 || indexStatus.totalDocuments <= 0) {
        await reopenedStore.close().catch(() => undefined);
        return;
      }
      return reopenedStore;
    } catch (error) {
      if (reopenedStore) await reopenedStore.close().catch(() => undefined);
      logger.warn("failed to reopen completed QMD intent index", { error });
      return;
    }
  }

  function recordBuildFailure(fingerprint: string, error: unknown): void {
    consecutiveFailures =
      failedFingerprint === fingerprint ? consecutiveFailures + 1 : 1;
    failedFingerprint = fingerprint;
    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
      MAX_RETRY_DELAY_MS,
    );
    nextRetryAtMs = Date.now() + delayMs;
    currentFingerprint = undefined;
    status = "failed";
    logger.warn("failed to refresh QMD intent index", { error, delayMs });
  }

  async function build(target: {
    fingerprint: string;
    intents: readonly IntentCatalogEntry[];
  }): Promise<void> {
    status = "building";
    let nextStore: QMDStore | undefined;
    try {
      const locked = await withFileLock(
        databasePath,
        async () => {
          const reopenedStore = await reopenCompletedStore(target.fingerprint);
          if (reopenedStore) {
            nextStore = reopenedStore;
            if (desired?.fingerprint === target.fingerprint) {
              await reopenedStore.close();
              nextStore = undefined;
              return;
            }
            const previousStore = store;
            store = reopenedStore;
            currentFingerprint = target.fingerprint;
            status = "ready";
            resetRetryState();
            if (previousStore) {
              await previousStore.close().catch((error: unknown) => {
                logger.warn("failed to close previous QMD intent index", {
                  error,
                });
              });
            }
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
          const { collections } = await writeSnapshot(target.intents);
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
              `QMD intent index embedding is incomplete (errors=${embedResult.errors}, needsEmbedding=${indexStatus.needsEmbedding}).`,
            );
          }

          if (desired?.fingerprint === target.fingerprint) {
            await nextStore.close();
            return;
          }
          const previousStore = store;
          persistFingerprint(target.fingerprint);
          store = nextStore;
          currentFingerprint = target.fingerprint;
          status = "ready";
          resetRetryState();
          if (previousStore) {
            await previousStore.close().catch((error: unknown) => {
              logger.warn("failed to close previous QMD intent index", {
                error,
              });
            });
          }
          return true;
        },
        { maxWaitMs: 30 * 60 * 1000 },
      );
      if (locked === undefined)
        throw new Error("intent index build lock is busy");
    } catch (error) {
      if (nextStore) await nextStore.close().catch(() => undefined);
      recordBuildFailure(target.fingerprint, error);
    }
  }

  async function runWorker(): Promise<void> {
    try {
      while (desired) {
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

  return {
    schedule(intents) {
      const fingerprint = snapshotFingerprint(intents, params.config());
      if (
        (fingerprint === currentFingerprint ||
          fingerprint === buildingFingerprint) &&
        (!desired || desired.fingerprint === fingerprint) &&
        (store !== undefined || buildingFingerprint !== undefined)
      ) {
        expectedFingerprint = fingerprint;
        return;
      }
      if (desired?.fingerprint === fingerprint) {
        expectedFingerprint = fingerprint;
        return;
      }
      expectedFingerprint = fingerprint;
      if (failedFingerprint === fingerprint && Date.now() < nextRetryAtMs) {
        return;
      }
      desired = { fingerprint, intents: [...intents] };
      if (!running) {
        running = runWorker();
      }
    },
    async searchIntentTriggers({ query, rawLimit, expansionContext }) {
      if (!isReadyForCurrentCatalog()) return;
      const activeStore = store;
      if (!activeStore) return;
      try {
        const results = (await activeStore.search({
          query: boundQmdQuery(query),
          collections: [TRIGGERS_COLLECTION, EXAMPLES_COLLECTION],
          includeHyde: false,
          ...(expansionContext ? { expansionContext } : {}),
          rerank: false,
          limit: rawLimit,
          candidateLimit: rawLimit,
          minScore: 0,
          explain: true,
        })) as QmdResult[];
        return parseHits(results, "intent-triggers-and-examples");
      } catch (error) {
        logger.warn("QMD intent trigger search failed", { error });
        return;
      }
    },
    async searchKeywords({ query, limit = 1 }) {
      if (!isReadyForCurrentCatalog()) return;
      const activeStore = store;
      if (!activeStore) return;
      try {
        const results = (await activeStore.searchLex(query, {
          collection: KEYWORDS_COLLECTION,
          limit,
        })) as QmdLexResult[];
        return parseLexHits(results, KEYWORDS_COLLECTION);
      } catch (error) {
        return;
      }
    },
    getStatus: () => status,
    async close() {
      desired = undefined;
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
