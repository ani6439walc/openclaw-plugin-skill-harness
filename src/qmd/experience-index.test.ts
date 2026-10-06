import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QMDStore } from "@wei840222/qmd";
import type { SkillExperienceEntry } from "../experiences/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import { FileLock, withFileLock } from "../file-utils.js";
import {
  createSkillExperienceQmdIndex,
  type SkillExperienceQmdIndex,
} from "./experience-index.js";

const DEFAULT_CONFIG: ResolvedQmdConfig = {
  timeoutMs: 5000,
  embedding: {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    apiKey: "test-key",
    dimension: 1536,
  },
  expansion: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "test-key",
  },
};

const MOCK_ENTRIES: SkillExperienceEntry[] = [
  {
    id: "image-analysis",
    skills: ["cx", "vision"],
    summary: "Visual inspection and structured extraction from screenshots.",
    keywords: ["ocr", "image", "screenshot"],
    body: "# Image Analysis\n\n## Guidance\nPerform OCR and image inspection.\n",
    path: "/tmp/mock/image-analysis",
  },
  {
    id: "docs-lookup",
    skills: ["treemd"],
    summary: "Lookup documentation in project knowledge trees.",
    keywords: ["docs", "lookup", "documentation"],
    body: "# Docs Lookup\n\n## Guidance\nUse tree navigation for project documentation.\n",
    path: "/tmp/mock/docs-lookup",
  },
];

