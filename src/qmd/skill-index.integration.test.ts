import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scheduler } from "node:timers/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStore,
  type QMDStore,
  type StoreOptions,
} from "@wei840222/qmd";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import { createSkillQmdIndex } from "./skill-index.js";

const roots: string[] = [];
const servers: Server[] = [];

interface EmbeddingFixture {
  baseUrl: string;
  inputs: string[][];
  failNextEmbeddingRequests(count: number): void;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close((error) => (error ? reject(error) : resolve()));
        return promise;
      },
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createEmbeddingFixture(): Promise<EmbeddingFixture> {
  const inputs: string[][] = [];
  let remainingFailures = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/embeddings") {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        input: unknown;
        model: unknown;
        dimensions: unknown;
      };
      const batch = Array.isArray(parsed.input)
        ? parsed.input.filter((value): value is string => typeof value === "string")
        : [];
      inputs.push(batch);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            model:
              typeof parsed.model === "string"
                ? parsed.model
                : "text-embedding-3-small",
            data: [],
            usage: { prompt_tokens: 0, total_tokens: 0 },
          }),
        );
        return;
      }
      const dimension =
        typeof parsed.dimensions === "number" ? parsed.dimensions : 1536;
      const model = typeof parsed.model === "string" ? parsed.model : "text-embedding-3-small";
      const data = batch.map((text, index) => {
        const seed = [...text].reduce((total, character) => total + character.charCodeAt(0), 1);
        return {
          object: "embedding",
          index,
          embedding: Array.from(
            { length: dimension },
            (_, offset) => ((seed + offset + 1) % 997) / 997,
          ),
        };
      });
      const promptTokens = batch.reduce(
        (total, text) => total + Buffer.byteLength(text),
        0,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          model,
          data,
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        }),
      );
    });
  });
  servers.push(server);
  const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    inputs,
    failNextEmbeddingRequests(count) {
      remainingFailures = count;
    },
  };
}

async function createSkill(params: {
  name: string;
  description: string;
  body: string;
}): Promise<AvailableSkill> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-harness-real-qmd-skill-"));
  roots.push(root);
  const directory = path.join(root, params.name);
  await mkdir(directory, { recursive: true });
  const location = path.join(directory, "SKILL.md");
  await writeFile(
    location,
    `---\nname: ${params.name}\ndescription: ${params.description}\n---\n\n${params.body}\n`,
    "utf8",
  );
  return {
    name: params.name,
    description: params.description,
    location,
    source: "workspace",
  };
}

function configFor(baseUrl: string): ResolvedQmdConfig {
  return {
    timeoutMs: 5_000,
    embedding: {
      baseUrl,
      model: "text-embedding-3-small",
      apiKey: "test-key",
      dimension: 1536,
    },
    expansion: {
      baseUrl,
      model: "test-expansion",
      apiKey: "test-key",
    },
    skills: {
      search: {
        collectionWeights: { meta: 2, body: 1, references: 0.5 },
      },
    },
  };
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await scheduler.yield();
  }
  throw new Error(message);
}

function flattenedInputs(fixture: EmbeddingFixture, from = 0): string[] {
  return fixture.inputs.slice(from).flat();
}

