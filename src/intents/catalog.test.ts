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

  it("derives intent ids from filenames and ignores stale metadata fields", () => {
    fs.writeFileSync(
      path.join(root, "intents", "agent-dispatch.md"),
      `---
id: AGENT_DISPATCH
name: Old Name
enabled: false
triggers:
  - "User manages agent workflow"
examples:
  - "spawn a subagent"
domain: "agent"
skills:
  - code-review
  - 123
  - ""
fastpath:
  hint: "Route lightweight agent dispatch requests directly."
  keywords:
    - "spawn"
    - "派代理"
candidate:
  scope: cross-flow
  keywords:
    - "  agent dispatch  "
    - "代理派送"
---
## Guidelines
- Route by filename.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()).toEqual([
      {
        id: "agent-dispatch",
        definition: {
          triggers: ["User manages agent workflow"],
          examples: ["spawn a subagent"],
          domain: "agent",
          skills: ["code-review"],
          fastpath: {
            keywords: ["spawn", "派代理"],
            hint: "Route lightweight agent dispatch requests directly.",
          },
          candidate: {
            scope: "cross-flow",
            keywords: ["  agent dispatch  ", "代理派送"],
          },
          prompt: "## Guidelines\n- Route by filename.",
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
---
## Guidelines
- Reply naturally.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()[0]?.definition.fastpath).toEqual({ keywords: [] });
  });

  it("maps legacy top-level keywords into fastpath keywords", () => {
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
## Guidelines
- Keep old routing alive.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()[0]?.definition.fastpath).toEqual({
      keywords: ["old"],
    });
  });

  it("omits invalid candidate metadata instead of coercing it", () => {
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
## Guidelines
- Route carefully.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);
    expect(catalog.get()[0]?.definition.candidate).toBeUndefined();
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
          prompt: "Chat hint",
        },
      },
      {
        id: "MEMORY_RECENT",
        definition: {
          triggers: ["Recall recent context"],
          examples: [],
          domain: "memory",
          fastpath: { keywords: [] },
          prompt: "Memory hint",
        },
      },
      {
        id: "TYPO",
        definition: {
          triggers: ["Typing error"],
          examples: [],
          domain: "typing",
          fastpath: { keywords: [] },
          prompt: "Typo hint",
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
          prompt: "Chat hint",
        },
      },
    ];

    const result = filterIntentsForAgent(intents, resolveConfig({}), "main");
    expect(result).toEqual(intents);
    expect(result).not.toBe(intents);
  });
});