describe("SkillExperienceQmdIndex", () => {
  let tmpDir: string;
  let index: SkillExperienceQmdIndex | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exp-index-test-"));
  });

  afterEach(async () => {
    if (index) {
      await index.close();
      index = undefined;
    }
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("builds multi-collection snapshot and performs RRF search returning parsed hits", async () => {
    const mockStore: Partial<QMDStore> = {
      update: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ errors: 0 }),
      getStatus: vi
        .fn()
        .mockResolvedValue({ needsEmbedding: 0, totalDocuments: 1 }),
      search: vi
        .fn()
        .mockImplementation(async (params: { collections?: string[] }) => {
          const col = params.collections?.[0];
          if (col === "keywords") {
            return [
              {
                filepath: "keywords/image-analysis.md",
                score: 0.95,
                explain: { vectorScores: [0.95] },
              },
            ];
          }
          if (col === "summary") {
            return [
              {
                filepath: "summary/image-analysis.md",
                score: 0.88,
                explain: { vectorScores: [0.9] },
              },
            ];
          }
          return [];
        }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const createStore = vi.fn().mockResolvedValue(mockStore as QMDStore);

    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore:
        createStore as unknown as (typeof import("@wei840222/qmd"))["createStore"],
    });

    index.schedule(MOCK_ENTRIES);

    let attempts = 0;
    while (index.getStatus() !== "ready" && attempts < 50) {
      await new Promise((r) => setTimeout(r, 50));
      attempts += 1;
    }

    expect(index.getStatus()).toBe("ready");
    expect(createStore).toHaveBeenCalled();
    expect(mockStore.update).toHaveBeenCalled();
    expect(mockStore.embed).toHaveBeenCalled();

    // Verify snapshot documents and sidecars exist on disk
    const docsDir = path.join(tmpDir, "qmd", "experiences", "docs");
    expect(
      await fs.readFile(
        path.join(docsDir, "keywords", "image-analysis.md"),
        "utf8",
      ),
    ).toContain("- ocr");
    for (const kind of ["keywords", "summary", "body"]) {
      for (const suffix of [".identity.yml", ".identity.json"]) {
        await expect(
          fs.readFile(path.join(docsDir, kind, `image-analysis.md${suffix}`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    }

    const hits = await index.search({ query: "analyze screenshot" });
    expect(hits).toBeDefined();
    expect(hits).toHaveLength(1);
    expect(hits![0].id).toBe("image-analysis");
    expect(hits![0].skills).toEqual(["cx", "vision"]);
    expect(hits![0].matchedCollections).toContain("keywords");
    expect(hits![0].matchedCollections).toContain("summary");
    expect(hits![0].semanticScore).toBe(0.95);
    expect(hits![0].evidence.length).toBe(2);
  });

  it("handles empty or failed searches gracefully", async () => {
    const mockStore: Partial<QMDStore> = {
      update: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ errors: 0 }),
      getStatus: vi.fn().mockResolvedValue({ needsEmbedding: 0 }),
      search: vi.fn().mockRejectedValue(new Error("Network failure")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const createStore = vi.fn().mockResolvedValue(mockStore as QMDStore);

    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore:
        createStore as unknown as (typeof import("@wei840222/qmd"))["createStore"],
    });

    index.schedule(MOCK_ENTRIES);

    let attempts = 0;
    while (index.getStatus() !== "ready" && attempts < 50) {
      await new Promise((r) => setTimeout(r, 50));
      attempts += 1;
    }

    const hits = await index.search({ query: "broken" });
    expect(hits).toBeUndefined();
  });

  function makeStore() {
    return {
      update: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ errors: 0 }),
      getStatus: vi.fn().mockResolvedValue({ needsEmbedding: 0 }),
      search: vi
        .fn()
        .mockResolvedValue([
          { filepath: "keywords/image-analysis.md", score: 0.95 },
        ]),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("waits for a read-only index to open and searches only the current catalog without writes", async () => {
    const builtStore = makeStore();
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore: vi.fn().mockResolvedValue(builtStore),
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    await index.close();

    const metadataPath = path.join(
      tmpDir,
      "qmd",
      "experiences",
      "metadata.json",
    );
    const metadata = await fs.readFile(metadataPath, "utf8");
    await fs.writeFile(
      path.join(tmpDir, "qmd", "experiences", "experience-routing.sqlite"),
      "",
    );
    const readStore = makeStore();
    let finishOpen!: (store: QMDStore) => void;
    const createStore = vi.fn().mockImplementation(
      () =>
        new Promise<QMDStore>((resolve) => {
          finishOpen = resolve;
        }),
    );
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore,
      readOnly: true,
    });
    index.schedule(MOCK_ENTRIES);
    const search = index.search({ query: "screenshot" });
    expect(readStore.search).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledOnce());
    finishOpen(readStore as unknown as QMDStore);
    expect(await search).toEqual([
      expect.objectContaining({
        id: "image-analysis",
        skills: ["cx", "vision"],
      }),
    ]);
    expect(createStore).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ readOnly: true }),
    );

    index.schedule([{ ...MOCK_ENTRIES[0]!, body: "changed" }]);
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(readStore.update).not.toHaveBeenCalled();
    expect(readStore.embed).not.toHaveBeenCalled();
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata);
  });

  it("never builds a missing read-only index", async () => {
    const createStore = vi.fn();
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore,
      readOnly: true,
    });
    index.schedule(MOCK_ENTRIES);
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("retries failed builds with backoff without another catalog refresh", async () => {
    vi.useFakeTimers();
    const mockStore = makeStore();
    mockStore.embed
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"));
    const createStore = vi.fn().mockResolvedValue(mockStore);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore,
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("failed"));
    expect(createStore).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(createStore).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(index!.getStatus()).toBe("failed"));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(createStore).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    expect(createStore).toHaveBeenCalledTimes(3);
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
  });

  it("retries the latest catalog queued during a failed build", async () => {
    vi.useFakeTimers();
    const mockStore = makeStore();
    let failEmbed!: (reason: Error) => void;
    mockStore.embed.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failEmbed = reject;
        }),
    );
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore: vi.fn().mockResolvedValue(mockStore),
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(() => expect(mockStore.embed).toHaveBeenCalledTimes(1));
    index.schedule([{ ...MOCK_ENTRIES[0]!, body: "new catalog content" }]);
    failEmbed(new Error("temporary failure"));
    await vi.waitFor(() => expect(index!.getStatus()).toBe("failed"));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    expect(
      await fs.readFile(
        path.join(
          tmpDir,
          "qmd",
          "experiences",
          "docs",
          "body",
          "image-analysis.md",
        ),
        "utf8",
      ),
    ).toBe("new catalog content\n");
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }

  async function setupConnection() {
    let config = structuredClone(DEFAULT_CONFIG);
    const first = makeStore();
    const next = makeStore();
    const createStore = vi
      .fn()
      .mockResolvedValue(next)
      .mockResolvedValueOnce(first);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => config,
      createStore,
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    await fs.writeFile(
      path.join(tmpDir, "qmd", "experiences", "experience-routing.sqlite"),
      "",
    );
    return {
      first,
      next,
      createStore,
      setConfig(value: ResolvedQmdConfig) {
        config = value;
      },
      search: () => index!.search({ query: "screenshot" }),
    };
  }

  it("removes legacy sidecars in the same database and cleans removed entries", async () => {
    const fixture = await setupConnection();
    await index!.close();
    const indexRoot = path.join(tmpDir, "qmd", "experiences");
    const docsRoot = path.join(indexRoot, "docs");
    for (const kind of ["keywords", "summary", "body"]) {
      for (const entry of MOCK_ENTRIES) {
        const document = path.join(docsRoot, kind, `${entry.id}.md`);
        await fs.writeFile(`${document}.identity.json`, "{}");
        await fs.writeFile(
          `${document}.identity.yml`,
          "---\nid: legacy\n---\n",
        );
      }
    }
    const metadataPath = path.join(indexRoot, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    metadata.fingerprint = "legacy-yaml-snapshot";
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const store = makeStore();
    const createStore = vi.fn().mockResolvedValue(store);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore,
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(() => expect(store.update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    expect(createStore.mock.calls[0]?.[0].dbPath).toBe(
      fixture.createStore.mock.calls[0]?.[0].dbPath,
    );
    for (const kind of ["keywords", "summary", "body"]) {
      const document = path.join(docsRoot, kind, `${MOCK_ENTRIES[0].id}.md`);
      await expect(
        fs.readFile(`${document}.identity.yml`),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.readFile(`${document}.identity.json`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    const body = path.join(docsRoot, "body", `${MOCK_ENTRIES[0].id}.md`);
    await fs.utimes(body, new Date(1_000), new Date(1_000));
    index.schedule([MOCK_ENTRIES[0]]);
    await vi.waitFor(() => expect(store.update).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    expect((await fs.stat(body)).mtimeMs).toBe(1_000);
    for (const kind of ["keywords", "summary", "body"]) {
      for (const suffix of [".identity.yml", ".identity.json"]) {
        await expect(
          fs.readFile(
            path.join(docsRoot, kind, `${MOCK_ENTRIES[1].id}.md${suffix}`),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it.each(["endpoint", "key", "expansion", "jev", "timeout", "cache"])(
    "rotates %s without rebuilding content",
    async (field) => {
      const fixture = await setupConnection();
      const metadataPath = path.join(
        tmpDir,
        "qmd",
        "experiences",
        "metadata.json",
      );
      const metadata = await fs.readFile(metadataPath, "utf8");
      const config = structuredClone(DEFAULT_CONFIG);
      if (field === "endpoint")
        config.embedding.baseUrl = "https://next.test/v1";
      if (field === "key") config.embedding.apiKey = "next-key";
      if (field === "expansion") config.expansion.model = "next-model";
      if (field === "jev")
        config.jev = {
          baseUrl: "https://jev.test",
          model: "jev",
          apiKey: "jev-key",
        };
      if (field === "timeout") config.timeoutMs = 4321;
      if (field === "cache")
        config.embeddingCacheDir = "/shared/qmd-document-embeddings";
      fixture.setConfig(config);
      index!.schedule(MOCK_ENTRIES);
      expect(await fixture.search()).toHaveLength(1);
      expect(fixture.first.close).toHaveBeenCalledOnce();
      expect(fixture.next.update).not.toHaveBeenCalled();
      expect(fixture.next.embed).not.toHaveBeenCalled();
      expect(fixture.createStore).toHaveBeenCalledTimes(2);
      expect(fixture.createStore.mock.calls[1]?.[0]).toMatchObject({
        dbPath: fixture.createStore.mock.calls[0]?.[0].dbPath,
        readOnly: true,
        config: {
          models: {
            embed_api_url: config.embedding.baseUrl,
            embed_api_key: config.embedding.apiKey,
            generate_api_model: config.expansion.model,
          },
        },
        remoteRequestTimeoutMs: config.timeoutMs,
      });
      if (field === "jev")
        expect(
          fixture.createStore.mock.calls[1]?.[0].config.models,
        ).toMatchObject({ jev_api_key: "jev-key" });
      expect(
        fixture.createStore.mock.calls[1]?.[0].config.models.embed_cache_dir,
      ).toBe(config.embeddingCacheDir);
      expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata);
    },
  );

  it.each(["timeoutMs", "embeddingCacheDir"] as const)(
    "drains searches and coalesces changing connection settings (%s)",
    async (field) => {
      const fixture = await setupConnection();
      const pending = deferred<[]>();
      fixture.first.search.mockReturnValue(pending.promise);
      const active = fixture.search();
      await vi.waitFor(() =>
        expect(fixture.first.search).toHaveBeenCalledTimes(3),
      );
      fixture.setConfig({
        ...DEFAULT_CONFIG,
        [field]: field === "timeoutMs" ? 2000 : "/shared/cache-2000",
      });
      const waiting = fixture.search();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.setConfig({
        ...DEFAULT_CONFIG,
        [field]: field === "timeoutMs" ? 3000 : "/shared/cache-3000",
      });
      const another = fixture.search();
      expect(fixture.first.close).not.toHaveBeenCalled();
      pending.resolve([]);
      await Promise.all([active, waiting, another]);
      expect(fixture.first.search).toHaveBeenCalledTimes(3);
      expect(fixture.createStore).toHaveBeenCalledTimes(2);
      expect(fixture.createStore.mock.calls[1]?.[0]).toMatchObject(
        field === "timeoutMs"
          ? { remoteRequestTimeoutMs: 3000 }
          : { config: { models: { embed_cache_dir: "/shared/cache-3000" } } },
      );
    },
  );

  it("fails open on reopen failure and never falls back to old credentials", async () => {
    const fixture = await setupConnection();
    fixture.createStore.mockRejectedValueOnce(new Error("unavailable"));
    fixture.setConfig({ ...DEFAULT_CONFIG, timeoutMs: 3000 });
    expect(await fixture.search()).toBeUndefined();
    expect(index!.getStatus()).toBe("failed");
    expect(fixture.first.search).not.toHaveBeenCalled();
    expect(fixture.first.close).toHaveBeenCalledOnce();
    expect(await fixture.search()).toHaveLength(1);
    expect(index!.getStatus()).toBe("ready");
  });

  it("waits for all sibling searches during disposal even when one fails", async () => {
    const fixture = await setupConnection();
    const pending = deferred<[]>();
    fixture.first.search
      .mockRejectedValueOnce(new Error("failed"))
      .mockReturnValue(pending.promise);
    const active = fixture.search();
    await vi.waitFor(() =>
      expect(fixture.first.search).toHaveBeenCalledTimes(3),
    );
    const closing = index!.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.first.close).not.toHaveBeenCalled();
    pending.resolve([]);
    expect(await active).toBeUndefined();
    await closing;
    index = undefined;
    expect(fixture.first.close).toHaveBeenCalledOnce();
  });

  it("rebuild waits for active searches before update and closes the old store afterward", async () => {
    const fixture = await setupConnection();
    const pending = deferred<[]>();
    fixture.first.search.mockReturnValue(pending.promise);
    const active = fixture.search();
    await vi.waitFor(() =>
      expect(fixture.first.search).toHaveBeenCalledTimes(3),
    );
    index!.schedule([{ ...MOCK_ENTRIES[0]!, body: "changed" }]);
    await vi.waitFor(() => expect(index!.getStatus()).toBe("building"));
    expect(fixture.next.update).not.toHaveBeenCalled();
    expect(fixture.first.close).not.toHaveBeenCalled();
    pending.resolve([]);
    await active;
    await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
    expect(fixture.next.update).toHaveBeenCalledOnce();
    expect(fixture.first.close).toHaveBeenCalledOnce();
  });

  it("read-only instances rotate connections without changing metadata or rebuilding", async () => {
    await setupConnection();
    await index!.close();
    const metadataPath = path.join(
      tmpDir,
      "qmd",
      "experiences",
      "metadata.json",
    );
    const metadata = await fs.readFile(metadataPath, "utf8");
    let config = DEFAULT_CONFIG;
    const first = makeStore();
    const next = makeStore();
    const createStore = vi
      .fn()
      .mockResolvedValue(next)
      .mockResolvedValueOnce(first);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => config,
      createStore,
      readOnly: true,
    });
    index.schedule(MOCK_ENTRIES);
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    config = { ...DEFAULT_CONFIG, timeoutMs: 3333 };
    index.schedule(MOCK_ENTRIES);
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(first.update).not.toHaveBeenCalled();
    expect(next.update).not.toHaveBeenCalled();
    expect(next.embed).not.toHaveBeenCalled();
    expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata);
  });

  it("mismatched legacy metadata fails open read-only until a full refresh", async () => {
    await setupConnection();
    await index!.close();
    const metadataPath = path.join(
      tmpDir,
      "qmd",
      "experiences",
      "metadata.json",
    );
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      fingerprint: string;
    };
    metadata.fingerprint = "legacy-connection-dependent-fingerprint";
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const readonly = makeStore();
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore: vi.fn().mockResolvedValue(readonly),
      readOnly: true,
    });
    index.schedule(MOCK_ENTRIES);
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(readonly.update).not.toHaveBeenCalled();
    await index.close();
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      createStore: vi
        .fn()
        .mockImplementation(() => Promise.resolve(makeStore())),
    });
    index.schedule(MOCK_ENTRIES);
    await vi.waitFor(async () =>
      expect(await index!.search({ query: "screenshot" })).toHaveLength(1),
    );
    expect(
      (
        JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
          fingerprint: string;
        }
      ).fingerprint,
    ).not.toBe(metadata.fingerprint);
  });

  it("does not lend a replacement that became stale while opening", async () => {
    const fixture = await setupConnection();
    const pending = deferred<QMDStore>();
    const stale = makeStore();
    fixture.createStore.mockReturnValueOnce(pending.promise);
    fixture.setConfig({ ...DEFAULT_CONFIG, timeoutMs: 2000 });
    const searching = fixture.search();
    await vi.waitFor(() =>
      expect(fixture.createStore).toHaveBeenCalledTimes(2),
    );
    fixture.setConfig({ ...DEFAULT_CONFIG, timeoutMs: 3000 });
    pending.resolve(stale as unknown as QMDStore);
    expect(await searching).toHaveLength(1);
    expect(stale.search).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fixture.createStore.mock.calls[2]?.[0]).toMatchObject({
      remoteRequestTimeoutMs: 3000,
    });
  });

  it("closes a replacement that finishes opening during disposal", async () => {
    const fixture = await setupConnection();
    const pending = deferred<QMDStore>();
    fixture.createStore.mockReturnValueOnce(pending.promise);
    fixture.setConfig({ ...DEFAULT_CONFIG, timeoutMs: 3000 });
    const searching = fixture.search();
    await vi.waitFor(() =>
      expect(fixture.createStore).toHaveBeenCalledTimes(2),
    );
    const closing = index!.close();
    pending.resolve(fixture.next as unknown as QMDStore);
    expect(await searching).toBeUndefined();
    await closing;
    index = undefined;
    expect(fixture.next.search).not.toHaveBeenCalled();
    expect(fixture.next.close).toHaveBeenCalledOnce();
  });

  it.each(["timeoutMs", "embeddingCacheDir"] as const)(
    "finishes embedding before applying newer connection settings (%s)",
    async (field) => {
      const fixture = await setupConnection();
      const pending = deferred<{ errors: number }>();
      fixture.next.embed.mockReturnValue(pending.promise);
      index!.schedule([{ ...MOCK_ENTRIES[0]!, body: "changed" }]);
      await vi.waitFor(() => expect(fixture.next.embed).toHaveBeenCalledOnce());
      fixture.setConfig({
        ...DEFAULT_CONFIG,
        [field]: field === "timeoutMs" ? 3000 : "/shared/cache-3000",
      });
      expect(await fixture.search()).toBeUndefined();
      expect(fixture.next.close).not.toHaveBeenCalled();
      const newest = makeStore();
      fixture.createStore.mockResolvedValueOnce(newest);
      pending.resolve({ errors: 0 });
      await vi.waitFor(() => expect(index!.getStatus()).toBe("ready"));
      expect(await fixture.search()).toHaveLength(1);
      expect(fixture.next.close).toHaveBeenCalledOnce();
      expect(newest.update).not.toHaveBeenCalled();
      expect(newest.search).toHaveBeenCalledTimes(3);
      expect(fixture.createStore.mock.calls[2]?.[0]).toMatchObject(
        field === "timeoutMs"
          ? { remoteRequestTimeoutMs: 3000 }
          : { config: { models: { embed_cache_dir: "/shared/cache-3000" } } },
      );
    },
  );
  async function publish(
    entries: readonly SkillExperienceEntry[],
    config = DEFAULT_CONFIG,
  ) {
    const createStore = vi
      .fn()
      .mockImplementation(async ({ dbPath }: { dbPath: string }) => {
        await fs.writeFile(dbPath, "");
        return makeStore();
      });
    const full = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => config,
      createStore,
    });
    try {
      full.schedule(entries);
      await vi.waitFor(async () =>
        expect(await full.search({ query: "screenshot" })).toHaveLength(1),
      );
    } finally {
      await full.close();
    }
  }

  it("recovers the same discovery after full publication and follows live catalog and embedding changes", async () => {
    let entries = MOCK_ENTRIES;
    let config = DEFAULT_CONFIG;
    const stores: ReturnType<typeof makeStore>[] = [];
    const createStore = vi.fn().mockImplementation(async () => {
      const store = makeStore();
      stores.push(store);
      return store;
    });
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => config,
      getEntries: () => entries,
      createStore,
      readOnly: true,
    });
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
    await publish(entries);
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    entries = [{ ...MOCK_ENTRIES[0], body: "new body", skills: ["new-skill"] }];
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    await publish(entries);
    expect(await index.search({ query: "screenshot" })).toEqual([
      expect.objectContaining({ skills: ["new-skill"] }),
    ]);
    config = {
      ...DEFAULT_CONFIG,
      embedding: { ...DEFAULT_CONFIG.embedding, dimension: 768 },
    };
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    await publish(entries, config);
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    expect(createStore).toHaveBeenCalledTimes(3);
    for (const store of stores) {
      expect(store.update).not.toHaveBeenCalled();
      expect(store.embed).not.toHaveBeenCalled();
    }
    for (const [options] of createStore.mock.calls)
      expect(options.readOnly).toBe(true);
  });

  it("recovers after invalid metadata, missing database, and a failed read-only open", async () => {
    await publish(MOCK_ENTRIES);
    const metadataPath = path.join(
      tmpDir,
      "qmd",
      "experiences",
      "metadata.json",
    );
    const dbPath = path.join(
      tmpDir,
      "qmd",
      "experiences",
      "experience-routing.sqlite",
    );
    const metadata = await fs.readFile(metadataPath, "utf8");
    const createStore = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary open failure"))
      .mockResolvedValue(makeStore());
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      getEntries: () => MOCK_ENTRIES,
      createStore,
      readOnly: true,
    });
    await fs.writeFile(metadataPath, "{broken");
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    await fs.writeFile(metadataPath, metadata);
    await fs.rm(dbPath);
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
    await fs.writeFile(dbPath, "");
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it("drains old discovery searches, coalesces refreshes, and preserves their catalog snapshot", async () => {
    let entries = MOCK_ENTRIES;
    await publish(entries);
    const first = makeStore();
    const next = makeStore();
    const createStore = vi
      .fn()
      .mockResolvedValue(next)
      .mockResolvedValueOnce(first);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      getEntries: () => entries,
      createStore,
      readOnly: true,
    });
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    first.search.mockClear();
    const pending = deferred<{ filepath: string; score: number }[]>();
    first.search.mockReturnValue(pending.promise);
    const active = index.search({ query: "screenshot" });
    await vi.waitFor(() => expect(first.search).toHaveBeenCalledTimes(3));
    entries = [{ ...MOCK_ENTRIES[0], body: "new body", skills: ["new-skill"] }];
    await publish(entries);
    const waiting = index.search({ query: "screenshot" });
    const another = index.search({ query: "screenshot" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.close).not.toHaveBeenCalled();
    expect(
      await withFileLock(
        path.join(tmpDir, "qmd", "experiences", "experience-routing.sqlite"),
        async () => true,
        { maxWaitMs: 0 },
      ),
    ).toBe(true);
    pending.resolve([{ filepath: "keywords/image-analysis.md", score: 0.9 }]);
    expect(await active).toEqual([
      expect.objectContaining({ skills: ["cx", "vision"] }),
    ]);
    for (const result of await Promise.all([waiting, another]))
      expect(result).toEqual([
        expect.objectContaining({ skills: ["new-skill"] }),
      ]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it("retains a discovery store after failed close and retries rotation", async () => {
    let entries = MOCK_ENTRIES;
    await publish(entries);
    const first = makeStore();
    const next = makeStore();
    const createStore = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(next);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      getEntries: () => entries,
      createStore,
      readOnly: true,
    });
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    first.search.mockClear();
    first.close.mockRejectedValueOnce(new Error("temporary close failure"));
    entries = [
      { ...MOCK_ENTRIES[0]!, body: "updated body", skills: ["updated-skill"] },
    ];
    await publish(entries);
    expect(await index.search({ query: "screenshot" })).toBeUndefined();
    expect(first.search).not.toHaveBeenCalled();
    expect(createStore).toHaveBeenCalledOnce();
    expect(await index.search({ query: "screenshot" })).toEqual([
      expect.objectContaining({ skills: ["updated-skill"] }),
    ]);
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(next.update).not.toHaveBeenCalled();
    expect(next.embed).not.toHaveBeenCalled();
  });

  it("fails open while the build lock is busy and recovers after release", async () => {
    await publish(MOCK_ENTRIES);
    const store = makeStore();
    const createStore = vi.fn().mockResolvedValue(store);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      getEntries: () => MOCK_ENTRIES,
      createStore,
      readOnly: true,
    });
    const lock = new FileLock(
      path.join(tmpDir, "qmd", "experiences", "experience-routing.sqlite"),
    );
    expect(await lock.acquire({ maxWaitMs: 0 })).toBe(true);
    try {
      expect(await index.search({ query: "screenshot" })).toBeUndefined();
      expect(createStore).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
    expect(await index.search({ query: "screenshot" })).toHaveLength(1);
    expect(createStore).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.embed).not.toHaveBeenCalled();
  });

  it("does not publish a discovery store opened while the catalog changes or disposal starts", async () => {
    let entries = MOCK_ENTRIES;
    await publish(entries);
    const pending = deferred<QMDStore>();
    const stale = makeStore();
    const next = makeStore();
    const createStore = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(next);
    index = createSkillExperienceQmdIndex({
      dataRoot: tmpDir,
      config: () => DEFAULT_CONFIG,
      getEntries: () => entries,
      createStore,
      readOnly: true,
    });
    const searching = index.search({ query: "screenshot" });
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledOnce());
    entries = [{ ...MOCK_ENTRIES[0], body: "new body" }];
    pending.resolve(stale as unknown as QMDStore);
    expect(await searching).toBeUndefined();
    expect(index.getStatus()).toBe("idle");
    expect(stale.search).not.toHaveBeenCalled();
    await publish(entries);
    const opening = deferred<QMDStore>();
    createStore.mockReturnValueOnce(opening.promise);
    const replacement = index.search({ query: "screenshot" });
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledTimes(2));
    const closing = index.close();
    opening.resolve(next as unknown as QMDStore);
    expect(await replacement).toBeUndefined();
    await closing;
    expect(next.close).toHaveBeenCalledOnce();
    expect(next.search).not.toHaveBeenCalled();
    index = undefined;
  });
});
