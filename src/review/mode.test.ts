import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");
const referencePath = path.resolve("skills/skill-harness/references/review.md");
const keywordAuditReferencePath = path.resolve(
  "skills/skill-harness/references/keyword-audit.md",
);
const keywordAuditScriptPath = path.resolve(
  "skills/skill-harness/scripts/review-keyword-audit.py",
);
const keywordAuditLabelsTemplatePath = path.resolve(
  "skills/skill-harness/templates/review-keyword-labels.json",
);
const runtimeHealthReferencePath = path.resolve(
  "skills/skill-harness/references/runtime-health-audit.md",
);
const runtimeHealthScriptPath = path.resolve(
  "skills/skill-harness/scripts/runtime-health-audit.py",
);
const memoryLookupAssetPath = path.resolve(
  "skills/skill-harness/assets/memory-lookup.md",
);
const memoryCompareAssetPath = path.resolve(
  "skills/skill-harness/assets/memory-compare.md",
);
const routingOnlyReferencePaths = [
  skillPath,
  "skills/skill-harness/references/format.md",
  "skills/skill-harness/references/interview.md",
  "skills/skill-harness/references/design.md",
  "skills/skill-harness/references/extract.md",
  "skills/skill-harness/references/closing.md",
  "skills/skill-harness/references/inventory.md",
  "README.md",
].map((file) => path.resolve(file));

describe("skill-harness review mode", () => {
  it("keeps automated runtime work out of the human maintenance skill", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));
    const keywordAudit = fs.readFileSync(keywordAuditReferencePath, "utf-8");
    const runtimeHealth = fs.readFileSync(runtimeHealthReferencePath, "utf-8");
    const memoryLookup = fs.readFileSync(memoryLookupAssetPath, "utf-8");
    const memoryCompare = fs.readFileSync(memoryCompareAssetPath, "utf-8");

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining("runtime health"),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain(
      "Background subagents handle automated self-improvement",
    );
    expect(parsed.content).toContain("Do not manually repeat");
    expect(parsed.content).toContain("startup intent seeding");
    expect(parsed.content).toContain("skill-placement review");
    expect(parsed.content).toContain("stats aggregation");
    expect(parsed.content).not.toContain("### First-time setup assets");
    expect(parsed.content).not.toContain("copy example intent templates");
    expect(parsed.content).not.toContain("## Mode: evolve");
    expect(parsed.content).not.toContain("references/review.md");
    expect(parsed.content).not.toContain("Process a review finding");
    expect(fs.existsSync(referencePath)).toBe(false);
    expect(parsed.content).toContain("## Mode: keyword-audit");
    expect(parsed.content).toContain("references/keyword-audit.md");
    expect(parsed.content).toContain("scripts/review-keyword-audit.py");
    expect(parsed.content).toContain("templates/review-keyword-labels.json");
    expect(fs.existsSync(keywordAuditReferencePath)).toBe(true);
    expect(fs.existsSync(keywordAuditScriptPath)).toBe(true);
    expect(fs.existsSync(keywordAuditLabelsTemplatePath)).toBe(true);
    expect(keywordAudit).toContain("report and proposal only");
    expect(keywordAudit).toContain("approximate structural replay");
    expect(keywordAudit).toContain("does not snapshot or hash session files");
    expect(keywordAudit).not.toContain("## Step 6 — Apply");
    expect(parsed.content).toContain("## Mode: runtime-health");
    expect(parsed.content).toContain("references/runtime-health-audit.md");
    expect(parsed.content).toContain("scripts/runtime-health-audit.py");
    expect(fs.existsSync(runtimeHealthReferencePath)).toBe(true);
    expect(fs.existsSync(runtimeHealthScriptPath)).toBe(true);
    expect(runtimeHealth).toContain("report-only");
    expect(runtimeHealth).toContain("never writes runtime state");
    expect(runtimeHealth).toContain("Do not hand-edit");
    expect(runtimeHealth).toContain("ordinary Intent Review only");
    expect(memoryLookup).not.toContain("Ani");
    expect(memoryCompare).not.toContain("Discord style guide");
  });

  it("keeps intent-maintenance references routing-only", () => {
    const references = routingOnlyReferencePaths.map((reference) =>
      fs.readFileSync(reference, "utf-8"),
    );

    for (const reference of references) {
      expect(reference).toContain("guidance");
      expect(reference).not.toContain("fastpath.hint");
      expect(reference).not.toContain("## Guidelines");
      expect(reference).not.toContain("## Response Strategy");
      expect(reference).not.toContain("## Concrete Workflow");
      expect(reference).not.toContain("## Experience");
      expect(reference).not.toMatch(/Use `skill_view`/);
      expect(reference).not.toMatch(/runtime experience overlays?/i);
      expect(reference).not.toMatch(/skills or experiences/i);
      expect(reference).not.toContain("hint generation");
    }
  });
});
