import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QMDStore } from "@wei840222/qmd";
import type { IntentCatalogEntry, ResolvedQmdConfig } from "../types.js";
import { createIntentQmdIndex } from "./intent-index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

const qmdConfig: ResolvedQmdConfig = {
  timeoutMs: 1_234,
  embedding: {
    baseUrl: "https://embedding.example.test/v1",
    model: "embedding-model",
    apiKey: "embedding-key",
  },
  expansion: {
    baseUrl: "https://expand.example.test/v1",
    model: "expand-model",
    apiKey: "expand-key",
  },
  rerank: {
    baseUrl: "https://rerank.example.test/v1",
    model: "rerank-model",
    apiKey: "rerank-key",
  },
};

const catalog: IntentCatalogEntry[] = [
  {
    id: "implementation",
    definition: {
      triggers: ["implement the requested feature"],
      examples: ["add a QMD fastpath"],
      domain: "development",
      fastpath: { keywords: ["implement", "feature"] },
      guidance: "Implement the requested feature carefully.",
    },
  },
];

const refreshedCatalog: IntentCatalogEntry[] = [
  {
    ...catalog[0],
    definition: {
      ...catalog[0].definition,
      triggers: ["refresh the intent catalog"],
    },
  },
];

const latestCatalog: IntentCatalogEntry[] = [
  {
    ...catalog[0],
    definition: {
      ...catalog[0].definition,
      triggers: ["use the latest intent catalog"],
    },
  },
];

function qmdResult(intentId: string) {
  return {
    body: `---\nintent_id: ${intentId}\n---\n${intentId}`,
    score: 0.91,
  };
}

