import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");
const bundledAssetPaths = [
  "approve.md",
  "reject.md",
  "chat.md",
  "typo.md",
  "memory-lookup.md",
  "memory-compare.md",
].map((file) => path.resolve("skills/skill-harness/assets", file));

const supportedReferenceNames = [
  "closing.md",
  "clustering.md",
  "design.md",
  "format.md",
  "interview.md",
  "inventory.md",
  "runtime-health-audit.md",
];

describe("skill-harness user-triggered modes", () => {
  it("keeps initialization and on-demand modes separate from Review lifecycle work", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining("on demand"),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("First-install initialization");
    expect(parsed.content).toContain("skills/skill-harness/assets/*.md");
    expect(parsed.content).toContain("## Mode: inventory");
    expect(parsed.content).toContain("## Mode: design");
    expect(parsed.content).toContain("## Mode: runtime-health");
    expect(parsed.content).toContain("references/inventory.md");
    expect(parsed.content).toContain("references/design.md");
    expect(parsed.content).toContain("scripts/runtime-health-audit.py");
    expect(parsed.content).toContain(
      "reviewer subagent owns evidence-backed intent complexity",
    );
    expect(parsed.content).toContain(
      "`create`, `refine`, `split`, `merge`, and guarded `delete`",
    );
    expect(parsed.content).not.toMatch(/^## Mode: extract/m);
    expect(parsed.content).not.toContain("references/extract.md");
  });

  it("keeps bundled assets and on-demand support resources", () => {
    for (const file of bundledAssetPaths) {
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(fs.readdirSync(path.dirname(skillPath)).sort()).toEqual([
      "SKILL.md",
      "assets",
      "references",
      "scripts",
    ]);
    expect(
      fs.readdirSync(path.resolve("skills/skill-harness/references")).sort(),
    ).toEqual(supportedReferenceNames);
    expect(
      fs.readdirSync(path.resolve("skills/skill-harness/scripts")).sort(),
    ).toEqual(["runtime-health-audit.py", "test-runtime-health-audit.py"]);
    expect(
      fs.existsSync(path.resolve("skills/skill-harness/references/extract.md")),
    ).toBe(false);
  });
});
