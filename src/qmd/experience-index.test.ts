import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QMDStore } from "@wei840222/qmd";
import type { SkillExperienceEntry } from "../experiences/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import {
  createSkillExperienceQmdIndex,
  EXPERIENCE_COLLECTIONS,
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
    expect(
      await fs.readFile(
        path.join(docsDir, "keywords", "image-analysis.md.identity.yml"),
        "utf8",
      ),
    ).toContain("id: image-analysis");

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
      addCollection: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
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
});