describe("createSkillQmdIndex real QMD integration", () => {
  it("incrementally embeds changed documents in one SQLite and lazy-opens it after restart", async () => {
    const fixture = await createEmbeddingFixture();
    const dataRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-real-qmd-index-"));
    roots.push(dataRoot);
    const alpha = await createSkill({
      name: "alpha",
      description: "Alpha integration skill",
      body: "alphaversionone integration marker",
    });
    const beta = await createSkill({
      name: "beta",
      description: "Beta integration skill",
      body: "betastableterm integration marker",
    });
    const sourceRoots = [path.dirname(path.dirname(alpha.location))];
    const databasePaths: string[] = [];
    let completedEmbeds = 0;
    const createTrackedStore = async (options: StoreOptions): Promise<QMDStore> => {
      databasePaths.push(options.dbPath);
      const store = await createStore(options);
      const searchLex = store.searchLex.bind(store);
      store.search = async (options) =>
        storeSearchFromLex(searchLex, options.query, options.collection, options.limit);
      const embed = store.embed.bind(store);
      store.embed = async (embedOptions) => {
        try {
          return await embed(embedOptions);
        } finally {
          completedEmbeds += 1;
        }
      };
      return store;
    };
    const storeSearchFromLex = async (
      searchLex: QMDStore["searchLex"],
      query: string | undefined,
      collection: string | undefined,
      limit: number | undefined,
    ) => {
      if (!query) return [];
      return searchLex(query, { collection, limit });
    };
    const index = createSkillQmdIndex({
      dataRoot,
      config: () => configFor(fixture.baseUrl),
      createStore: createTrackedStore,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    index.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 1 || index.getStatus("main") === "failed",
      "initial real QMD embed did not finish",
    );
    expect(index.getStatus("main"), JSON.stringify({ databasePaths, inputs: fixture.inputs })).toBe("ready");
    const initialInputs = flattenedInputs(fixture);
    expect(initialInputs.some((input) => input.includes("alphaversionone"))).toBe(true);
    expect(initialInputs.some((input) => input.includes("betastableterm"))).toBe(true);

    await scheduler.yield();
    const afterInitialRequests = fixture.inputs.length;
    await writeFile(
      alpha.location,
      "---\nname: alpha\ndescription: Alpha integration skill\n---\n\nalphaversiontwo integration marker\n",
      "utf8",
    );
    index.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(() => completedEmbeds === 2, "changed-document embed did not finish");
    const changedInputs = flattenedInputs(fixture, afterInitialRequests);
    expect(changedInputs.some((input) => input.includes("alphaversiontwo"))).toBe(true);
    expect(changedInputs.some((input) => input.includes("betastableterm"))).toBe(false);

    await scheduler.yield();
    const gamma = await createSkill({
      name: "gamma",
      description: "Gamma integration skill",
      body: "gammanewterm integration marker",
    });
    const afterChangedRequests = fixture.inputs.length;
    index.schedule("main", { skills: [alpha, beta, gamma], sourceRoots });
    await waitUntil(() => completedEmbeds === 3, "new-document embed did not finish");
    const addedInputs = flattenedInputs(fixture, afterChangedRequests);
    expect(addedInputs.some((input) => input.includes("gammanewterm"))).toBe(true);
    expect(addedInputs.some((input) => input.includes("alphaversiontwo"))).toBe(false);
    expect(addedInputs.some((input) => input.includes("betastableterm"))).toBe(false);

    await scheduler.yield();
    const beforeRemovalRequests = fixture.inputs.length;
    index.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(() => completedEmbeds === 4, "removed-document refresh did not finish");
    expect(fixture.inputs).toHaveLength(beforeRemovalRequests);

    await scheduler.yield();
    index.schedule("lite", { skills: [beta], sourceRoots });
    await waitUntil(() => completedEmbeds === 5, "shared-agent refresh did not finish");
    const mainResults = await index.search({
      agentId: "main",
      query: "alphaversiontwo",
      limit: 5,
    });
    const liteResults = await index.search({
      agentId: "lite",
      query: "alphaversiontwo",
      limit: 5,
    });
    expect(mainResults?.map((result) => result.name)).toContain("alpha");
    expect(liteResults ?? []).toEqual([]);
    expect(new Set(databasePaths).size).toBe(1);

    const documentInputsBeforeRestart = flattenedInputs(fixture).filter(
      (input) => input !== "betastableterm" && input.includes("integration marker"),
    ).length;
    await index.close();

    let restartEmbeds = 0;
    const restarted = createSkillQmdIndex({
      dataRoot,
      config: () => configFor(fixture.baseUrl),
      createStore: async (options) => {
        const store = await createStore(options);
        const searchLex = store.searchLex.bind(store);
        store.search = async (options) =>
          storeSearchFromLex(searchLex, options.query, options.collection, options.limit);
        const embed = store.embed.bind(store);
        store.embed = async (embedOptions) => {
          restartEmbeds += 1;
          return embed(embedOptions);
        };
        return store;
      },
    });
    const restartedResults = await restarted.search({
      agentId: "main",
      query: "betastableterm",
      limit: 5,
    });
    expect(restartedResults?.map((result) => result.name)).toContain("beta");
    expect(restartEmbeds).toBe(0);
    expect(
      flattenedInputs(fixture).filter(
        (input) => input !== "betastableterm" && input.includes("integration marker"),
      ),
    ).toHaveLength(documentInputsBeforeRestart);
    await restarted.close();
  });

  it("keeps lexical search available while real QMD retries pending embeddings", async () => {
    const fixture = await createEmbeddingFixture();
    const dataRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-real-qmd-partial-"));
    roots.push(dataRoot);
    const skill = await createSkill({
      name: "partial",
      description: "Partial integration skill",
      body: "partiallexicalterm initial marker",
    });
    const pendingTimers: Array<() => void> = [];
    let store: QMDStore | undefined;
    let completedEmbeds = 0;
    const index = createSkillQmdIndex({
      dataRoot,
      config: () => configFor(fixture.baseUrl),
      createStore: async (options) => {
        store = await createStore(options);
        const searchLex = store.searchLex.bind(store);
        store.search = async (searchOptions) => {
          if (!searchOptions.query) return [];
          return searchLex(searchOptions.query, {
            collection: searchOptions.collection,
            limit: searchOptions.limit,
          });
        };
        const embed = store.embed.bind(store);
        store.embed = async (embedOptions) => {
          try {
            return await embed(embedOptions);
          } finally {
            completedEmbeds += 1;
          }
        };
        return store;
      },
      setTimer: (callback) => {
        pendingTimers.push(callback);
        return callback;
      },
      clearTimer: (timer) => {
        const position = pendingTimers.indexOf(timer as () => void);
        if (position >= 0) pendingTimers.splice(position, 1);
      },
    });
    const sourceRoots = [path.dirname(path.dirname(skill.location))];
    index.schedule("main", { skills: [skill], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 1 || index.getStatus("main") === "failed",
      "initial partial fixture embed did not finish",
    );
    expect(index.getStatus("main"), JSON.stringify({ hasStore: Boolean(store), inputs: fixture.inputs })).toBe("ready");

    await scheduler.yield();
    await writeFile(
      skill.location,
      "---\nname: partial\ndescription: Partial integration skill\n---\n\npartiallexicalterm changed marker\n",
      "utf8",
    );
    fixture.failNextEmbeddingRequests(9);
    index.schedule("main", { skills: [skill], sourceRoots });
    await waitUntil(() => completedEmbeds === 2, "failed real QMD embed did not finish");
    expect(
      pendingTimers.length,
      JSON.stringify({
        status: index.getStatus("main"),
        storeStatus: await store?.getStatus(),
        inputs: fixture.inputs.length,
      }),
    ).toBe(1);

    expect(index.getStatus("main")).toBe("ready");
    expect((await store?.getStatus())?.needsEmbedding).toBeGreaterThan(0);
    const searchable = await index.search({
      agentId: "main",
      query: "partiallexicalterm",
      limit: 5,
    });
    expect(searchable?.map((result) => result.name)).toContain("partial");

    fixture.failNextEmbeddingRequests(0);
    pendingTimers.shift()?.();
    await waitUntil(() => completedEmbeds === 3, "real QMD retry did not finish");
    expect((await store?.getStatus())?.needsEmbedding).toBe(0);
    expect(index.getStatus("main")).toBe("ready");
    await index.close();
  });
});
