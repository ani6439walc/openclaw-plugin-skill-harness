import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QMDStore } from "@tobilu/qmd";
import type { IntentCatalogEntry, ResolvedQmdConfig } from "../types.js";
import { createIntentQmdIndex } from "./intent-index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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

async function waitForReady(
  index: ReturnType<typeof createIntentQmdIndex>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (index.getStatus() === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`index did not become ready; status=${index.getStatus()}`);
}

describe("createIntentQmdIndex", () => {
  it("builds a managed snapshot and searches trigger/example collections in one QMD request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-qmd-"));
    roots.push(root);
    const search = vi.fn().mockResolvedValue([
      {
        body: "---\nintent_id: implementation\n---\nadd a QMD fastpath",
        score: 0.91,
        explain: { rerankScore: 0.91 },
      },
    ]);
    const createStore = vi.fn().mockResolvedValue({
      update: vi.fn().mockResolvedValue({}),
      embed: vi.fn().mockResolvedValue({}),
      search,
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
      index.searchIntentTriggers({ query: "add qmd", rawLimit: 12 }),
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
      rerank: true,
      limit: 12,
      candidateLimit: 12,
      minScore: 0,
      explain: true,
    });
  });
});
