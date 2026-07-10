import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateIntentDirectory } from "./validation.js";
import { packageRoot } from "../file-utils.js";

describe("validateIntentDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-validator-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const valid = () => `---
triggers:
  - "trigger"
examples:
  - "example"
domain: "test"
fastpath:
  hint: "Use a tiny direct hint."
  keywords:
    - "hi"
---
## Guidelines
- Do it.

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

  it("accepts non-empty skill dependencies only in frontmatter", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\nskills:\n  - skill-lifecycle\n  - skill-harness',
      ),
    );

    expect(validateIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects legacy Skills & Tools sections and invalid skills metadata", () => {
    fs.writeFileSync(
      path.join(dir, "legacy.md"),
      `${valid()}\n## Skills & Tools\n- skill-lifecycle\n  - skill: skill-lifecycle\n`,
    );
    fs.writeFileSync(
      path.join(dir, "invalid-skills.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\nskills: skill-lifecycle',
      ),
    );

    const result = validateIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "legacy.md: legacy ## Skills & Tools section is not allowed; move skill dependencies to frontmatter skills",
    );
    expect(result.errors.join("\n")).toContain(
      "invalid-skills.md: skills must contain only non-empty strings",
    );
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
keywords: ["hi"]
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
    expect(result.errors.join("\n")).toContain(
      "one.md: stale frontmatter field keywords",
    );
  });

  it("rejects invalid fastpath metadata", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `---
triggers: ["trigger"]
examples: ["example"]
domain: "test"
fastpath:
  hint: ""
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
      "one.md: fastpath.keywords must contain only non-empty strings",
    );
    expect(result.errors.join("\n")).toContain(
      "one.md: fastpath.hint must be a non-empty string",
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
      valid().replace(
        "## Response Strategy\n- Respond.",
        "## Guidelines\n- Again.",
      ),
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
      path.join(packageRoot, "skills", "skill-harness", "assets"),
    );

    expect(result).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});
