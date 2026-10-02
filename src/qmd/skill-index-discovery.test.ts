import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QMDStore } from "@wei840222/qmd";
import { createSkillQmdIndex, type SkillQmdIndex } from "./skill-index.js";
import type { ResolvedQmdConfig } from "../types.js";
import { writeJsonAtomic } from "../file-utils.js";

const config: ResolvedQmdConfig = {
  timeoutMs: 1000,
  embedding: {
    baseUrl: "https://embed.test",
    model: "embed",
    apiKey: "test",
    dimension: 1536,
  },
  expansion: {
    baseUrl: "https://expand.test",
    model: "expand",
    apiKey: "test",
  },
};
let root: string;
const instances: SkillQmdIndex[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-skills-"));
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((index) => index.close()));
  await fs.rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(readOnly = true) {
  const stores: Array<ReturnType<typeof mockStore>> = [];
  const createStore = vi.fn(
    async ({
      dbPath,
      readOnly: readonlyOption,
    }: {
      dbPath: string;
      readOnly?: boolean;
    }) => {
      if (!readonlyOption) await fs.writeFile(dbPath, "fixture database");
      const store = mockStore();
      stores.push(store);
      return store as unknown as QMDStore;
    },
  );
  const index = createSkillQmdIndex({
    dataRoot: root,
    config: () => config,
    readOnly,
    createStore,
  });
  instances.push(index);
  return { index, stores, createStore };
}
function mockStore() {
  return {
    update: vi.fn(async () => ({})),
    embed: vi.fn(async () => ({ errors: 0 })),
    getStatus: vi.fn(async () => ({ needsEmbedding: 0 })),
    search: vi.fn(async () => [
      { filepath: "qmd://skill-meta/alpha/meta.md", score: 1 },
      { filepath: "qmd://skill-meta/beta/meta.md", score: 1 },
    ]),
    close: vi.fn(async () => {}),
  };
}
const search = (index: SkillQmdIndex, agentId = "main") =>
  index.search({ agentId, query: "creative thinking", limit: 10 });
async function publish(
  fingerprint = "a".repeat(64),
  names = ["alpha"],
  agentId = "main",
) {
  const dir = path.join(root, "qmd/skills/indexes", fingerprint);
  await fs.mkdir(path.join(dir, "docs"), { recursive: true });
  await fs.writeFile(path.join(dir, "skill-search.sqlite"), "fixture database");
  await fs.mkdir(path.join(root, "qmd/skills/agents"), { recursive: true });
  writeJsonAtomic(path.join(root, "qmd/skills/agents", `${agentId}.json`), {
    schemaVersion: 1,
    fingerprint,
    allowedSkillNames: names,
  });
}

