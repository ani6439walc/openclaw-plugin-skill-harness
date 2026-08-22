import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import type { IntentCatalogEntry, ResolvedQmdConfig } from "../types.js";

const TRIGGERS_COLLECTION = "intent-triggers";
const EXAMPLES_COLLECTION = "intent-examples";

type QmdCreateStore = typeof createStore;

type QmdResult = {
  body: string;
  score: number;
  explain?: unknown;
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
  }): Promise<QmdIntentHit[] | undefined>;
  searchTopicKeywords(params: {
    query: string;
    domain: string;
  }): Promise<QmdIntentHit[] | undefined>;
  getStatus(): QmdIntentIndexStatus;
  close(): Promise<void>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
        fastpathKeywords: intent.definition.fastpath.keywords,
      })),
      qmd: config,
    }),
  );
}

function topicCollectionName(domain: string): string {
  return `intent-topic-keywords-${hash(domain).slice(0, 12)}`;
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
  kind: "trigger" | "example" | "topic-keyword";
  text: string;
}): string {
  return matter.stringify(params.text.trim(), {
    intent_id: params.intent.id,
    domain: params.intent.definition.domain,
    kind: params.kind,
  });
}

async function writeDocuments(params: {
  root: string;
  intents: readonly IntentCatalogEntry[];
  kind: "trigger" | "example" | "topic-keyword";
  texts: (intent: IntentCatalogEntry) => readonly string[];
}): Promise<void> {
  await fs.mkdir(params.root, { recursive: true });
  await Promise.all(
    params.intents.flatMap((intent) =>
      params
        .texts(intent)
        .map((text, index) =>
          fs.writeFile(
            documentPath(params.root, intent, index),
            documentBody({ intent, kind: params.kind, text }),
            "utf8",
          ),
        ),
    ),
  );
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
  const createQmdStore = params.createStore ?? createStore;
  let currentFingerprint: string | undefined;
  let expectedFingerprint: string | undefined;
  let desired:
    { fingerprint: string; intents: readonly IntentCatalogEntry[] } | undefined;
  let store: QMDStore | undefined;
  let status: QmdIntentIndexStatus = "idle";
  let running: Promise<void> | undefined;

  async function writeSnapshot(
    intents: readonly IntentCatalogEntry[],
  ): Promise<{
    collections: Record<string, { path: string; pattern: string }>;
  }> {
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    const triggersRoot = path.join(snapshotRoot, "triggers");
    const examplesRoot = path.join(snapshotRoot, "examples");
    await writeDocuments({
      root: triggersRoot,
      intents,
      kind: "trigger",
      texts: (intent) => intent.definition.triggers,
    });
    await writeDocuments({
      root: examplesRoot,
      intents,
      kind: "example",
      texts: (intent) => intent.definition.examples,
    });

    const collections: Record<string, { path: string; pattern: string }> = {
      [TRIGGERS_COLLECTION]: { path: triggersRoot, pattern: "**/*.md" },
      [EXAMPLES_COLLECTION]: { path: examplesRoot, pattern: "**/*.md" },
    };
    const domains = [
      ...new Set(intents.map((intent) => intent.definition.domain)),
    ];
    for (const domain of domains) {
      const collectionName = topicCollectionName(domain);
      const root = path.join(snapshotRoot, "topic-keywords", collectionName);
      await writeDocuments({
        root,
        intents: intents.filter(
          (intent) => intent.definition.domain === domain,
        ),
        kind: "topic-keyword",
        texts: (intent) => intent.definition.fastpath.keywords,
      });
      collections[collectionName] = { path: root, pattern: "**/*.md" };
    }
    return { collections };
  }

  async function build(): Promise<void> {
    while (desired) {
      const target = desired;
      desired = undefined;
      status = "building";
      let nextStore: QMDStore | undefined;
      try {
        const qmd = params.config();
        if (
          !qmd.embedding.baseUrl ||
          !qmd.embedding.model ||
          !qmd.expansion.baseUrl ||
          !qmd.expansion.model ||
          !qmd.rerank.baseUrl ||
          !qmd.rerank.model
        ) {
          throw new Error(
            "QMD embedding, expansion, and rerank endpoints must be configured.",
          );
        }
        const { collections } = await writeSnapshot(target.intents);
        nextStore = await createQmdStore({
          dbPath: databasePath,
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
              rerank_api_url: qmd.rerank.baseUrl,
              rerank_api_model: qmd.rerank.model,
              ...(qmd.rerank.apiKey
                ? { rerank_api_key: qmd.rerank.apiKey }
                : {}),
            },
          },
          remoteRequestTimeoutMs: qmd.timeoutMs,
        });
        await nextStore.update();
        await nextStore.embed();

        const newerRequest = desired as
          | { fingerprint: string; intents: readonly IntentCatalogEntry[] }
          | undefined;
        if (newerRequest?.fingerprint === target.fingerprint) {
          await nextStore.close();
          continue;
        }
        const previousStore = store;
        store = nextStore;
        currentFingerprint = target.fingerprint;
        status = "ready";
        if (previousStore) await previousStore.close();
      } catch (error) {
        if (nextStore) await nextStore.close().catch(() => undefined);
        currentFingerprint = undefined;
        status = "failed";
        logger.warn("failed to refresh QMD intent index", { error });
      }
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
      if (fingerprint === currentFingerprint && !desired) return;
      expectedFingerprint = fingerprint;
      desired = { fingerprint, intents: [...intents] };
      if (!running) {
        running = build().finally(() => {
          running = undefined;
          if (desired) {
            running = build().finally(() => {
              running = undefined;
            });
          }
        });
      }
    },
    async searchIntentTriggers({ query, rawLimit }) {
      if (!isReadyForCurrentCatalog()) return;
      const activeStore = store;
      if (!activeStore) return;
      try {
        const results = (await activeStore.search({
          query,
          collections: [TRIGGERS_COLLECTION, EXAMPLES_COLLECTION],
          expansion: "force",
          rerank: true,
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
    async searchTopicKeywords({ query, domain }) {
      if (!isReadyForCurrentCatalog()) return;
      const activeStore = store;
      if (!activeStore) return;
      try {
        const collection = topicCollectionName(domain);
        const results = (await activeStore.search({
          query,
          collections: [collection],
          expansion: "force",
          rerank: true,
          limit: 1,
          candidateLimit: 1,
          minScore: 0,
          explain: true,
        })) as QmdResult[];
        return parseHits(results, collection);
      } catch (error) {
        logger.warn("QMD topic-keyword search failed", { error, domain });
        return;
      }
    },
    getStatus: () => status,
    async close() {
      desired = undefined;
      await running;
      const activeStore = store;
      store = undefined;
      currentFingerprint = undefined;
      expectedFingerprint = undefined;
      status = "idle";
      if (activeStore) await activeStore.close();
    },
  };
}
