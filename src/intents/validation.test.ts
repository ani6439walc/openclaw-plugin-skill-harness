import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateRoutingIntentDirectory } from "./routing-validation.js";
import { packageRoot } from "../file-utils.js";

describe("validateRoutingIntentDirectory", () => {
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
  keywords:
    - "hi"
---
Handle the test request.
`;

  it("accepts guidance-only intents and requested targets", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid());

    expect(validateRoutingIntentDirectory(dir, ["one"])).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects Markdown-formatted guidance bodies, including obsolete sections", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      `${valid().replace("Handle the test request.", "## Guidelines")}
- Do it.

## Concrete Workflow
- Step.

## Experience
- Tip.

## Skills & Tools
- skill-lifecycle
`,
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "one.md: guidance must not start with a Markdown list, heading, or fence",
    );
  });

  it("accepts non-empty skill dependencies only in frontmatter", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\nskills:\n  - skill-lifecycle\n  - skill-harness',
      ),
    );

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("accepts valid candidate metadata", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\ncandidate:\n  scope: cross-flow\n  keywords:\n    - "approval"\n    - "核准"',
      ),
    );

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects unknown or invalid candidate metadata", () => {
    fs.writeFileSync(
      path.join(dir, "bad-scope.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\ncandidate:\n  scope: global',
      ),
    );
    fs.writeFileSync(
      path.join(dir, "bad-keywords.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\ncandidate:\n  keywords:\n    - ""\n    - 123',
      ),
    );
    fs.writeFileSync(
      path.join(dir, "unknown-field.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\ncandidate:\n  scope: cross-flow\n  weight: 2',
      ),
    );
    fs.writeFileSync(
      path.join(dir, "not-object.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\ncandidate: cross-flow',
      ),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "bad-scope.md: candidate.scope must be cross-flow when provided",
    );
    expect(result.errors).toContain(
      "bad-keywords.md: candidate.keywords must be an array containing only non-empty strings",
    );
    expect(result.errors).toContain(
      "unknown-field.md: candidate contains unsupported field weight",
    );
    expect(result.errors).toContain(
      "not-object.md: candidate must be an object",
    );
  });

  it("rejects invalid skills metadata", () => {
    fs.writeFileSync(
      path.join(dir, "invalid-skills.md"),
      valid().replace(
        'domain: "test"',
        'domain: "test"\nskills: skill-lifecycle',
      ),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "invalid-skills.md: skills must be an array containing only non-empty strings",
    );
  });

  it("rejects unsupported top-level frontmatter fields", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      valid().replace(
        "triggers:",
        'id: one\nname: One\nenabled: true\nkeywords: ["hi"]\ntriggers:',
      ),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("one.md: unsupported top-level field id");
    expect(result.errors).toContain("one.md: unsupported top-level field name");
    expect(result.errors).toContain(
      "one.md: unsupported top-level field enabled",
    );
    expect(result.errors).toContain(
      "one.md: unsupported top-level field keywords",
    );
  });

  it("rejects unsupported fastpath hints and invalid fastpath fields", () => {
    fs.writeFileSync(
      path.join(dir, "one.md"),
      valid().replace(
        'fastpath:\n  keywords:\n    - "hi"',
        'fastpath:\n  hint: "Use a tiny direct hint."\n  keywords:\n    - ""\n    - 123\n  mode: direct',
      ),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("one.md: fastpath.hint is not supported");
    expect(result.errors).toContain(
      "one.md: fastpath.keywords must be an array containing only non-empty strings",
    );
    expect(result.errors).toContain(
      "one.md: fastpath contains unsupported field mode",
    );
  });

  it("rejects missing, non-string, or empty domain", () => {
    fs.writeFileSync(
      path.join(dir, "missing.md"),
      valid().replace('domain: "test"\n', ""),
    );
    fs.writeFileSync(
      path.join(dir, "invalid.md"),
      valid().replace('domain: "test"', "domain: 123"),
    );
    fs.writeFileSync(
      path.join(dir, "empty.md"),
      valid().replace('domain: "test"', 'domain: ""'),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "missing.md: domain must be a non-empty string",
    );
    expect(result.errors).toContain(
      "invalid.md: domain must be a non-empty string",
    );
    expect(result.errors).toContain(
      "empty.md: domain must be a non-empty string",
    );
  });

  it("rejects missing or invalid guidance", () => {
    fs.writeFileSync(
      path.join(dir, "missing.md"),
      valid().replace("Handle the test request.", ""),
    );
    fs.writeFileSync(
      path.join(dir, "lowercase.md"),
      valid().replace("Handle the test request.", "handle the test request."),
    );
    fs.writeFileSync(
      path.join(dir, "unterminated.md"),
      valid().replace("Handle the test request.", "Handle the test request"),
    );

    const result = validateRoutingIntentDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "missing.md: guidance must be a non-empty string",
    );
    expect(result.errors).toContain(
      "lowercase.md: guidance must start with an uppercase ASCII letter when it starts with an ASCII letter",
    );
    expect(result.errors).toContain(
      "unterminated.md: guidance must contain exactly one terminal delimiter and it must be the final code point",
    );
  });

  it("rejects duplicate filename IDs and missing requested targets", () => {
    fs.writeFileSync(path.join(dir, "one.md"), valid());
    fs.writeFileSync(path.join(dir, "ONE.md"), valid());

    const result = validateRoutingIntentDirectory(dir, ["MISSING"]);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate intent id one");
    expect(result.errors).toContain("target intent not found: MISSING");
  });

  it("accepts bundled skill asset examples", () => {
    const result = validateRoutingIntentDirectory(
      path.join(packageRoot, "skills", "skill-harness", "assets"),
    );

    expect(result).toMatchObject({
      valid: true,
      errors: [],
    });
  });
});