describe("skill discovery live mappings", () => {
  it("recovers after a full instance publishes the initially absent index", async () => {
    const reader = fixture();
    expect(await search(reader.index)).toBeUndefined();
    const writer = fixture(false);
    writer.index.schedule("main", { skills: [], sourceRoots: ["/skills"] });
    await vi.waitFor(() =>
      expect(writer.index.getStatus("main")).toBe("ready"),
    );
    expect(await search(reader.index)).toEqual([]);
    expect(reader.createStore).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(reader.stores[0]!.update).not.toHaveBeenCalled();
    expect(reader.stores[0]!.embed).not.toHaveBeenCalled();
  });

  it("switches indexes and applies same-index name updates without reopening", async () => {
    await publish();
    const { index, stores, createStore } = fixture();
    expect((await search(index))?.map((hit) => hit.name)).toEqual(["alpha"]);
    await publish("a".repeat(64), ["beta"]);
    expect((await search(index))?.map((hit) => hit.name)).toEqual(["beta"]);
    expect(createStore).toHaveBeenCalledTimes(1);
    await publish("b".repeat(64), ["alpha", "beta"]);
    expect(await search(index)).toHaveLength(2);
    await vi.waitFor(() => expect(stores[0]!.close).toHaveBeenCalledOnce());
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it("rejects missing, malformed and unfinished mappings without searching the old store", async () => {
    await publish();
    const { index, stores } = fixture();
    await search(index);
    const target = path.join(root, "qmd/skills/agents/main.json");
    for (const value of [
      {
        schemaVersion: 1,
        fingerprint: "b".repeat(64),
        allowedSkillNames: ["alpha"],
      },
      { schemaVersion: 1, fingerprint: "a".repeat(64), allowedSkillNames: [1] },
    ]) {
      writeJsonAtomic(target, value);
      expect(await search(index)).toBeUndefined();
    }
    await fs.unlink(target);
    expect(await search(index)).toBeUndefined();
    expect(stores[0]!.search).toHaveBeenCalledTimes(3);
    await publish();
    expect(await search(index)).toHaveLength(1);
  });

  it("keeps in-flight names and the old store until its search finishes", async () => {
    await publish();
    const { index, stores } = fixture();
    await search(index);
    const gate = deferred();
    stores[0]!.search.mockImplementation(async () => {
      await gate.promise;
      return [{ filepath: "qmd://skill-meta/alpha/meta.md", score: 1 }];
    });
    const pending = search(index);
    await vi.waitFor(() => expect(stores[0]!.search).toHaveBeenCalledTimes(6));
    await publish("b".repeat(64), ["beta"]);
    expect((await search(index))?.map((hit) => hit.name)).toEqual(["beta"]);
    expect(stores[0]!.close).not.toHaveBeenCalled();
    gate.resolve();
    expect((await pending)?.map((hit) => hit.name)).toEqual(["alpha"]);
    await vi.waitFor(() => expect(stores[0]!.close).toHaveBeenCalledOnce());
  });

  it("preserves shared stores and coalesces concurrent searches", async () => {
    await publish();
    await publish("a".repeat(64), ["alpha"], "other");
    const { index, stores, createStore } = fixture();
    await Promise.all([search(index), search(index), search(index, "other")]);
    expect(createStore).toHaveBeenCalledTimes(1);
    await publish("b".repeat(64));
    await search(index);
    expect(stores[0]!.close).not.toHaveBeenCalled();
    await publish("b".repeat(64), ["alpha"], "other");
    await search(index, "other");
    await vi.waitFor(() => expect(stores[0]!.close).toHaveBeenCalledOnce());
  });

  it("retains failed-close leases and still uses the newly published index", async () => {
    await publish();
    const { index, stores } = fixture();
    await search(index);
    stores[0]!.close.mockRejectedValue(new Error("close failed"));
    await publish("b".repeat(64));
    expect(await search(index)).toHaveLength(1);
    await vi.waitFor(() => expect(stores[0]!.close).toHaveBeenCalled());
    expect(
      (await fs.readdir(path.join(root, "qmd/skills/leases", "a".repeat(64))))
        .length,
    ).toBe(1);
    stores[0]!.close.mockResolvedValue(undefined);
  });

  it("retries failed opens without creating an absent database", async () => {
    await publish();
    const database = path.join(
      root,
      "qmd/skills/indexes",
      "a".repeat(64),
      "skill-search.sqlite",
    );
    const { index, createStore } = fixture();
    await fs.unlink(database);
    expect(await search(index)).toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
    await publish();
    createStore.mockRejectedValueOnce(new Error("temporary open failure"));
    expect(await search(index)).toBeUndefined();
    expect(await search(index)).toHaveLength(1);
    expect(createStore).toHaveBeenCalledTimes(2);
  });

  it("does not retain unrelated eagerly loaded agent references", async () => {
    await publish();
    await publish("a".repeat(64), ["alpha"], "other");
    const { index, stores } = fixture();
    await search(index);
    await publish("b".repeat(64));
    await publish("b".repeat(64), ["alpha"], "other");
    await search(index);
    await vi.waitFor(() => expect(stores[0]!.close).toHaveBeenCalledOnce());
  });

  it("waits for a pending open on dispose and never searches the late store", async () => {
    await publish();
    const { index, stores, createStore } = fixture();
    const gate = deferred();
    const store = mockStore();
    createStore.mockImplementation(async () => {
      await gate.promise;
      stores.push(store);
      return store as unknown as QMDStore;
    });
    const pending = search(index);
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledOnce());
    const closing = index.close();
    gate.resolve();
    expect(await pending).toBeUndefined();
    await closing;
    expect(store.search).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledOnce();
    expect(
      await fs.readdir(path.join(root, "qmd/skills/leases", "a".repeat(64))),
    ).toEqual([]);
  });
  it("rejects an index whose mapping changes while its store opens", async () => {
    await publish();
    const { index, createStore } = fixture();
    const gate = deferred();
    const stale = mockStore();
    createStore.mockImplementationOnce(async () => {
      await gate.promise;
      return stale as unknown as QMDStore;
    });
    const pending = search(index);
    await vi.waitFor(() => expect(createStore).toHaveBeenCalledOnce());
    await publish("b".repeat(64), ["beta"]);
    gate.resolve();
    expect(await pending).toBeUndefined();
    expect(stale.search).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledOnce());
    expect((await search(index))?.map((hit) => hit.name)).toEqual(["beta"]);
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(
      await fs.readdir(path.join(root, "qmd/skills/leases", "a".repeat(64))),
    ).toEqual([]);
  });

  it("waits for retirement and repins when a mapping returns to the retiring index", async () => {
    await publish();
    const { index, stores, createStore } = fixture();
    await search(index);
    const first = stores[0]!;
    const gate = deferred();
    first.close.mockImplementationOnce(() => gate.promise);
    await publish("b".repeat(64), ["beta"]);
    expect((await search(index))?.map((hit) => hit.name)).toEqual(["beta"]);
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    const leases = path.join(root, "qmd/skills/leases", "a".repeat(64));
    const originalLease = await fs.readdir(leases);
    expect(originalLease).toHaveLength(1);
    await publish("a".repeat(64), ["alpha"]);
    const returning = search(index);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(first.search).toHaveBeenCalledTimes(3);
    expect(await fs.readdir(leases)).toEqual(originalLease);
    gate.resolve();
    expect((await returning)?.map((hit) => hit.name)).toEqual(["alpha"]);
    expect(createStore).toHaveBeenCalledTimes(3);
    expect(stores[2]!.search).toHaveBeenCalledTimes(3);
    const replacementLease = await fs.readdir(leases);
    expect(replacementLease).toHaveLength(1);
    expect(replacementLease).not.toEqual(originalLease);
    await vi.waitFor(() => expect(stores[1]!.close).toHaveBeenCalledOnce());
  });
});
