import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QMDStore } from "@wei840222/qmd";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import {
  createSkillQmdIndex,
  safePathSegment,
  skillIdentityFromDocsPath,
  writeSkillSnapshot,
} from "./skill-index.js";

const roots: string[] = [];
let nowMs = 1_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  nowMs = 1_000;
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
  skillSearch: {
    collectionWeights: { meta: 2, body: 1, references: 0.5 },
    scheduleCooldownMs: 5_000,
  },
};

async function createSkillFixture(params: {
  name: string;
  description: string;
  body: string;
  references?: Record<string, string>;
  source?: AvailableSkill["source"];
}): Promise<AvailableSkill> {
  const root = await mkdtemp(path.join(tmpdir(), "skill-harness-skill-"));
  roots.push(root);
  const skillDir = path.join(root, params.name);
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  const location = path.join(skillDir, "SKILL.md");
  await writeFile(
    location,
    `---\nname: ${params.name}\ndescription: ${params.description}\n---\n\n${params.body}\n`,
    "utf8",
  );
  for (const [relative, content] of Object.entries(params.references ?? {})) {
    const target = path.join(skillDir, "references", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return {
    name: params.name,
    description: params.description,
    location,
    source: params.source ?? "workspace",
  };
}

function createStoreDouble(params: {
  search?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
}) {
  return {
    update: params.update ?? vi.fn().mockResolvedValue({}),
    embed: params.embed ?? vi.fn().mockResolvedValue({}),
    search: params.search ?? vi.fn().mockResolvedValue([]),
    searchLex: vi.fn().mockResolvedValue([]),
    searchVector: vi.fn().mockResolvedValue([]),
    close: params.close ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as QMDStore;
}

async function waitFor(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

describe("writeSkillSnapshot", () => {
  it("materializes pure content docs and sidecar identity files", async () => {
    const skill = await createSkillFixture({
      name: "travel-planning",
      description: "Plan trips",
      body: "Use the travel checklist.",
      references: {
        "airports.md": "---\ntitle: Airports\n---\n\nMajor airports list",
        "nested/hotels.md": "Hotel notes",
      },
    });
    const docsRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-docs-"));
    roots.push(docsRoot);

    const collections = await writeSkillSnapshot({
      docsRoot,
      skills: [skill],
    });

    expect(collections).toEqual({
      "skill-meta": {
        path: path.join(docsRoot, "meta"),
        pattern: "**/meta.md",
      },
      "skill-body": {
        path: path.join(docsRoot, "body"),
        pattern: "**/SKILL.md",
      },
      "skill-references": {
        path: path.join(docsRoot, "references"),
        pattern: "**/*",
        ignore: ["**/*.identity.yml"],
      },
    });

    const segment = safePathSegment("travel-planning");
    const meta = await readFile(
      path.join(docsRoot, "meta", segment, "meta.md"),
      "utf8",
    );
    const body = await readFile(
      path.join(docsRoot, "body", segment, "SKILL.md"),
      "utf8",
    );
    const reference = await readFile(
      path.join(docsRoot, "references", segment, "airports.md"),
      "utf8",
    );
    const nested = await readFile(
      path.join(docsRoot, "references", segment, "nested", "hotels.md"),
      "utf8",
    );
    const metaIdentity = await readFile(
      path.join(docsRoot, "meta", segment, "meta.md.identity.yml"),
      "utf8",
    );
    const bodyIdentity = await readFile(
      path.join(docsRoot, "body", segment, "SKILL.md.identity.yml"),
      "utf8",
    );
    const referenceIdentity = await readFile(
      path.join(docsRoot, "references", segment, "airports.md.identity.yml"),
      "utf8",
    );

    expect(meta).toBe("# travel-planning\n\nPlan trips\n");
    expect(meta).not.toContain("skill:");
    expect(meta).not.toContain("---");
    expect(body).toBe("Use the travel checklist.\n");
    expect(body).not.toContain("name: travel-planning");
    expect(body).not.toContain("---");
    expect(reference).toBe("Major airports list\n");
    expect(reference).not.toContain("title: Airports");
    expect(reference).not.toContain("---");
    expect(nested).toBe("Hotel notes\n");
    expect(metaIdentity).toContain("skill: travel-planning");
    expect(metaIdentity).toContain("kind: meta");
    expect(metaIdentity).toContain("path: meta.md");
    expect(bodyIdentity).toContain("kind: body");
    expect(bodyIdentity).toContain("path: SKILL.md");
    expect(referenceIdentity).toContain("kind: reference");
    expect(referenceIdentity).toContain("path: references/airports.md");
  });

  it("encodes unsafe skill names into path-safe segments", () => {
    expect(safePathSegment("Weird Skill/Name")).toBe("Weird%20Skill%2FName");
    expect(safePathSegment("")).toBe("_");
    expect(safePathSegment("..")).toBe("%2E%2E");
    expect(safePathSegment("meta.v2")).toBe("meta%2Ev2");
  });

  it("skips reference symlinks that escape the references directory", async () => {
    const skill = await createSkillFixture({
      name: "escape-refs",
      description: "Has escaping refs",
      body: "Body",
      references: {
        "safe.md": "inside references",
      },
    });
    const skillDir = path.dirname(skill.location);
    const outside = await mkdtemp(path.join(tmpdir(), "skill-harness-secret-"));
    roots.push(outside);
    const secretPath = path.join(outside, "secret.txt");
    await writeFile(secretPath, "top-secret-token", "utf8");
    await symlink(secretPath, path.join(skillDir, "references", "leak.txt"));

    const docsRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-docs-"));
    roots.push(docsRoot);
    await writeSkillSnapshot({
      docsRoot,
      skills: [skill],
    });

    const segment = safePathSegment("escape-refs");
    const refsDir = path.join(docsRoot, "references", segment);
    const names = (await readdir(refsDir)).filter(
      (name) => !name.endsWith(".identity.yml"),
    );
    expect(names).toEqual(["safe.md"]);
    await expect(readFile(path.join(refsDir, "safe.md"), "utf8")).resolves.toBe(
      "inside references\n",
    );
  });

  it("skips a references directory that is itself an escaping symlink", async () => {
    const skill = await createSkillFixture({
      name: "escape-root",
      description: "Escaping references root",
      body: "Body",
    });
    const skillDir = path.dirname(skill.location);
    await rm(path.join(skillDir, "references"), {
      recursive: true,
      force: true,
    });
    const outside = await mkdtemp(path.join(tmpdir(), "skill-harness-secret-"));
    roots.push(outside);
    await writeFile(
      path.join(outside, "secret.txt"),
      "top-secret-token",
      "utf8",
    );
    await symlink(outside, path.join(skillDir, "references"));

    const docsRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-docs-"));
    roots.push(docsRoot);
    await writeSkillSnapshot({
      docsRoot,
      skills: [skill],
    });

    const segment = safePathSegment("escape-root");
    await expect(
      readdir(path.join(docsRoot, "references", segment)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("skillIdentityFromDocsPath", () => {
  it("parses identity from docsRoot-relative paths even with nested keywords", () => {
    const docsRoot = "/tmp/docs";
    expect(
      skillIdentityFromDocsPath({
        docsRoot,
        filepath: path.join(
          docsRoot,
          "references",
          safePathSegment("travel"),
          "references",
          "body",
          "api.md",
        ),
        collection: "skill-references",
      }),
    ).toEqual({
      skillName: "travel",
      relativePath: "references/references/body/api.md",
    });
  });
});

describe("createSkillQmdIndex", () => {
  it("builds a searchable store and ranks by best fused chunk", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const travel = await createSkillFixture({
      name: "travel-planning",
      description: "Plan trips",
      body: "Use the travel checklist.",
      references: { "airports.md": "Airport codes" },
    });
    const coding = await createSkillFixture({
      name: "code-review",
      description: "Review pull requests",
      body: "Check diffs carefully.",
    });

    const search = vi.fn(
      async (options?: { collection?: string; collections?: string[] }) => {
        const collection =
          options?.collection ??
          (Array.isArray(options?.collections)
            ? options.collections[0]
            : undefined);
        if (collection === "skill-meta") {
          return [
            {
              body: `---\nskill: travel-planning\nkind: meta\npath: meta.md\n---\nPlan trips`,
              score: 0.4,
            },
          ];
        }
        if (collection === "skill-body") {
          return [
            {
              body: `---\nskill: code-review\nkind: body\npath: SKILL.md\n---\nCheck diffs carefully.`,
              score: 0.9,
            },
          ];
        }
        if (collection === "skill-references") {
          return [
            {
              body: `---\nskill: travel-planning\nkind: reference\npath: references/airports.md\n---\nAirport codes`,
              score: 0.95,
            },
          ];
        }
        return [];
      },
    );

    const createStore = vi.fn(async () => createStoreDouble({ search }));
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [travel, coding]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      `index did not become ready; status=${index.getStatus("main")}`,
    );

    const hits = await index.search({
      agentId: "main",
      query: "airport trip planning",
      limit: 5,
      includeEvidence: true,
    });

    expect(createStore).toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "airport trip planning",
        collection: "skill-meta",
        rerank: false,
        includeHyde: false,
        minScore: 0,
      }),
    );
    expect(hits?.[0]?.name).toBe("travel-planning");
    expect(hits?.[0]?.evidence?.length).toBeGreaterThan(0);
    expect(hits?.some((hit) => hit.name === "code-review")).toBe(true);

    await index.close();
  });

  it("keeps serving the previous store while a newer rebuild is in flight", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const first = await createSkillFixture({
      name: "alpha",
      description: "First skill",
      body: "alpha body",
    });
    const second = await createSkillFixture({
      name: "beta",
      description: "Second skill",
      body: "beta body",
    });

    let releaseEmbed: (() => void) | undefined;
    let embedCount = 0;
    let secondEmbedStarted = false;
    const createStore = vi.fn(async () =>
      createStoreDouble({
        search: vi.fn().mockResolvedValue([
          {
            body: `---\nskill: alpha\nkind: meta\npath: meta.md\n---\nFirst skill`,
            score: 0.8,
          },
        ]),
        embed: vi.fn(() => {
          embedCount += 1;
          if (embedCount === 1) return Promise.resolve({});
          secondEmbedStarted = true;
          const { promise, resolve } =
            Promise.withResolvers<Record<string, never>>();
          releaseEmbed = () => resolve({});
          return promise;
        }),
      }),
    );

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [first]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "first build did not become ready",
    );

    index.schedule("main", [first, second]);
    await waitFor(
      () => index.getStatus("main") === "building" && secondEmbedStarted,
      "second build did not start",
    );

    const staleHits = await index.search({
      agentId: "main",
      query: "alpha",
      limit: 5,
    });
    expect(staleHits?.[0]?.name).toBe("alpha");

    releaseEmbed?.();
    await waitFor(
      () => index.getStatus("main") === "ready",
      "second build did not become ready",
    );
    await index.close();
  });

  it("returns undefined on failed-empty builds and auto-resumes cooldown schedules", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "gamma",
      description: "Gamma skill",
      body: "gamma body",
    });

    const pendingTimers: Array<{ delayMs: number; callback: () => void }> = [];
    const createStore = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(
        createStoreDouble({
          search: vi.fn().mockResolvedValue([
            {
              body: `---\nskill: gamma\nkind: meta\npath: meta.md\n---\nGamma skill`,
              score: 0.7,
            },
          ]),
        }),
      );

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
      setTimer: (callback, delayMs) => {
        const timer = { delayMs, callback };
        pendingTimers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        const indexOfTimer = pendingTimers.indexOf(
          timer as (typeof pendingTimers)[number],
        );
        if (indexOfTimer >= 0) pendingTimers.splice(indexOfTimer, 1);
      },
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "failed",
      "failed-empty build did not mark failed",
    );
    expect(
      await index.search({ agentId: "main", query: "gamma", limit: 5 }),
    ).toBeUndefined();

    nowMs += 60_000;
    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "retry build did not become ready",
    );

    const changed = await createSkillFixture({
      name: "gamma",
      description: "Gamma skill refreshed",
      body: "gamma body refreshed",
    });
    index.schedule("main", [changed]);
    await waitFor(
      () => pendingTimers.length === 1,
      "cooldown resume timer was not armed",
    );
    expect(createStore).toHaveBeenCalledTimes(2);
    expect(index.getStatus("main")).toBe("ready");

    nowMs += pendingTimers[0]!.delayMs;
    pendingTimers.shift()!.callback();
    await waitFor(
      () => createStore.mock.calls.length >= 3,
      "cooldown schedule did not auto-resume rebuild",
    );

    await index.close();
  });

  it("rebuilds when only the SKILL.md body changes", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "delta",
      description: "Stable description",
      body: "original body",
    });

    const createStore = vi.fn(async () =>
      createStoreDouble({
        search: vi.fn().mockResolvedValue([
          {
            body: `---\nskill: delta\nkind: body\npath: SKILL.md\n---\nbody`,
            score: 0.5,
          },
        ]),
      }),
    );
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "initial body index did not become ready",
    );
    expect(createStore).toHaveBeenCalledTimes(1);

    await writeFile(skill.location, "updated body only", "utf8");
    index.schedule("main", [skill]);
    await waitFor(
      () => createStore.mock.calls.length >= 2,
      "body-only change did not rebuild skill index",
    );

    await index.close();
  });

  it("clears orphan generation directories before building", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "orphan-cleanup",
      description: "Cleanup orphans",
      body: "Body",
    });
    const agentDir = path.join(root, "qmd", "skills", safePathSegment("main"));
    const orphan = path.join(agentDir, "gen-1-deadbeefdead");
    await mkdir(path.join(orphan, "docs"), { recursive: true });
    await writeFile(path.join(orphan, "docs", "stale.txt"), "stale", "utf8");

    const createStore = vi.fn(async () =>
      createStoreDouble({
        search: vi.fn().mockResolvedValue([
          {
            filepath: path.join(
              "docs",
              "meta",
              safePathSegment("orphan-cleanup"),
              "meta.md",
            ),
            body: "---\nskill: orphan-cleanup\npath: meta.md\n---\n",
            score: 0.9,
          },
        ]),
      }),
    );
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "orphan cleanup index did not become ready",
    );

    const generations = (await readdir(agentDir)).filter((name) =>
      name.startsWith("gen-"),
    );
    expect(generations).toHaveLength(1);
    expect(generations[0]).not.toBe("gen-1-deadbeefdead");

    await index.close();
  });

  it("recovers skill identity from docsRoot when frontmatter is missing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "path-fallback",
      description: "Path fallback",
      body: "Body",
      references: {
        "references/body/api.md": "nested keyword path",
      },
    });

    const createStore = vi.fn(async (options: { dbPath: string }) => {
      const docsRoot = path.join(path.dirname(options.dbPath), "docs");
      const nestedPath = path.join(
        docsRoot,
        "references",
        safePathSegment("path-fallback"),
        "references",
        "body",
        "api.md",
      );
      return createStoreDouble({
        search: vi.fn(async (searchOptions?: { collection?: string }) => {
          if (searchOptions?.collection !== "skill-references") return [];
          return [
            {
              filepath: nestedPath,
              body: "chunk without identity frontmatter",
              score: 0.8,
            },
          ];
        }),
      });
    });

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "path fallback index did not become ready",
    );

    const results = await index.search({
      agentId: "main",
      query: "nested",
      limit: 5,
      includeEvidence: true,
    });
    expect(results).toEqual([
      expect.objectContaining({
        name: "path-fallback",
        evidence: [
          expect.objectContaining({
            collection: "skill-references",
            path: "references/references/body/api.md",
          }),
        ],
      }),
    ]);

    await index.close();
  });

  it("serializes builds across index instances so orphans are not cleared mid-build", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "lock-safe",
      description: "Lock safe skill",
      body: "body",
    });

    let releaseFirst: (() => void) | undefined;
    let firstGenerationRoot: string | undefined;
    let secondCreateStarted = false;

    const createStoreA = vi.fn(async (options: { dbPath: string }) => {
      firstGenerationRoot = path.dirname(options.dbPath);
      const { promise, resolve } =
        Promise.withResolvers<Record<string, never>>();
      releaseFirst = () => resolve({});
      return createStoreDouble({
        embed: vi.fn(() => promise),
        search: vi.fn().mockResolvedValue([
          {
            body: `---\nskill: lock-safe\nkind: meta\npath: meta.md\n---\nLock safe skill`,
            score: 0.8,
          },
        ]),
      });
    });
    const createStoreB = vi.fn(async () => {
      secondCreateStarted = true;
      return createStoreDouble({
        search: vi.fn().mockResolvedValue([
          {
            body: `---\nskill: lock-safe\nkind: meta\npath: meta.md\n---\nLock safe skill`,
            score: 0.8,
          },
        ]),
      });
    });

    const indexA = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStoreA as never,
      nowMs: () => nowMs,
    });
    const indexB = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
        skillSearch: {
          ...qmdConfig.skillSearch,
          scheduleCooldownMs: 0,
        },
      }),
      createStore: createStoreB as never,
      nowMs: () => nowMs,
    });

    indexA.schedule("main", [skill]);
    await waitFor(
      () => firstGenerationRoot !== undefined,
      "first build did not create a generation root",
    );
    expect(firstGenerationRoot).toBeDefined();

    indexB.schedule("main", [skill]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(secondCreateStarted).toBe(false);
    expect(await readdir(firstGenerationRoot!)).toContain("docs");

    releaseFirst?.();
    await waitFor(
      () => indexA.getStatus("main") === "ready",
      "first build did not become ready",
    );
    await waitFor(
      () => createStoreB.mock.calls.length >= 1,
      "second build did not start after lock release",
    );
    await waitFor(
      () => indexB.getStatus("main") === "ready",
      "second build did not become ready",
    );

    await indexA.close();
    await indexB.close();
  });

  it("retries LEASE_BUSY build failures after the backoff window", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "lease-busy",
      description: "Lease busy skill",
      body: "body",
    });

    class EmbeddingIdentityStateError extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = "EmbeddingIdentityStateError";
        this.code = code;
      }
    }

    const createStore = vi
      .fn()
      .mockRejectedValueOnce(
        new EmbeddingIdentityStateError(
          "LEASE_BUSY",
          "Embedding build lease is owned by other-owner.",
        ),
      )
      .mockResolvedValue(
        createStoreDouble({
          search: vi.fn().mockResolvedValue([
            {
              body: `---\nskill: lease-busy\nkind: meta\npath: meta.md\n---\nLease busy skill`,
              score: 0.7,
            },
          ]),
        }),
      );

    const pendingTimers: Array<{ delayMs: number; callback: () => void }> = [];
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
      setTimer: (callback, delayMs) => {
        const timer = { delayMs, callback };
        pendingTimers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        const indexOfTimer = pendingTimers.indexOf(
          timer as (typeof pendingTimers)[number],
        );
        if (indexOfTimer >= 0) pendingTimers.splice(indexOfTimer, 1);
      },
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "failed",
      "LEASE_BUSY build did not mark failed",
    );
    expect(createStore).toHaveBeenCalledTimes(1);
    await waitFor(
      () => pendingTimers.length === 1,
      "LEASE_BUSY retry timer was not armed",
    );

    nowMs += pendingTimers[0]!.delayMs;
    pendingTimers.shift()!.callback();
    await waitFor(
      () => index.getStatus("main") === "ready",
      "LEASE_BUSY retry did not become ready",
    );
    expect(createStore).toHaveBeenCalledTimes(2);

    await index.close();
  });

  it("fails the build when generation listing hits a non-ENOENT error", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "permission-denied",
      description: "Permission denied skill",
      body: "Body",
    });
    const agentDir = path.join(root, "qmd", "skills", safePathSegment("main"));
    await mkdir(agentDir, { recursive: true });

    const realReaddir = fsPromises.readdir.bind(fsPromises);
    const readdirSpy = vi
      .spyOn(fsPromises, "readdir")
      .mockImplementation(async (dir, options) => {
        if (path.resolve(String(dir)) === path.resolve(agentDir)) {
          throw Object.assign(new Error("permission denied"), {
            code: "EACCES",
          });
        }
        return realReaddir(dir as never, options as never);
      });

    const createStore = vi.fn(async () => createStoreDouble({}));
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    index.schedule("main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "failed",
      "non-ENOENT generation listing did not mark failed",
    );
    expect(createStore).not.toHaveBeenCalled();
    expect(readdirSpy).toHaveBeenCalled();

    await index.close();
  });
});
