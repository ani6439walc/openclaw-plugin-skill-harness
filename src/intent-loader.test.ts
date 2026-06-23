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
          keywords: ["spawn", "派代理"],
          prompt: "## Guidelines\n- Route by filename.",
        },
      },
    ]);
  });

  it("defaults missing keyword metadata to an empty list", () => {
    fs.writeFileSync(
      path.join(root, "intents", "chat.md"),
      `---
triggers:
  - "User chats casually"
examples:
  - "hi"
---
## Guidelines
- Reply naturally.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(1);

    expect(catalog.get()[0]?.definition.keywords).toEqual([]);
  });

  it("skips files without triggers", () => {
    fs.writeFileSync(
      path.join(root, "intents", "empty.md"),
      `---
examples:
  - "example"
---
## Guidelines
- Missing triggers.
`,
    );

    const catalog = IntentCatalog.create(root);
    expect(catalog.load("intents", { silent: true })).toBe(0);
    expect(catalog.get()).toEqual([]);
  });
});
