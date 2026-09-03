import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QMDStore } from "@wei840222/qmd";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import {
  createSkillQmdIndex,
  safePathSegment,
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
  searchLex?: ReturnType<typeof vi.fn>;
  searchVector?: ReturnType<typeof vi.fn>;
  close?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
}) {
  return {
    update: params.update ?? vi.fn().mockResolvedValue({}),
    embed: params.embed ?? vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue([]),
    searchLex: params.searchLex ?? vi.fn().mockResolvedValue([]),
    searchVector: params.searchVector ?? vi.fn().mockResolvedValue([]),
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
  it("materializes meta, body, and references with identity frontmatter", async () => {
    const skill = await createSkillFixture({
      name: "travel-planning",
      description: "Plan trips",
      body: "Use the travel checklist.",
      references: {
        "airports.md": "Major airports list",
        "nested/hotels.md": "Hotel notes",
      },
    });
    const docsRoot = await mkdtemp(path.join(tmpdir(), "skill-harness-docs-"));
    roots.push(docsRoot);

    const collections = await writeSkillSnapshot({
      docsRoot,
      skills: [skill],
    });

    expect(Object.keys(collections).sort()).toEqual([
      "skill-body",
      "skill-meta",
      "skill-references",
    ]);

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

    expect(meta).toContain("skill: travel-planning");
    expect(meta).toContain("kind: meta");
    expect(meta).toContain("path: meta.md");
    expect(meta).toContain("Plan trips");
    expect(body).toContain("kind: body");
    expect(body).toContain("Use the travel checklist.");
    expect(reference).toContain("kind: reference");
    expect(reference).toContain("path: references/airports.md");
    expect(nested).toContain("path: references/nested/hotels.md");
  });

  it("encodes unsafe skill names into path-safe segments", () => {
    expect(safePathSegment("Weird Skill/Name")).toBe("Weird%20Skill%2FName");
    expect(safePathSegment("")).toBe("_");
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

    const searchLex = vi.fn(
      async (_query: string, options?: { collection?: string }) => {
        if (options?.collection === "skill-meta") {
          return [
            {
              filepath: `/docs/meta/${safePathSegment("travel-planning")}/meta.md`,
              body: `---\nskill: travel-planning\nkind: meta\npath: meta.md\n---\nPlan trips`,
              score: 0.4,
            },
          ];
        }
        return [];
      },
    );
    const searchVector = vi.fn(
      async (_query: string, options?: { collection?: string }) => {
        if (options?.collection === "skill-body") {
          return [
            {
              filepath: `/docs/body/${safePathSegment("code-review")}/SKILL.md`,
              body: `---\nskill: code-review\nkind: body\npath: SKILL.md\n---\nCheck diffs carefully.`,
              score: 0.9,
            },
          ];
        }
        if (options?.collection === "skill-references") {
          return [
            {
              filepath: `/docs/references/${safePathSegment("travel-planning")}/airports.md`,
              body: `---\nskill: travel-planning\nkind: reference\npath: references/airports.md\n---\nAirport codes`,
              score: 0.95,
            },
          ];
        }
        return [];
      },
    );

    const createStore = vi.fn(async () =>
      createStoreDouble({ searchLex, searchVector }),
    );
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
        searchLex: vi.fn().mockResolvedValue([
          {
            filepath: `/docs/meta/${safePathSegment("alpha")}/meta.md`,
            body: `---\nskill: alpha\nkind: meta\npath: meta.md\n---\nFirst skill`,
            score: 0.8,
          },
        ]),
        searchVector: vi.fn().mockResolvedValue([]),
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

  it("returns undefined on failed-empty builds and coalesces cooldown schedules", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "skill-harness-qmd-skills-"),
    );
    roots.push(root);
    const skill = await createSkillFixture({
      name: "gamma",
      description: "Gamma skill",
      body: "gamma body",
    });

    const createStore = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(
        createStoreDouble({
          searchLex: vi.fn().mockResolvedValue([
            {
              filepath: `/docs/meta/${safePathSegment("gamma")}/meta.md`,
              body: `---\nskill: gamma\nkind: meta\npath: meta.md\n---\nGamma skill`,
              score: 0.7,
            },
          ]),
          searchVector: vi.fn().mockResolvedValue([]),
        }),
      );

    const index = createSkillQmdIndex({
      dataRoot: root,
      config: () => qmdConfig,
      createStore: createStore as never,
      nowMs: () => nowMs,
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
      () => index.getStatus("main") === "ready",
      "ready status should remain while cooldown defers rebuild",
    );
    expect(createStore).toHaveBeenCalledTimes(2);

    nowMs += 5_000;
    index.schedule("main", [changed]);
    await waitFor(
      () => createStore.mock.calls.length >= 3,
      "cooldown schedule did not rebuild",
    );

    await index.close();
  });
});
