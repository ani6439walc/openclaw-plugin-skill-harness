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
  skillIndexFingerprint,
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
  skills: {
    search: {
      collectionWeights: { meta: 2, body: 1, references: 0.5 },
    },
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
  getStatus?: ReturnType<typeof vi.fn>;
  internal?: QMDStore["internal"];
}) {
  return {
    update: params.update ?? vi.fn().mockResolvedValue({}),
    embed: params.embed ?? vi.fn().mockResolvedValue({ errors: 0 }),
    getStatus:
      params.getStatus ??
      vi.fn().mockResolvedValue({ needsEmbedding: 0, totalDocuments: 1 }),
    search: params.search ?? vi.fn().mockResolvedValue([]),
    searchLex: vi.fn().mockResolvedValue([]),
    searchVector: vi.fn().mockResolvedValue([]),
    close: params.close ?? vi.fn().mockResolvedValue(undefined),
    ...(params.internal ? { internal: params.internal } : {}),
  } as unknown as QMDStore;
}

function scheduleSkills(
  index: ReturnType<typeof createSkillQmdIndex>,
  agentId: string,
  skills: readonly AvailableSkill[],
  sourceRoots: readonly string[] = ["/shared-skills"],
): void {
  index.schedule(agentId, { skills, sourceRoots });
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

  it("parses identity from qmd:// virtual filepath hits", () => {
    expect(
      skillIdentityFromDocsPath({
        docsRoot: "/tmp/docs",
        filepath: "qmd://skill-meta/openclaw/meta.md",
        collection: "skill-meta",
      }),
    ).toEqual({
      skillName: "openclaw",
      relativePath: "meta.md",
    });

    expect(
      skillIdentityFromDocsPath({
        docsRoot: "/tmp/docs",
        filepath: "qmd://skill-body/git-master/SKILL.md",
        collection: "skill-body",
      }),
    ).toEqual({
      skillName: "git-master",
      relativePath: "SKILL.md",
    });

    expect(
      skillIdentityFromDocsPath({
        docsRoot: "/tmp/docs",
        filepath: "qmd://skill-references/home-assistant/workflows.md",
        collection: "skill-references",
      }),
    ).toEqual({
      skillName: "home-assistant",
      relativePath: "references/workflows.md",
    });
  });

  it("parses identity from collection-relative displayPath hits", () => {
    expect(
      skillIdentityFromDocsPath({
        docsRoot: "/tmp/docs",
        filepath: "openclaw/meta.md",
        collection: "skill-meta",
      }),
    ).toEqual({
      skillName: "openclaw",
      relativePath: "meta.md",
    });
  });
});

