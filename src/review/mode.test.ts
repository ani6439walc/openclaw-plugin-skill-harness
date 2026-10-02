import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");

const supportedReferenceNames = ["experience.md", "runtime-health-audit.md"];

describe("skill-harness user-triggered modes", () => {
  it("keeps initialization and on-demand modes separate from Review lifecycle work", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining("on demand"),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("## Mode: experience");
    expect(parsed.content).toContain("## Mode: runtime-health");
    expect(parsed.content).toContain("references/experience.md");
    expect(parsed.content).toContain("scripts/runtime-health-audit.py");
    expect(parsed.content).not.toMatch(/^## Mode: inventory/m);
    expect(parsed.content).not.toMatch(/^## Mode: design/m);
    expect(parsed.content).not.toMatch(/^## Mode: extract/m);
    expect(parsed.content).not.toContain("references/inventory.md");
  });

  it("keeps on-demand support resources and confirms zero assets", () => {
    expect(fs.existsSync(path.resolve("skills/skill-harness/assets"))).toBe(
      false,
    );
    expect(fs.readdirSync(path.dirname(skillPath)).sort()).toEqual([
      "SKILL.md",
      "references",
      "scripts",
    ]);
    expect(
      fs.readdirSync(path.resolve("skills/skill-harness/references")).sort(),
    ).toEqual(supportedReferenceNames);
    expect(
      fs
        .readdirSync(path.resolve("skills/skill-harness/scripts"))
        .filter((name) => name !== "__pycache__")
        .sort(),
    ).toEqual([
      "import-skill-relations.mjs",
      "runtime-health-audit.py",
      "test-runtime-health-audit.py",
      "test-validate-experiences.py",
      "validate-experiences.mjs",
    ]);
    expect(
      fs.existsSync(path.resolve("skills/skill-harness/references/extract.md")),
    ).toBe(false);
  });
});
