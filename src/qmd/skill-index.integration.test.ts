import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scheduler } from "node:timers/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type QMDStore, type StoreOptions } from "@wei840222/qmd";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import { createSkillQmdIndex } from "./skill-index.js";
import { createSkillExperienceQmdIndex } from "./experience-index.js";

const roots: string[] = [];
const servers: Server[] = [];

interface EmbeddingFixture {
  baseUrl: string;
  inputs: string[][];
  requests: Array<Record<string, unknown>>;
  failNextEmbeddingRequests(count: number): void;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    }),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createEmbeddingFixture(): Promise<EmbeddingFixture> {
  const inputs: string[][] = [];
  const requests: Array<Record<string, unknown>> = [];
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
        output_dimension: unknown;
      };
      requests.push(parsed);
      const batch = Array.isArray(parsed.input)
        ? parsed.input.filter(
            (value): value is string => typeof value === "string",
          )
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
        typeof parsed.output_dimension === "number"
          ? parsed.output_dimension
          : typeof parsed.dimensions === "number"
            ? parsed.dimensions
            : 1536;
      const model =
        typeof parsed.model === "string"
          ? parsed.model
          : "text-embedding-3-small";
      const data = batch.map((text, index) => {
        const seed = [...text].reduce(
          (total, character) => total + character.charCodeAt(0),
          1,
        );
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
  if (!address || typeof address === "string")
    throw new Error("missing server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    inputs,
    requests,
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
  const root = await mkdtemp(
    path.join(tmpdir(), "skill-harness-real-qmd-skill-"),
  );
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
    indexRefreshIntervalSeconds: 300,
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
  it("refreshes a live discovery mapping using read-only real SQLite stores", async () => {
    const fixture = await createEmbeddingFixture();
    const dataRoot = await mkdtemp(
      path.join(tmpdir(), "skill-discovery-real-qmd-"),
    );
    roots.push(dataRoot);
    const alpha = await createSkill({
      name: "alpha",
      description: "Alpha skill",
      body: "alphadiscoverymarker",
    });
    const beta = await createSkill({
      name: "beta",
      description: "Beta skill",
      body: "betadiscoverymarker",
    });
    let publications = 0;
    const modes: Array<boolean | undefined> = [];
    const trackedStore = async (options: StoreOptions): Promise<QMDStore> => {
      modes.push(options.readOnly);
      const store = await createStore(options);
      store.search = async (query) =>
        store.searchLex(query.query ?? "", {
          collection: query.collection,
          limit: query.limit,
        });
      const embed = store.embed.bind(store);
      store.embed = async (options) => {
        const result = await embed(options);
        publications += 1;
        return result;
      };
      return store;
    };
    const full = createSkillQmdIndex({
      dataRoot,
      config: () => configFor(fixture.baseUrl),
      createStore: trackedStore,
    });
    const discovery = createSkillQmdIndex({
      dataRoot,
      readOnly: true,
      config: () => configFor(fixture.baseUrl),
      createStore: trackedStore,
    });
    const search = (query: string) =>
      discovery.search({ agentId: "main", query, limit: 5 });
    try {
      expect(await search("alphadiscoverymarker")).toBeUndefined();
      full.schedule("main", {
        skills: [alpha],
        sourceRoots: [path.dirname(alpha.location)],
      });
      await waitUntil(
        () => publications === 1 && full.getStatus("main") === "ready",
        "alpha publication",
      );
      await waitUntil(
        async () =>
          (await search("alphadiscoverymarker"))?.some(
            (hit) => hit.name === "alpha",
          ) === true,
        "discovery alpha recovery",
      );
      full.schedule("main", {
        skills: [beta],
        sourceRoots: [path.dirname(beta.location)],
      });
      await waitUntil(
        () => publications === 2 && full.getStatus("main") === "ready",
        "beta publication",
      );
      await waitUntil(
        async () =>
          (await search("betadiscoverymarker"))?.some(
            (hit) => hit.name === "beta",
          ) === true,
        "discovery beta switch",
      );
      expect(await search("alphadiscoverymarker")).toEqual([]);
      expect(modes.filter((mode) => mode === true)).toHaveLength(2);
      expect(publications).toBe(2);
    } finally {
      await discovery.close();
      await full.close();
    }
  });

  it("incrementally embeds changed documents in one SQLite and lazy-opens it after restart", async () => {
    const fixture = await createEmbeddingFixture();
    const dataRoot = await mkdtemp(
      path.join(tmpdir(), "skill-harness-real-qmd-index-"),
    );
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
    const createTrackedStore = async (
      options: StoreOptions,
    ): Promise<QMDStore> => {
      databasePaths.push(options.dbPath);
      const store = await createStore(options);
      const searchLex = store.searchLex.bind(store);
      store.search = async (options) =>
        storeSearchFromLex(
          searchLex,
          options.query,
          options.collection,
          options.limit,
        );
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
    expect(
      index.getStatus("main"),
      JSON.stringify({ databasePaths, inputs: fixture.inputs }),
    ).toBe("ready");
    const initialInputs = flattenedInputs(fixture);
    expect(
      initialInputs.some((input) => input.includes("alphaversionone")),
    ).toBe(true);
    expect(
      initialInputs.some((input) => input.includes("betastableterm")),
    ).toBe(true);

    await scheduler.yield();
    const afterInitialRequests = fixture.inputs.length;
    await writeFile(
      alpha.location,
      "---\nname: alpha\ndescription: Alpha integration skill\n---\n\nalphaversiontwo integration marker\n",
      "utf8",
    );
    index.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 2,
      "changed-document embed did not finish",
    );
    const changedInputs = flattenedInputs(fixture, afterInitialRequests);
    expect(
      changedInputs.some((input) => input.includes("alphaversiontwo")),
    ).toBe(true);
    expect(
      changedInputs.some((input) => input.includes("betastableterm")),
    ).toBe(false);

    await scheduler.yield();
    const gamma = await createSkill({
      name: "gamma",
      description: "Gamma integration skill",
      body: "gammanewterm integration marker",
    });
    const afterChangedRequests = fixture.inputs.length;
    index.schedule("main", { skills: [alpha, beta, gamma], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 3,
      "new-document embed did not finish",
    );
    const addedInputs = flattenedInputs(fixture, afterChangedRequests);
    expect(addedInputs.some((input) => input.includes("gammanewterm"))).toBe(
      true,
    );
    expect(addedInputs.some((input) => input.includes("alphaversiontwo"))).toBe(
      false,
    );
    expect(addedInputs.some((input) => input.includes("betastableterm"))).toBe(
      false,
    );

    await scheduler.yield();
    const beforeRemovalRequests = fixture.inputs.length;
    index.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 4,
      "removed-document refresh did not finish",
    );
    expect(fixture.inputs).toHaveLength(beforeRemovalRequests);

    await scheduler.yield();
    index.schedule("lite", { skills: [beta], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 5,
      "shared-agent refresh did not finish",
    );
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
      (input) =>
        input !== "betastableterm" && input.includes("integration marker"),
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
          storeSearchFromLex(
            searchLex,
            options.query,
            options.collection,
            options.limit,
          );
        const embed = store.embed.bind(store);
        store.embed = async (embedOptions) => {
          const result = await embed(embedOptions);
          restartEmbeds += 1;
          return result;
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
        (input) =>
          input !== "betastableterm" && input.includes("integration marker"),
      ),
    ).toHaveLength(documentInputsBeforeRestart);
    const requestsBeforeRefresh = fixture.inputs.length;
    restarted.schedule("main", { skills: [alpha, beta], sourceRoots });
    await waitUntil(
      () => restartEmbeds === 1,
      "restart refresh did not finish",
    );
    expect(fixture.inputs).toHaveLength(requestsBeforeRefresh);
    await restarted.close();
  }, 30_000);

  it("keeps lexical search available while real QMD retries pending embeddings", async () => {
    const fixture = await createEmbeddingFixture();
    const dataRoot = await mkdtemp(
      path.join(tmpdir(), "skill-harness-real-qmd-partial-"),
    );
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
    expect(
      index.getStatus("main"),
      JSON.stringify({ hasStore: Boolean(store), inputs: fixture.inputs }),
    ).toBe("ready");

    await scheduler.yield();
    await writeFile(
      skill.location,
      "---\nname: partial\ndescription: Partial integration skill\n---\n\npartiallexicalterm changed marker\n",
      "utf8",
    );
    fixture.failNextEmbeddingRequests(9);
    index.schedule("main", { skills: [skill], sourceRoots });
    await waitUntil(
      () => completedEmbeds === 2,
      "failed real QMD embed did not finish",
    );
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
    await waitUntil(
      () => completedEmbeds === 3,
      "real QMD retry did not finish",
    );
    expect((await store?.getStatus())?.needsEmbedding).toBe(0);
    expect(index.getStatus("main")).toBe("ready");
    await index.close();
  }, 30_000);
});

describe("Voyage SDK upgrade", () => {
  it("sends native Voyage payloads and shares the configured document cache with another process", async () => {
    const fixture = await createEmbeddingFixture();
    const root = await mkdtemp(path.join(tmpdir(), "voyage-cache-"));
    roots.push(root);
    const skill = await createSkill({
      name: "voyage",
      description: "Voyage fixture",
      body: "voyagecachemarker",
    });
    const config = configFor(fixture.baseUrl);
    config.embedding = {
      ...config.embedding,
      model: "voyage-4",
      dimension: 1024,
    };
    config.embeddingCacheDir = path.join(root, "cache");
    let opened: StoreOptions | undefined;
    let active: QMDStore | undefined;
    let embedded = false;
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => config,
      createStore: async (options) => {
        opened = options;
        active = await createStore(options);
        const embed = active.embed.bind(active);
        active.embed = async (options) => {
          const result = await embed(options);
          embedded = true;
          return result;
        };
        return active;
      },
    });
    try {
      index.schedule("main", {
        skills: [skill],
        sourceRoots: [path.dirname(skill.location)],
      });
      await waitUntil(() => embedded, "Voyage embedding");
      expect((await active!.getStatus()).needsEmbedding).toBe(0);
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(
        fixture.requests.every(
          (request) =>
            request.input_type === "document" &&
            request.output_dimension === 1024 &&
            request.model === "voyage-4" &&
            !("dimensions" in request),
        ),
      ).toBe(true);
      expect(
        (
          await stat(
            path.join(
              config.embeddingCacheDir,
              "document-embeddings-v1.sqlite",
            ),
          )
        ).size,
      ).toBeGreaterThan(0);
      const beforeReuse = fixture.requests.length;
      // A fresh process cannot hit the first store's in-memory embedding cache.
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createStore } from "@wei840222/qmd";
        const store = await createStore(JSON.parse(process.argv[1]));
        try {
          await store.update();
          const result = await store.embed();
          if (result.errors || (await store.getStatus()).needsEmbedding) throw new Error("incomplete embedding");
        } finally { await store.close(); }
      `,
          JSON.stringify({
            ...opened,
            dbPath: path.join(root, "second.sqlite"),
          }),
        ],
        { cwd: process.cwd(), timeout: 15_000 },
      );
      expect(fixture.requests).toHaveLength(beforeReuse);
      expect(await active!.searchVector("voyagecachemarker")).not.toHaveLength(
        0,
      );
      expect(fixture.requests.at(-1)).toMatchObject({
        input_type: "query",
        output_dimension: 1024,
        model: "voyage-4",
      });
    } finally {
      await index.close();
    }
  }, 30_000);

  it.each(["skills", "experiences"] as const)(
    "requires an explicit one-time rebuild for an OpenAI-compatible Voyage %s database",
    async (kind) => {
      const fixture = await createEmbeddingFixture();
      const root = await mkdtemp(path.join(tmpdir(), "voyage-upgrade-"));
      roots.push(root);
      const config = configFor(fixture.baseUrl);
      config.embedding = {
        ...config.embedding,
        model: "voyage-4",
        dimension: 1024,
      };
      const skill = await createSkill({
        name: "legacy",
        description: "Legacy Voyage fixture",
        body: "legacyvoyagemarker",
      });
      const entries = [
        {
          id: "legacy",
          summary: "Legacy Voyage fixture",
          keywords: ["voyage"],
          body: "legacyvoyagemarker",
          skills: [],
          path: root,
        },
      ];
      let opened: StoreOptions | undefined;
      let complete = false;
      // Reproduce 2026.9.30's OpenAI-compatible provider identity and vectors.
      const legacyStore = async (options: StoreOptions) => {
        opened = options;
        const store = await createStore({
          ...options,
          config: {
            ...options.config,
            models: { ...options.config?.models, embed_provider: "openai" },
          },
        });
        const embed = store.embed.bind(store);
        store.embed = async (options) => {
          const result = await embed(options);
          complete = true;
          return result;
        };
        return store;
      };
      const skillIndex =
        kind === "skills"
          ? createSkillQmdIndex({
              dataRoot: root,
              config: () => config,
              createStore: legacyStore,
            })
          : undefined;
      const experienceIndex =
        kind === "experiences"
          ? createSkillExperienceQmdIndex({
              dataRoot: root,
              config: () => config,
              createStore: legacyStore,
            })
          : undefined;
      try {
        skillIndex?.schedule("main", {
          skills: [skill],
          sourceRoots: [path.dirname(skill.location)],
        });
        experienceIndex?.schedule(entries);
        await waitUntil(() => complete, "legacy Voyage fixture");
      } finally {
        await skillIndex?.close();
        await experienceIndex?.close();
      }
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(
        fixture.requests.every(
          (request) =>
            request.dimensions === 1024 && !("input_type" in request),
        ),
      ).toBe(true);
      const reopenedStores: QMDStore[] = [];
      const refreshErrors: unknown[] = [];
      const nativeStore = async (options: StoreOptions) => {
        const store = await createStore(options);
        reopenedStores.push(store);
        const search = store.search.bind(store);
        // Keep real hybrid retrieval but avoid a generator request in this fixture.
        store.search = (options) => search({ ...options, expansion: "skip" });
        const embed = store.embed.bind(store);
        store.embed = async (options) => {
          try {
            return await embed(options);
          } catch (error) {
            refreshErrors.push(error);
            throw error;
          }
        };
        return store;
      };
      const reopen = (readOnly: boolean) => {
        const skills =
          kind === "skills"
            ? createSkillQmdIndex({
                dataRoot: root,
                config: () => config,
                createStore: nativeStore,
                readOnly,
              })
            : undefined;
        const experiences =
          kind === "experiences"
            ? createSkillExperienceQmdIndex({
                dataRoot: root,
                config: () => config,
                createStore: nativeStore,
                readOnly,
                getEntries: () => entries,
              })
            : undefined;
        skills?.schedule("main", {
          skills: [skill],
          sourceRoots: [path.dirname(skill.location)],
        });
        experiences?.schedule(entries);
        return {
          search: () =>
            skills
              ? skills.search({
                  agentId: "main",
                  query: "legacyvoyagemarker",
                  limit: 5,
                })
              : experiences!.search({ query: "legacyvoyagemarker", limit: 5 }),
          status: () =>
            skills ? skills.getStatus("main") : experiences!.getStatus(),
          close: async () => {
            await skills?.close();
            await experiences?.close();
          },
        };
      };
      const upgraded = reopen(false);
      const requestsBeforeRefresh = fixture.requests.length;
      try {
        await waitUntil(
          () => upgraded.status() === "ready",
          "upgraded plugin readiness",
        );
        // Readiness includes lexical retrieval; it does not establish vector compatibility.
        expect(await upgraded.search()).not.toHaveLength(0);
        if (kind === "skills") {
          await waitUntil(
            () => refreshErrors.length > 0,
            "incompatible skill refresh",
          );
          expect(refreshErrors[0]).toMatchObject({ code: "IDENTITY_MISMATCH" });
        } else {
          // Matching experience metadata skips embedding on ordinary startup.
          expect(refreshErrors).toHaveLength(0);
        }
        expect(upgraded.status()).toBe("ready");
        expect(fixture.requests).toHaveLength(requestsBeforeRefresh);
        expect(reopenedStores.length).toBeGreaterThan(0);
        for (const store of reopenedStores) {
          expect(
            (await store.getStatus()).diagnostics?.embedding,
          ).toMatchObject({
            provider: { id: "voyageai" },
            identity: { compatible: false },
          });
        }
      } finally {
        await upgraded.close();
      }
      const native = await createStore(opened!);
      try {
        expect(
          (await native.getStatus()).diagnostics?.embedding.identity.compatible,
        ).toBe(false);
        const requestsBefore = fixture.requests.length;
        expect(await native.searchVector("legacyvoyagemarker")).toEqual([]);
        await native.update();
        await expect(native.embed()).rejects.toMatchObject({
          code: "IDENTITY_MISMATCH",
        });
        expect(fixture.requests).toHaveLength(requestsBefore);
        expect((await native.embed({ force: true })).errors).toBe(0);
        expect(
          (await native.getStatus()).diagnostics?.embedding.build.state,
        ).toBe("ready");
        expect(
          (await native.getStatus()).diagnostics?.embedding.identity.compatible,
        ).toBe(true);
        expect(
          await native.searchVector("legacyvoyagemarker"),
        ).not.toHaveLength(0);
        const requestsAfter = fixture.requests.length;
        expect((await native.embed()).docsProcessed).toBe(0);
        expect(fixture.requests).toHaveLength(requestsAfter);
      } finally {
        await native.close();
      }
      reopenedStores.length = 0;
      const discovery = reopen(true);
      try {
        expect(await discovery.search()).not.toHaveLength(0);
        expect(discovery.status()).toBe("ready");
        expect(reopenedStores.length).toBeGreaterThan(0);
        for (const store of reopenedStores) {
          expect(
            (await store.getStatus()).diagnostics?.embedding,
          ).toMatchObject({
            provider: { id: "voyageai" },
            identity: { compatible: true },
            build: { state: "ready" },
          });
          expect(
            await store.searchVector("legacyvoyagemarker"),
          ).not.toHaveLength(0);
        }
      } finally {
        await discovery.close();
      }
    },
    30_000,
  );
});