function createStoreDouble(params: {
  search?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  return {
    update: params.update ?? vi.fn().mockResolvedValue({}),
    embed: vi.fn().mockResolvedValue({}),
    search: params.search ?? vi.fn().mockResolvedValue([]),
    searchLex: vi.fn().mockResolvedValue([]),
    close: params.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore;
}

async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

async function waitForReady(
  index: ReturnType<typeof createIntentQmdIndex>,
): Promise<void> {
  await waitFor(
    () => index.getStatus() === "ready",
    `index did not become ready; status=${index.getStatus()}`,
  );
}

describe("createIntentQmdIndex", () => {
  it("builds a managed snapshot and uses the configured QMD search modes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-qmd-"));
    roots.push(root);
    const search = vi.fn().mockResolvedValue([
      {
        body: "---\nintent_id: implementation\n---\nadd a QMD fastpath",
        score: 0.91,
        explain: { rerankScore: 0.91 },
      },
    ]);
    const searchLex = vi.fn().mockResolvedValue([
      {
        filepath: "/snapshot/topic-keywords/implementation-0.md",
        score: 0.91,
      },
    ]);
    const createStore = vi.fn().mockResolvedValue({
      update: vi.fn().mockResolvedValue({}),
      embed: vi.fn().mockResolvedValue({}),
      search,
      searchLex,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as QMDStore);
    const index = createIntentQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore,
    });

    index.schedule(catalog);
    await waitForReady(index);
    await expect(
      index.searchIntentTriggers({
        query: "add qmd",
        rawLimit: 12,
        expansionContext:
          "Current topic: Add QMD routing\nCurrent domain: development\nTopic keywords: qmd, routing",
      }),
    ).resolves.toEqual([
      {
        intentId: "implementation",
        score: 0.91,
        collection: "intent-triggers-and-examples",
        explain: { rerankScore: 0.91 },
      },
    ]);

    expect(createStore).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteRequestTimeoutMs: 1_234,
        config: expect.objectContaining({
          models: expect.objectContaining({
            embed_api_key: "embedding-key",
            generate_api_key: "expand-key",
            rerank_api_key: "rerank-key",
          }),
        }),
      }),
    );
    expect(search).toHaveBeenCalledWith({
      query: "add qmd",
      collections: ["intent-triggers", "intent-examples"],
      expansion: "force",
      expansionContext:
        "Current topic: Add QMD routing\nCurrent domain: development\nTopic keywords: qmd, routing",
      rerank: true,
      limit: 12,
      candidateLimit: 12,
      minScore: 0,
      explain: true,
    });

    await expect(
      index.searchTopicKeywords({
        query: "implement feature",
        domain: "development",
      }),
    ).resolves.toEqual([
      {
        intentId: "implementation",
        score: 0.91,
        collection: expect.stringMatching(/^intent-topic-keywords-/),
      },
    ]);
    expect(searchLex).toHaveBeenCalledWith("implement feature", {
      collection: expect.stringMatching(/^intent-topic-keywords-/),
      limit: 1,
    });
  });

  it("coalesces overlapping schedules into the latest catalog snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-qmd-"));
    roots.push(root);
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const createStore = vi
      .fn()
      .mockResolvedValueOnce(
        createStoreDouble({ update: vi.fn().mockReturnValue(firstUpdate) }),
      )
      .mockResolvedValueOnce(createStoreDouble({}));
    const index = createIntentQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore,
    });

    index.schedule(catalog);
    await waitFor(
      () => createStore.mock.calls.length === 1,
      "initial QMD store was not created",
    );
    index.schedule(refreshedCatalog);
    index.schedule(latestCatalog);
    releaseFirstUpdate?.();

    await waitFor(
      () => createStore.mock.calls.length === 2,
      "latest QMD store was not created",
    );
    await waitForReady(index);
    await expect(
      readFile(
        path.join(root, "qmd", "intents", "triggers", "implementation-0.md"),
        "utf8",
      ),
    ).resolves.toContain("use the latest intent catalog");
  });

  it("keeps a replacement store ready when closing the previous store fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-qmd-"));
    roots.push(root);
    const firstStore = createStoreDouble({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const replacementSearch = vi
      .fn()
      .mockResolvedValue([qmdResult("replacement")]);
    const replacementStore = createStoreDouble({ search: replacementSearch });
    const createStore = vi
      .fn()
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(replacementStore);
    const index = createIntentQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore,
    });

    index.schedule(catalog);
    await waitForReady(index);
    index.schedule(refreshedCatalog);
    await waitFor(
      () => createStore.mock.calls.length === 2,
      "replacement QMD store was not created",
    );
    await waitForReady(index);

    await expect(
      index.searchIntentTriggers({ query: "replacement", rawLimit: 1 }),
    ).resolves.toEqual([
      {
        intentId: "replacement",
        score: 0.91,
        collection: "intent-triggers-and-examples",
      },
    ]);
    expect(replacementSearch).toHaveBeenCalledOnce();
  });

  it("fails open and throttles repeated failures for the same fingerprint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-qmd-"));
    roots.push(root);
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const readyStore = createStoreDouble({});
    const createStore = vi
      .fn()
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce(readyStore)
      .mockRejectedValue(new Error("database locked"));
    const index = createIntentQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore,
    });

    index.schedule(catalog);
    await waitFor(
      () => index.getStatus() === "failed",
      "initial QMD failure was not recorded",
    );
    await expect(
      index.searchIntentTriggers({ query: "locked", rawLimit: 1 }),
    ).resolves.toBeUndefined();

    index.schedule(catalog);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createStore).toHaveBeenCalledTimes(1);

    nowMs = 5_000;
    index.schedule(catalog);
    await waitForReady(index);
    expect(createStore).toHaveBeenCalledTimes(2);

    index.schedule(refreshedCatalog);
    await waitFor(
      () => index.getStatus() === "failed",
      "refreshed QMD failure was not recorded",
    );
    expect(createStore).toHaveBeenCalledTimes(3);

    nowMs = 9_999;
    index.schedule(refreshedCatalog);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createStore).toHaveBeenCalledTimes(3);

    nowMs = 10_000;
    index.schedule(refreshedCatalog);
    await waitFor(
      () => createStore.mock.calls.length === 4,
      "QMD retry was not attempted after the reset delay",
    );
  });
});
