import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateIntentDirectory } from "./intent-validation.js";
import { packageRoot } from "./file-utils.js";

describe("validateIntentDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-validation-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const valid = () => `---
triggers:
  - "trigger"
examples:
  - "example"
domain: "test"
keywords:
  - "hi"
---
## Guidelines
- Do it.

## Skills & Tools
- Use tools.

## Response Strategy
- Respond.
`;

  it("accepts valid intents and requested targets", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid());
    expect(validateIntentDirectory(dir, ["one"])).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("accepts optional Experience after Concrete Workflow", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `${valid()}
## Concrete Workflow
- Step.

## Experience
- Tip.
`,
    );

    expect(validateIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects duplicate Experience sections and bad section order", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `${valid()}
## Experience
- Tip.

## Concrete Workflow
- Step.

## Experience
- Duplicate.
`,
    );

    const result = validateIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "duplicate ## Experience section",
    );
    expect(result.errors.join("\n")).toContain(
      "standard sections are out of order",
    );
  });

  it("rejects stale frontmatter fields", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `---
id: ONE
name: One
enabled: true
triggers: ["trigger"]
examples: ["example"]
domain: "test"
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );

    const result = validateIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "one.md: stale frontmatter field id",
    );
    expect(result.errors.join("\n")).toContain(
      "one.md: stale frontmatter field name",
    );
    expect(result.errors.join("\n")).toContain(
      "one.md: stale frontmatter field enabled",
    );
  });

  it("rejects non-string or empty keywords", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `---
triggers: ["trigger"]
examples: ["example"]
domain: "test"
keywords:
  - "hi"
  - ""
  - 123
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );

    const result = validateIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "one.md: keywords must contain only non-empty strings",
    );
  });

  it("rejects missing, non-string, or empty domain", () => {
    fs.writeFileSync(
      path.join(dir, "missing.md"),
      `---
triggers: ["trigger"]
examples: ["example"]
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );
    fs.writeFileSync(
      path.join(dir, "invalid.md"),
      `---
triggers: ["trigger"]
examples: ["example"]
domain: 123
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );
    fs.writeFileSync(
      path.join(dir, "empty.md"),
      `---
triggers: ["trigger"]
examples: ["example"]
domain: ""
---
## Guidelines
- Do it.

## Response Strategy
- Respond.
`,
    );

    const result = validateIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "missing.md: domain must be a non-empty string",
    );
    expect(result.errors.join("\n")).toContain(
      "invalid.md: domain must be a non-empty string",
    );
    expect(result.errors.join("\n")).toContain(
      "empty.md: domain must be a non-empty string",
    );
  });

  it("rejects duplicate filename IDs, missing frontmatter, and section order", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid());
    fs.writeFileSync(
      path.join(dir, "ONE.md"),
      valid()
        .replace("## Skills & Tools", "## Response Strategy")
        .replace("## Response Strategy\n- Respond.", "## Guidelines\n- Again."),
    );
    const result = validateIntentDirectory(dir, ["MISSING"]);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate intent id one");
    expect(result.errors.join("\n")).toContain(
      "duplicate ## Guidelines section",
    );
    expect(result.errors.join("\n")).toContain(
      "target intent not found: MISSING",
    );
  });

  it("accepts bundled skill asset examples", () => {
    const result = validateIntentDirectory(
      path.join(packageRoot, "skills", "intention-hint", "assets"),
    );

    expect(result).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});
