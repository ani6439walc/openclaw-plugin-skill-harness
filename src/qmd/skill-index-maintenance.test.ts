import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QMDStore } from "@wei840222/qmd";
import { createSkillQmdIndex, type SkillQmdIndex } from "./skill-index.js";
import { SKILL_INDEX_GC_GRACE_MS } from "./skill-index-gc.js";
import type { ResolvedQmdConfig } from "../types.js";

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
let now: number;
let active: string[];
const instances: SkillQmdIndex[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "index-maintenance-"));
  now = 1_000;
  active = ["main"];
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((index) => index.close()));
  await fs.rm(root, { recursive: true, force: true });
});
function fixture(readOnly = false) {
  const store = {
    update: vi.fn(async () => ({})),
    embed: vi.fn(async () => ({ errors: 0 })),
    getStatus: vi.fn(async () => ({ needsEmbedding: 0 })),
    search: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
  const index = createSkillQmdIndex({
    dataRoot: root,
    config: () => config,
    nowMs: () => now,
    readOnly,
    activeAgentIds: () => active,
    createStore: vi.fn(async ({ dbPath }) => {
      await fs.writeFile(dbPath, "fixture database");
      return store as unknown as QMDStore;
    }),
  });
  instances.push(index);
  return { index, store };
}
async function build(index: SkillQmdIndex, agentId = "main") {
  index.schedule(agentId, { skills: [], sourceRoots: ["/skills"] });
  await vi.waitFor(() => expect(index.getStatus(agentId)).toBe("ready"));
}
async function indexPath() {
  const mapping = JSON.parse(
    await fs.readFile(path.join(root, "qmd/skills/agents/main.json"), "utf8"),
  );
  return path.join(root, "qmd/skills/indexes", mapping.fingerprint);
}
async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

describe("skill index maintenance lifecycle", () => {
  it("does not treat reserved catalog directories as legacy agent folders", async () => {
    const { index } = fixture();
    for (const agent of ["main", "indexes", "agents", "leases"])
      await build(index, agent);
    for (const directory of ["indexes", "agents", "leases"])
      expect(await exists(path.join(root, "qmd/skills", directory))).toBe(true);
    expect(await exists(await indexPath())).toBe(true);
  });

  it("does not alias internal metadata when agent IDs contain dots", async () => {
    const { index } = fixture();
    await build(index);
    const skillsRoot = path.join(root, "qmd/skills");
    const state = { schemaVersion: 1, orphanSince: {}, retiredAgentSince: {} };
    await fs.writeFile(path.join(skillsRoot, "gc.json"), JSON.stringify(state));
    // A leftover reclamation guard must survive legacy directory cleanup.
    await fs.mkdir(path.join(skillsRoot, "catalog.lock.reclaim"));
    for (const agent of [
      "gc.json",
      "catalog",
      "catalog.lock",
      "catalog.lock.reclaim",
    ])
      await build(index, agent);
    expect(
      JSON.parse(await fs.readFile(path.join(skillsRoot, "gc.json"), "utf8")),
    ).toEqual(state);
    expect(await exists(path.join(skillsRoot, "catalog.lock.reclaim"))).toBe(
      true,
    );
  });

  it("retains a failed-close store lease while collecting unrelated orphans", async () => {
    const { index, store } = fixture();
    await build(index);
    const dir = await indexPath();
    const orphan = path.join(root, "qmd/skills/indexes", "a".repeat(64));
    await fs.mkdir(orphan);
    store.close.mockRejectedValue(new Error("close failed"));
    active = [];
    await index.maintenance!();
    now += SKILL_INDEX_GC_GRACE_MS;
    await index.maintenance!();
    expect(store.close).toHaveBeenCalledTimes(2);
    expect(await exists(dir)).toBe(true);
    expect(await exists(path.join(root, "qmd/skills/agents/main.json"))).toBe(
      true,
    );
    expect(await exists(orphan)).toBe(false);
    store.close.mockResolvedValue(undefined);
  });

  it("keeps a shared index and retires only the removed agent mapping", async () => {
    const { index } = fixture();
    active = ["main", "other"];
    await build(index);
    await build(index, "other");
    const dir = await indexPath();
    active = ["main"];
    await index.maintenance!();
    now += SKILL_INDEX_GC_GRACE_MS;
    await index.maintenance!();
    expect(await exists(dir)).toBe(true);
    expect(await exists(path.join(root, "qmd/skills/agents/main.json"))).toBe(
      true,
    );
    expect(await exists(path.join(root, "qmd/skills/agents/other.json"))).toBe(
      false,
    );
  });

  it("drains active searches before closing stores and beginning retirement", async () => {
    const { index, store } = fixture();
    await build(index);
    const dir = await indexPath();
    const gate = Promise.withResolvers<[]>();
    store.search.mockReturnValue(gate.promise);
    const pending = index.search({ agentId: "main", query: "test", limit: 1 });
    await vi.waitFor(() => expect(store.search).toHaveBeenCalled());
    active = [];
    try {
      await index.maintenance!();
      now += SKILL_INDEX_GC_GRACE_MS * 2;
      await index.maintenance!();
      expect(store.close).not.toHaveBeenCalled();
      expect(await exists(dir)).toBe(true);
    } finally {
      gate.resolve([]);
      await pending;
    }
    await index.maintenance!();
    expect(store.close).toHaveBeenCalledOnce();
    now += SKILL_INDEX_GC_GRACE_MS;
    await index.maintenance!();
    expect(await exists(dir)).toBe(false);
  });

  it("keeps another discovery instance's open store pinned until disposal", async () => {
    const owner = fixture();
    await build(owner.index);
    const dir = await indexPath();
    const reader = fixture(true);
    await reader.index.search({ agentId: "main", query: "test", limit: 1 });
    active = [];
    await owner.index.maintenance!();
    now += SKILL_INDEX_GC_GRACE_MS * 2;
    await owner.index.maintenance!();
    expect(await exists(dir)).toBe(true);
    expect(reader.store.close).not.toHaveBeenCalled();
    await reader.index.maintenance!();
    expect(await exists(dir)).toBe(true);
    await reader.index.close();
    await owner.index.maintenance!();
    now += SKILL_INDEX_GC_GRACE_MS;
    await owner.index.maintenance!();
    expect(await exists(dir)).toBe(false);
    expect(reader.store.update).not.toHaveBeenCalled();
  });

  it("does not close an embedding store while its agent is removed", async () => {
    const { index, store } = fixture();
    const gate = Promise.withResolvers<{ errors: number }>();
    store.embed.mockReturnValue(gate.promise);
    index.schedule("main", { skills: [], sourceRoots: ["/skills"] });
    await vi.waitFor(() => expect(store.embed).toHaveBeenCalled());
    active = [];
    try {
      await index.maintenance!();
      now += SKILL_INDEX_GC_GRACE_MS * 2;
      await index.maintenance!();
      expect(store.close).not.toHaveBeenCalled();
    } finally {
      gate.resolve({ errors: 0 });
    }
    await index.close();
    expect(store.close).toHaveBeenCalledOnce();
  });
});
