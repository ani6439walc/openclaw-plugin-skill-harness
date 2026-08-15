import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfig } from "../config.js";
import { filterIntentsForAgent, IntentCatalog } from "./catalog.js";
import type { IntentCatalogEntry } from "../types.js";

describe("IntentCatalog", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-catalog-"));
    fs.mkdirSync(path.join(root, "intents"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("create", () => {
    it("returns a shared instance for the same plugin root", () => {
      const catalog1 = IntentCatalog.create(root);
      const catalog2 = IntentCatalog.create(root);

      expect(catalog1).toBe(catalog2);
    });

    it("returns different instances for different plugin roots", () => {
      const otherRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "intent-catalog-other-"),
      );
      try {
        const catalog1 = IntentCatalog.create(root);
        const catalog2 = IntentCatalog.create(otherRoot);

        expect(catalog1).not.toBe(catalog2);
      } finally {
        fs.rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });

  it("derives intent ids from filenames and normalizes strict routing metadata", () => {
    fs.writeFileSync(
      path.join(root, "intents", "agent-dispatch.md"),
      `---
triggers:
  - "route"
examples:
  - "route this"
domain: "routing"
fastpath:
  keywords:
    - "route"
guidance: "Route this request using stable evidence."
---
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()).toEqual([
      {
        id: "agent-dispatch",
        definition: {
          triggers: ["route"],
          examples: ["route this"],
          domain: "routing",
          fastpath: {
            keywords: ["route"],
          },
          guidance: "Route this request using stable evidence.",
        },
      },
    ]);
  });

  it("defaults missing fastpath metadata to an empty keyword list", () => {
    fs.writeFileSync(
      path.join(root, "intents", "chat.md"),
      `---
triggers:
  - "User chats casually"
examples:
  - "hi"
domain: "chat"
guidance: "Reply naturally to this social interaction."
---
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()[0]?.definition.fastpath).toEqual({ keywords: [] });
  });

  it("loads the strict routing contract without a legacy Markdown body", () => {
    fs.writeFileSync(
      path.join(root, "intents", "routing.md"),
      `---
triggers: ["route"]
examples: ["route this"]
domain: "routing"
fastpath:
  keywords: ["route"]
guidance: "Route this request using stable evidence."
---
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);
    expect(catalog.get()).toEqual([
      {
        id: "routing",
        definition: {
          triggers: ["route"],
          examples: ["route this"],
          domain: "routing",
          fastpath: { keywords: ["route"] },
          guidance: "Route this request using stable evidence.",
        },
      },
    ]);
    expect(catalog.get()[0]?.definition).not.toHaveProperty("prompt");
  });

  it("rejects legacy intent bodies instead of loading a second parser contract", () => {
    fs.writeFileSync(
      path.join(root, "intents", "legacy.md"),
      `---
triggers: ["route"]
examples: ["route this"]
domain: "routing"
guidance: "Route this request using stable evidence."
---
## Legacy
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(0);
    expect(catalog.get()).toEqual([]);
  });

  it("rejects legacy top-level keywords instead of coercing them", () => {
    fs.writeFileSync(
      path.join(root, "intents", "legacy.md"),
      `---
triggers:
  - "legacy route"
examples:
  - "legacy"
domain: "legacy"
keywords:
  - "old"
  - ""
  - 123
---
guidance: "Keep routing focused on current metadata."
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(0);
    expect(catalog.get()).toEqual([]);
  });

  it("loads valid siblings when another runtime intent is invalid", () => {
    fs.writeFileSync(
      path.join(root, "intents", "current.md"),
      `---
triggers: ["route"]
examples: ["route this"]
domain: "routing"
guidance: "Route this request using stable evidence."
---
`,
    );
    fs.writeFileSync(
      path.join(root, "intents", "legacy.md"),
      `---
triggers: ["legacy route"]
examples: ["legacy"]
domain: "legacy"
fastpath:
  hint: "Legacy hint."
guidance: "Keep routing focused on current metadata."
---
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);
    expect(catalog.get().map((intent) => intent.id)).toEqual(["current"]);
  });

  it("rejects invalid candidate metadata instead of coercing it", () => {
    fs.writeFileSync(
      path.join(root, "intents", "invalid-candidate.md"),
      `---
triggers: ["route"]
examples: ["route this"]
domain: "routing"
candidate:
  scope: global
  keywords:
    - "valid"
    - ""
    - 123
---
guidance: "Route carefully using verified metadata."
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(0);
    expect(catalog.get()).toEqual([]);
  });

  it("skips files without triggers or domain", () => {
    fs.writeFileSync(
      path.join(root, "intents", "empty.md"),
      `---
examples:
  - "example"
domain: "test"
---
## Guidelines
- Missing triggers.
`,
    );
    fs.writeFileSync(
      path.join(root, "intents", "missing-domain.md"),
      `---
triggers:
  - "trigger"
examples:
  - "example"
---
## Guidelines
- Missing domain.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(0);
    expect(catalog.get()).toEqual([]);
  });

  describe("filterForAgent", () => {
    const intents: IntentCatalogEntry[] = [
      {
        id: "CHAT",
        definition: {
          triggers: ["Social"],
          examples: [],
          domain: "chat",
          fastpath: { keywords: [] },
          guidance: "Chat hint",
        },
      },
      {
        id: "MEMORY_RECENT",
        definition: {
          triggers: ["Recall recent context"],
          examples: [],
          domain: "memory",
          fastpath: { keywords: [] },
          guidance: "Memory hint",
        },
      },
      {
        id: "TYPO",
        definition: {
          triggers: ["Typing error"],
          examples: [],
          domain: "typing",
          fastpath: { keywords: [] },
          guidance: "Typo hint",
        },
      },
    ];

    function testFilter(
      intentDeny: Record<string, string[]>,
      agentId: string | undefined,
    ) {
      const catalog = IntentCatalog.create(root);
      catalog.setIntents(intents);
      return catalog.filterForAgent(resolveConfig({ intentDeny }), agentId);
    }

    it("does not filter when agent has no matching deny entry", () => {
      const result = testFilter({ main: ["TYPO"] }, "other");
      expect(result.map((intent) => intent.id)).toEqual([
        "CHAT",
        "MEMORY_RECENT",
        "TYPO",
      ]);
    });

    it("filters exact intent ids for exact agent ids", () => {
      const result = testFilter({ main: ["TYPO"] }, "main");
      expect(result.map((intent) => intent.id)).toEqual([
        "CHAT",
        "MEMORY_RECENT",
      ]);
    });

    it("supports wildcard agent ids and intent ids", () => {
      const result = testFilter(
        { "*": ["MEMORY_*"], "work-*": ["CH?T"] },
        "work-main",
      );
      expect(result.map((intent) => intent.id)).toEqual(["TYPO"]);
    });

    it("matches patterns case-insensitively", () => {
      const result = testFilter({ MAIN: ["typo"] }, "main");
      expect(result.map((intent) => intent.id)).toEqual([
        "CHAT",
        "MEMORY_RECENT",
      ]);
    });
  });
});

describe("filterIntentsForAgent", () => {
  it("returns a copy when there are no deny patterns", () => {
    const intents: IntentCatalogEntry[] = [
      {
        id: "CHAT",
        definition: {
          triggers: ["Social"],
          examples: [],
          domain: "chat",
          fastpath: { keywords: [] },
          guidance: "Chat hint",
        },
      },
    ];

    const result = filterIntentsForAgent(intents, resolveConfig({}), "main");
    expect(result).toEqual(intents);
    expect(result).not.toBe(intents);
  });
});