describe("createSkillQmdIndex", () => {
  it("keeps a stable fingerprint across skill content changes", () => {
    const first = skillIndexFingerprint({
      sourceRoots: ["/skills/b", "/skills/a", "/skills/a"],
      embeddingModel: "openai/text-embedding-3-small",
      embeddingDimension: 1536,
    });
    const same = skillIndexFingerprint({
      sourceRoots: ["/skills/a", "/skills/b"],
      embeddingModel: "bifrost/text-embedding-3-small",
      embeddingDimension: 1536,
    });
    const otherRoot = skillIndexFingerprint({
      sourceRoots: ["/skills/a"],
      embeddingModel: "text-embedding-3-small",
      embeddingDimension: 1536,
    });

    expect(same).toBe(first);
    expect(otherRoot).not.toBe(first);
  });

  it("shares one store and filters results by each agent's allowed skills", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-shared-qmd-"));
    roots.push(root);
    const alpha = await createSkillFixture({
      name: "alpha",
      description: "Alpha skill",
      body: "alpha",
    });
    const beta = await createSkillFixture({
      name: "beta",
      description: "Beta skill",
      body: "beta",
    });
    const search = vi.fn().mockResolvedValue([
      { body: "---\nskill: alpha\npath: SKILL.md\n---\nalpha", score: 0.9 },
      { body: "---\nskill: beta\npath: SKILL.md\n---\nbeta", score: 0.8 },
    ]);
    const createStore = vi.fn(async () => createStoreDouble({ search }));
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [alpha, beta]);
    scheduleSkills(index, "lite", [beta]);
    await waitFor(
      () => index.getStatus("main") === "ready" && index.getStatus("lite") === "ready",
      "shared index did not become ready",
    );

    const main = await index.search({ agentId: "main", query: "skills", limit: 5 });
    const lite = await index.search({ agentId: "lite", query: "skills", limit: 5 });

    expect(createStore).toHaveBeenCalledTimes(1);
    expect(main?.map((hit) => hit.name).sort()).toEqual(["alpha", "beta"]);
    expect(lite?.map((hit) => hit.name)).toEqual(["beta"]);
    await index.close();
  });


  it("restores persisted allowed skills before the first scheduled refresh", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const fingerprint = skillIndexFingerprint({
      sourceRoots: ["/shared-skills"],
      embeddingModel: qmdConfig.embedding.model,
      embeddingDimension: qmdConfig.embedding.dimension,
    });
    const indexRoot = path.join(root, "qmd", "skills", "indexes", fingerprint);
    await mkdir(path.join(indexRoot, "docs"), { recursive: true });
    await writeFile(path.join(indexRoot, "skill-search.sqlite"), "sqlite", "utf8");
    await mkdir(path.join(root, "qmd", "skills", "agents"), { recursive: true });
    await writeFile(
      path.join(root, "qmd", "skills", "agents", "main.json"),
      JSON.stringify({
        schemaVersion: 1,
        fingerprint,
        allowedSkillNames: ["beta"],
      }),
      "utf8",
    );
    const search = vi.fn().mockResolvedValue([
      { body: "---\nskill: alpha\npath: SKILL.md\n---\nalpha", score: 1 },
      { body: "---\nskill: beta\npath: SKILL.md\n---\nbeta", score: 0.9 },
    ]);
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: (async () => createStoreDouble({ search })) as never,
    });

    const results = await index.search({ agentId: "main", query: "skills", limit: 5 });

    expect(results?.map((result) => result.name)).toEqual(["beta"]);
    await index.close();
  });

  it("keeps partial embeddings searchable and retries the same store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-harness-partial-qmd-"));
    roots.push(root);
    const skill = await createSkillFixture({
      name: "partial",
      description: "Partial skill",
      body: "partial",
    });
    const pendingTimers: Array<() => void> = [];
    const store = createStoreDouble({
      search: vi.fn().mockResolvedValue([
        { body: "---\nskill: partial\npath: SKILL.md\n---\npartial", score: 1 },
      ]),
      embed: vi
        .fn()
        .mockResolvedValueOnce({ errors: 1 })
        .mockResolvedValueOnce({ errors: 0 }),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ needsEmbedding: 1, totalDocuments: 1 })
        .mockResolvedValueOnce({ needsEmbedding: 0, totalDocuments: 1 }),
    });
    const createStore = vi.fn(async () => store);
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
      setTimer: (callback) => {
        pendingTimers.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
    });

    scheduleSkills(index, "main", [skill]);
    await waitFor(() => index.getStatus("main") === "ready", "partial index not searchable");
    expect((await index.search({ agentId: "main", query: "partial", limit: 1 }))?.[0]?.name).toBe("partial");
    expect(pendingTimers).toHaveLength(1);
    pendingTimers.shift()?.();
    await waitFor(() => (store.embed as ReturnType<typeof vi.fn>).mock.calls.length === 2, "partial retry did not resume");
    expect(createStore).toHaveBeenCalledTimes(1);
    await index.close();
  });

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

    scheduleSkills(index, "main", [travel, coding]);
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

  it("keeps unchanged snapshot documents untouched", async () => {
    const skill = await createSkillFixture({
      name: "snapshot-diff",
      description: "Snapshot diff skill",
      body: "body",
    });
    const docsRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-docs-"));
    roots.push(docsRoot);
    await writeSkillSnapshot({ docsRoot, skills: [skill] });
    const bodyPath = path.join(
      docsRoot,
      "body",
      safePathSegment(skill.name),
      "SKILL.md",
    );
    const before = await (await import("node:fs/promises")).stat(bodyPath);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await writeSkillSnapshot({ docsRoot, skills: [skill] });
    const after = await (await import("node:fs/promises")).stat(bodyPath);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("waits for pending fingerprint scheduling before closing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "close-race",
      description: "Close race skill",
      body: "body",
    });
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: (async () => createStoreDouble({})) as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
    await index.close();

    await expect(
      fsPromises.access(path.join(root, "qmd", "skills", "main")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rebuild when only non-index QMD settings change", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "stable-config",
      description: "Stable config skill",
      body: "body",
    });
    const createStore = vi.fn(async () => createStoreDouble({}));
    let config = qmdConfig;
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => config,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "initial index did not become ready",
    );
    config = {
      ...qmdConfig,
      timeoutMs: 9_999,
      embedding: {
        ...qmdConfig.embedding,
        baseUrl: "https://other.example.test/v1",
      },
      expansion: { ...qmdConfig.expansion, model: "other-expand-model" },
      skills: {
        search: {
          collectionWeights: { meta: 3, body: 2, references: 1 },
        },
      },
    };
    scheduleSkills(index, "main", [skill]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createStore).toHaveBeenCalledTimes(1);
    await index.close();
  });

  it("does not rebuild when only the embedding provider prefix changes", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "provider-prefix-change",
      description: "Provider change skill",
      body: "body",
    });
    const createStore = vi.fn(async () => createStoreDouble({}));
    let config: ResolvedQmdConfig = {
      ...qmdConfig,
      embedding: {
        ...qmdConfig.embedding,
        model: "openai/text-embedding-3-small",
      },
    };
    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => config,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "initial index did not become ready",
    );

    // Switch provider prefix from openai/ to bifrost/ while keeping model identical
    config = {
      ...config,
      embedding: {
        ...config.embedding,
        model: "bifrost/text-embedding-3-small",
      },
    };
    scheduleSkills(index, "main", [skill]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createStore).toHaveBeenCalledTimes(1);
    await index.close();
  });

  it("does not re-queue or rebuild when scheduled repeatedly while building the same fingerprint", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "in-flight-dedupe",
      description: "In-flight dedupe skill",
      body: "body",
    });

    let releaseEmbed: (() => void) | undefined;
    let embedStarted = false;
    const createStore = vi.fn(async () =>
      createStoreDouble({
        embed: vi.fn(() => {
          embedStarted = true;
          const { promise, resolve } =
            Promise.withResolvers<Record<string, never>>();
          releaseEmbed = () => resolve({});
          return promise;
        }),
      }),
    );

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
    await waitFor(() => embedStarted, "embed did not start");

    // Re-schedule multiple times with the exact same skills while building
    scheduleSkills(index, "main", [skill]);
    scheduleSkills(index, "main", [skill]);

    // Release embed and wait for index to be ready
    releaseEmbed?.();
    await waitFor(
      () => index.getStatus("main") === "ready",
      "index did not become ready",
    );

    // Allow any pending microtasks to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // createStore should only be called ONCE
    expect(createStore).toHaveBeenCalledTimes(1);
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
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
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

  it("recovers skill identity from qmd:// virtual hits when frontmatter is missing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "openclaw",
      description: "OpenClaw ops",
      body: "Gateway config guidance",
    });

    const createStore = vi.fn(async () =>
      createStoreDouble({
        search: vi.fn(async (searchOptions?: { collection?: string }) => {
          if (searchOptions?.collection !== "skill-meta") return [];
          return [
            {
              file: "qmd://skill-meta/openclaw/meta.md",
              displayPath: "openclaw/meta.md",
              body: "# openclaw\n\nComprehensive OpenClaw operations",
              score: 0.91,
            },
          ];
        }),
      }),
    );

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
      }),
      createStore: createStore as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(index, "main", [skill]);
    await waitFor(
      () => index.getStatus("main") === "ready",
      "qmd virtual path index did not become ready",
    );

    const results = await index.search({
      agentId: "main",
      query: "openclaw gateway",
      limit: 5,
      includeEvidence: true,
    });
    expect(results).toEqual([
      expect.objectContaining({
        name: "openclaw",
        evidence: [
          expect.objectContaining({
            collection: "skill-meta",
            path: "meta.md",
          }),
        ],
      }),
    ]);

    await index.close();
  });

  it("serializes refreshes across index instances sharing a fingerprint", async () => {
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
    let firstIndexRoot: string | undefined;
    let secondCreateStarted = false;

    const createStoreA = vi.fn(async (options: { dbPath: string }) => {
      firstIndexRoot = path.dirname(options.dbPath);
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
      }),
      createStore: createStoreA as never,
      nowMs: () => nowMs,
    });
    const indexB = createSkillQmdIndex({
      dataRoot: root,
      config: () => ({
        ...qmdConfig,
      }),
      createStore: createStoreB as never,
      nowMs: () => nowMs,
    });

    scheduleSkills(indexA, "main", [skill]);
    await waitFor(
      () => firstIndexRoot !== undefined,
      "first refresh did not create the shared index root",
    );
    expect(firstIndexRoot).toBeDefined();

    scheduleSkills(indexB, "main", [skill]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(secondCreateStarted).toBe(false);
    expect(await readdir(firstIndexRoot!)).toContain("docs");

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

    scheduleSkills(index, "main", [skill]);
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

});
