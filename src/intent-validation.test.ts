import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateIntentDirectory } from "./intent-validation.js";

describe("validateIntentDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-validation-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const valid = (id: string) => `---
id: ${id}
name: ${id}
enabled: true
triggers:
  - "trigger"
examples:
  - "example"
---
Detected.

## Guidelines
- Do it.

## Skills & Tools
- Use tools.

## Response Strategy
- Respond.
`;

  it("accepts valid intents and requested targets", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid("ONE"));
    expect(validateIntentDirectory(dir, ["ONE"])).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects duplicate IDs, missing frontmatter, and section order", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid("ONE"));
    fs.writeFileSync(
      path.join(dir, "two.md"),
      valid("ONE")
        .replace("## Skills & Tools", "## Response Strategy")
        .replace("## Response Strategy\n- Respond.", "## Guidelines\n- Again."),
    );
    const result = validateIntentDirectory(dir, ["MISSING"]);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate intent id ONE");
    expect(result.errors.join("\n")).toContain(
      "duplicate ## Guidelines section",
    );
    expect(result.errors.join("\n")).toContain(
      "target intent not found: MISSING",
    );
  });
});
