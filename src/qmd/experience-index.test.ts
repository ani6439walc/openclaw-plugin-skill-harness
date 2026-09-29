import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QMDStore } from "@wei840222/qmd";
import type { SkillExperienceEntry } from "../experiences/types.js";
import type { ResolvedQmdConfig } from "../types.js";
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
    identity: "cx/image-analysis",
    skill: "cx",
    entryId: "image-analysis",
    summary: "Visual inspection and structured extraction from screenshots.",
    keywords: ["ocr", "image", "screenshot"],
    body: "# Image Analysis\n\n## Guidance\nPerform OCR and image inspection.\n",
    path: "/tmp/mock/cx/image-analysis.md",
  },
  {
    identity: "treemd/docs-lookup",
    skill: "treemd",
    entryId: "docs-lookup",
    summary: "Lookup documentation in project knowledge trees.",
    keywords: ["docs", "lookup", "documentation"],
    body: "# Docs Lookup\n\n## Guidance\nUse tree navigation for project documentation.\n",
    path: "/tmp/mock/treemd/docs-lookup.md",
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

  it("builds index and performs search returning parsed hits", async () => {
    const mockStore: Partial<QMDStore> = {
      update: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ errors: 0, embedded: 2 }),
      getStatus: vi.fn().mockResolvedValue({ needsEmbedding: 0 }),
      search: vi.fn().mockResolvedValue([
        {
          filepath: "cx/image-analysis.md",
          score: 0.92,
          explain: { vectorScores: [0.95] },
        },
      ]),
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

    // Wait until status is ready
    let attempts = 0;
    while (index.getStatus() !== "ready" && attempts < 50) {
      await new Promise((r) => setTimeout(r, 50));
      attempts += 1;
    }

    expect(index.getStatus()).toBe("ready");
    expect(createStore).toHaveBeenCalled();
    expect(mockStore.update).toHaveBeenCalled();
    expect(mockStore.embed).toHaveBeenCalled();

    const hits = await index.search({ query: "analyze screenshot" });
    expect(hits).toBeDefined();
    expect(hits).toHaveLength(1);
    expect(hits![0]).toMatchObject({
      identity: "cx/image-analysis",
      skill: "cx",
      entryId: "image-analysis",
      score: 0.92,
      semanticScore: 0.95,
      collection: "skill-experiences",
    });
  });

  it("handles empty or failed searches gracefully", async () => {
    const mockStore: Partial<QMDStore> = {
      update: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ errors: 0, embedded: 2 }),
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

    while (index.getStatus() !== "ready") {
      await new Promise((r) => setTimeout(r, 50));
    }

    const hits = await index.search({ query: "broken" });
    expect(hits).toBeUndefined();
  });
});
