import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntentCatalog } from "./intent-loader.js";

describe("IntentCatalog", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-loader-"));
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
        path.join(os.tmpdir(), "intent-loader-other-"),
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
fastpath:
  hint: "Route lightweight agent dispatch requests directly."
  keywords:
    - "spawn"
    - "派代理"
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
          fastpath: {
            keywords: ["spawn", "派代理"],
            hint: "Route lightweight agent dispatch requests directly.",
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
});
